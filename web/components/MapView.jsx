"use client";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import { CONFIG, fetchRoute } from "../lib/api";
import { loadMission, timeToHour } from "../lib/mission";

// Colour ramp for the threat-visibility field, tuned to read on a WHITE map.
// Nothing where the enemy cannot see (the pale map shows through), warming
// through yellow and orange to deep red where several sensors overlap. The
// alpha climbs with the value so a single distant watcher is a faint wash and
// a cluster is solid.
function exposureColour(v) {
  // Clean below a real threshold: faint single-sensor edges should not wash the
  // whole map yellow. Above it, a punchy amber-to-deep-red ramp with alpha that
  // climbs fast, so a genuinely overlooked cell reads as solid danger.
  if (v <= 0.12) return [0, 0, 0, 0];
  const stops = [
    [0.12, [255, 196, 60]],   // seen by one - amber
    [0.45, [255, 120, 30]],   // seen clearly - orange
    [1.0, [193, 18, 18]],     // heavily overlooked - deep red
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (v >= stops[i][0] && v <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const t = (v - lo[0]) / (hi[0] - lo[0] || 1);
  const rgb = [0, 1, 2].map((k) => Math.round(lo[1][k] + (hi[1][k] - lo[1][k]) * t));
  const alpha = Math.round(130 + Math.min(1, v) * 120); // 130..250
  return [rgb[0], rgb[1], rgb[2], alpha];
}

// Terrain shadow: a cool indigo wash where the ground is in shade. This is
// concealment from optical sensors and the ground a shadow-seeking route
// prefers, so it reads as the opposite of the warm threat-visibility heat.
function shadowColour(v) {
  if (v <= 0.2) return [0, 0, 0, 0];
  const a = Math.round(35 + Math.min(1, v) * 85); // 35..120, deliberately subtle
  return [56, 92, 178, a];
}

// Building footprints the engine masks with, drawn as solid slate so the
// operator can see why a threat's sightline stops where it does.
function buildingColour(v) {
  if (v <= 0.08) return [0, 0, 0, 0];
  return [70, 80, 96, Math.round(150 + Math.min(1, v) * 90)];
}

function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLon = (b[1] - a[1]) * toR;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Sample the normalised exposure grid at a lat/lon (nearest cell).
function sampleExposure(exp, lat, lon) {
  if (!exp) return 0;
  const [minLat, minLon, maxLat, maxLon] = exp.bbox;
  if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) return 0;
  const c = Math.round(((lon - minLon) / (maxLon - minLon)) * (exp.cols - 1));
  const r = Math.round(((maxLat - lat) / (maxLat - minLat)) * (exp.rows - 1));
  return exp.grid[r]?.[c] ?? 0;
}

// Pick an opening zoom that fits the mission, so the same UI works for a 400 m
// urban run and a 12 km valley corridor. fitBounds is unsafe here (container is
// zero-sized at mount), so derive the level from the span instead.
function zoomForSpan(pts) {
  const lats = pts.map((p) => p[0]), lons = pts.map((p) => p[1]);
  const dLat = Math.max(...lats) - Math.min(...lats);
  const dLon = (Math.max(...lons) - Math.min(...lons)) * 0.67; // lon shrinks at 48N
  const span = Math.max(dLat, dLon, 0.0008);                   // degrees
  const z = Math.log2(360 / span) - 0.9;                       // fit with margin
  return Math.max(9, Math.min(16, Math.round(z * 4) / 4));
}

export default function MapView() {
  const [vehicle, setVehicle] = useState("quadLow");
  const [mode, setMode] = useState("morning");
  const [hour, setHour] = useState(6.5);
  const [date, setDate] = useState(CONFIG.DEMO_DATE);
  const [sun, setSun] = useState(null);
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [stats, setStats] = useState(null);     // { km, exposedPct, threats }
  const [saving, setSaving] = useState(null);    // { reductionPct, directSeconds, plannedSeconds, detourPct }
  const [coords, setCoords] = useState(null);    // { start, goal }
  const [error, setError] = useState(null);

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const LRef = useRef(null);
  const startRef = useRef(null);
  const goalRef = useRef(null);
  const enemyRefs = useRef([]);
  const routeLayersRef = useRef([]);
  const exposureRef = useRef(null);
  const shadowRef = useRef(null);
  const buildingsRef = useRef(null);
  const contoursRef = useRef(null);
  const lastExposureRef = useRef(null);
  const computeRef = useRef(() => {});
  const debounceRef = useRef(null);

  function clearRoutes() {
    routeLayersRef.current.forEach((l) => mapRef.current.removeLayer(l));
    routeLayersRef.current = [];
  }
  function clearExposure() {
    if (exposureRef.current) { mapRef.current.removeLayer(exposureRef.current); exposureRef.current = null; }
  }
  function clearShadow() {
    if (shadowRef.current) { mapRef.current.removeLayer(shadowRef.current); shadowRef.current = null; }
  }
  function clearBuildings() {
    if (buildingsRef.current) { mapRef.current.removeLayer(buildingsRef.current); buildingsRef.current = null; }
  }

  // Smoothly upscale a coarse 0..1 grid to `scale`x resolution, returning the
  // interpolated values as a Float array. The browser's bilinear scaling does
  // the smoothing; going through greyscale keeps it fast.
  function upscaleValues(grid, rows, cols, scale) {
    const small = document.createElement("canvas");
    small.width = cols; small.height = rows;
    const sctx = small.getContext("2d");
    const simg = sctx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const g = Math.round(Math.max(0, Math.min(1, grid[r][c])) * 255);
      const i = (r * cols + c) * 4;
      simg.data[i] = g; simg.data[i + 1] = g; simg.data[i + 2] = g; simg.data[i + 3] = 255;
    }
    sctx.putImageData(simg, 0, 0);
    const w = cols * scale, h = rows * scale;
    const big = document.createElement("canvas");
    big.width = w; big.height = h;
    const bctx = big.getContext("2d");
    bctx.imageSmoothingEnabled = true; bctx.imageSmoothingQuality = "high";
    bctx.drawImage(small, 0, 0, w, h);
    const d = bctx.getImageData(0, 0, w, h).data;
    const out = new Float32Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
    return { values: out, w, h };
  }

  // One combined overlay. Where the ground is in shade it is drawn BLUE and the
  // threat-red is suppressed - shade conceals you from an optical watcher, so
  // that ground is cover you can travel through, not danger. Only lit ground
  // that a threat can see stays red. Blue therefore wins every overlap, which
  // is exactly the tactic: move through the shadows.
  function clearContours() {
    if (contoursRef.current) { mapRef.current.removeLayer(contoursRef.current); contoursRef.current = null; }
  }
  function drawContours(contours) {
    clearContours();
    if (!contours || !contours.segments || !contours.segments.length) return;
    const L = LRef.current;
    // One layer group of thin terrain lines, drawn under everything so they read
    // as a topographic backdrop, not as routes.
    const layer = L.layerGroup(
      contours.segments.map((seg) =>
        L.polyline(seg, { color: "#9a7b53", weight: 0.8, opacity: 0.5, interactive: false })));
    contoursRef.current = layer.addTo(mapRef.current);
    contoursRef.current.eachLayer((l) => l.bringToBack && l.bringToBack());
  }

  function drawBuildings(buildings) {
    clearBuildings();
    if (!buildings) return;
    const { rows, cols, bbox } = buildings;
    const up = upscaleValues(buildings.grid, rows, cols, 8);
    const cv = document.createElement("canvas");
    cv.width = up.w; cv.height = up.h;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(up.w, up.h);
    for (let i = 0; i < up.values.length; i++) {
      const [R, G, B, A] = buildingColour(up.values[i]);
      const p = i * 4;
      img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = A;
    }
    ctx.putImageData(img, 0, 0);
    buildingsRef.current = LRef.current.imageOverlay(cv.toDataURL(),
      [[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { opacity: 0.85, interactive: false }).addTo(mapRef.current);
    buildingsRef.current.bringToBack();
  }

  const SHADE_COVER = 0.4;
  function drawFields(exposure, shadow) {
    clearExposure(); clearShadow();
    lastExposureRef.current = exposure;
    const L = LRef.current;
    const { rows, cols, bbox } = exposure;
    const scale = 8;
    const ex = upscaleValues(exposure.grid, rows, cols, scale);
    const sh = shadow ? upscaleValues(shadow.grid, rows, cols, scale) : null;

    const cv = document.createElement("canvas");
    cv.width = ex.w; cv.height = ex.h;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(ex.w, ex.h);
    for (let i = 0; i < ex.values.length; i++) {
      const exVal = ex.values[i];
      const shade = sh ? sh.values[i] : 0;
      const seen = exVal > 0.12;
      const shaded = shade > SHADE_COVER;
      let R, G, B, A;
      if (seen && shaded) {
        // Threat can still see you in shadow, just less well: reduced
        // visibility, shown purple - neither fully exposed nor safe cover.
        R = 150; G = 58; B = 170;
        A = Math.round(95 + Math.min(1, exVal) * 85);
      } else if (seen) {
        [R, G, B, A] = exposureColour(exVal); // full visibility - red
      } else if (shaded) {
        R = 56; G = 92; B = 178;             // cover, no threat sightline - blue
        A = Math.round(55 + Math.min(1, shade) * 95);
      } else {
        R = G = B = A = 0;
      }
      const p = i * 4;
      img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = A;
    }
    ctx.putImageData(img, 0, 0);
    const bounds = [[bbox[0], bbox[1]], [bbox[2], bbox[3]]];
    // Translucent, so the real building footprints on the basemap read through
    // the analysis tint - map first, analysis on top, like a weather radar.
    exposureRef.current = L.imageOverlay(cv.toDataURL(), bounds, { opacity: 0.55, interactive: false }).addTo(mapRef.current);
  }
  function drawRoute(route, cls, dashed) {
    const L = LRef.current, map = mapRef.current;
    // The direct (shortest) route is a thin red dashed line, drawn under the
    // planned route so the detour the concealment costs is visible.
    if (dashed) {
      routeLayersRef.current.push(
        L.polyline(route, { color: "#e0322a", weight: 2.5, opacity: 0.85, dashArray: "5 8" }).addTo(map));
      return;
    }
    const color = cls === "route-blue" ? "#3b9bff" : "#ffb020";
    // A dark halo under a bright core, so the path reads over both the pale map
    // and the orange threat-visibility heat. A white casing vanished on white.
    routeLayersRef.current.push(
      L.polyline(route, { color: "#0e1420", weight: 7.5, opacity: 0.7 }).addTo(map));
    const line = L.polyline(route, { color, weight: 3.5, opacity: 1, className: `route-line ${cls}` }).addTo(map);
    routeLayersRef.current.push(line);
    line.bringToFront();
  }

  function computeStats(route, exposure, shadow) {
    if (!route || route.length < 2) return null;
    let km = 0, exposedM = 0;
    for (let i = 1; i < route.length; i++) {
      const seg = haversine(route[i - 1], route[i]);
      km += seg;
      const mid = [(route[i - 1][0] + route[i][0]) / 2, (route[i - 1][1] + route[i][1]) / 2];
      // Exposed only where a threat can see you AND you are not in shade -
      // shadow conceals you, so shaded ground does not count against the route.
      const seen = sampleExposure(exposure, mid[0], mid[1]) > 0.12;
      const shaded = sampleExposure(shadow, mid[0], mid[1]) > SHADE_COVER;
      if (seen && !shaded) exposedM += seg;
    }
    return {
      km: km / 1000,
      exposedPct: km > 0 ? Math.round((exposedM / km) * 100) : 0,
      threats: enemyRefs.current.length,
    };
  }

  async function compute() {
    if (!mapRef.current) return;
    setPlanning(true);
    setError(null);
    clearRoutes();
    const b = mapRef.current.getBounds();
    const body = {
      start: [startRef.current.getLatLng().lat, startRef.current.getLatLng().lng],
      goal: [goalRef.current.getLatLng().lat, goalRef.current.getLatLng().lng],
      enemies: enemyRefs.current.map((m) => [m.getLatLng().lat, m.getLatLng().lng]),
      // The current map view, so the exposure/shadow overlay is computed at high
      // resolution over exactly what is on screen rather than the whole 40 km DEM.
      view: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()],
      vehicle,
    };
    setCoords({ start: body.start, goal: body.goal });
    try {
      if (mode === "compare") {
        clearExposure(); clearShadow(); clearBuildings(); clearContours(); lastExposureRef.current = null;
        const am = await fetchRoute({ ...body, datetime: CONFIG.buildDatetime(date, 7.5) }, 7.5);
        const pm = await fetchRoute({ ...body, datetime: CONFIG.buildDatetime(date, 18.5) }, 18.5);
        setLive(am.live);
        if (am.error || pm.error) { setError(am.error || pm.error); setStats(null); return; }
        drawRoute(am.route, "route-amber");
        drawRoute(pm.route, "route-blue");
        setSun(null);
        setStats(computeStats(am.route, null));
        setSaving(null);
      } else {
        const data = await fetchRoute({ ...body, datetime: CONFIG.buildDatetime(date, hour) }, hour);
        setLive(data.live);
        if (data.error) { setError(data.error); clearExposure(); clearShadow(); clearBuildings(); clearContours(); setStats(null); setSaving(null); setSun(null); return; }
        // No raster building overlay: the Voyager basemap already draws the real
        // OSM building footprints crisply, like Google Maps, and the raster
        // blob only hid them. The engine still masks with them underneath.
        drawContours(data.contours);
        drawFields(data.exposure, data.shadow);
        // Direct (shortest) route as a red dashed line under the planned one, so
        // the detour the concealment costs is visible - Tom's comparison view.
        if (data.direct?.route) drawRoute(data.direct.route, "route-direct", true);
        drawRoute((data.planned && data.planned.route) || data.route, mode === "morning" ? "route-amber" : "route-blue");
        setSun(data.sun);
        setStats(computeStats(data.route, data.exposure, data.shadow));
        setSaving(data.stats || null);
      }
    } catch (e) {
      setError("could not reach the routing engine");
    } finally {
      setPlanning(false);
    }
  }
  computeRef.current = compute;

  function replanNow() { setShowHint(false); computeRef.current(); }

  function makeEnemy(pos) {
    const L = LRef.current, map = mapRef.current;
    pos = [pos[0], pos[1]];   // presets may carry [lat, lon, mastM, rangeKm]
    const icon = L.divIcon({ className: "pin", html: `<div class="pin-enemy"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
    const m = L.marker(pos, { draggable: true, icon })
      .addTo(map).bindTooltip("Threat · click to remove", { direction: "top", className: "tt" });
    m.on("dragend", replanNow);
    m.on("click", () => {
      enemyRefs.current = enemyRefs.current.filter((x) => x !== m);
      map.removeLayer(m);
      replanNow();
    });
    return m;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (mapRef.current) return;
      const L = (await import("leaflet")).default;
      if (cancelled) return;
      LRef.current = L;
      const mission = loadMission();
      // Centre on the mission and open at a drone/UGV-scale zoom - a few km
      // across, not the whole 40 km DEM. A fixed zoom is used rather than
      // fitBounds because fitBounds derives its level from the container size,
      // which is still zero at mount and collapses to a world view.
      const opsPts = [mission.start, mission.goal, ...mission.enemies];
      const cLat = opsPts.reduce((s, p) => s + p[0], 0) / opsPts.length;
      const cLon = opsPts.reduce((s, p) => s + p[1], 0) / opsPts.length;
      const map = L.map(containerRef.current, {
        zoomControl: false, scrollWheelZoom: true,
        zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 140, wheelDebounceTime: 40, inertia: true,
      }).setView([cLat, cLon], zoomForSpan(opsPts));
      mapRef.current = map;
      L.control.zoom({ position: "bottomright" }).addTo(map);
      // Light basemap: the threat-visibility heat and the route must read at a
      // glance, and they cannot over a dark tile.
      // Voyager: a light basemap that still shows roads, rivers and relief, so
      // the planner has real geographic context under the threat heat.
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
        { maxZoom: 20, subdomains: "abcd", attribution: "© OpenStreetMap © CARTO" }).addTo(map);
      // The operating area the engine actually covers, drawn once so the planner
      // sees the edge of the map they can place inside of.
      const b = CONFIG.BBOX;
      L.rectangle([[b[0], b[1]], [b[2], b[3]]],
        { color: "#3a4759", weight: 1.5, dashArray: "6 5", fill: false, interactive: false }).addTo(map);

      const dot = (kind) => L.divIcon({
        className: "pin", html: `<div class="pin-dot pin-${kind}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
      const tt = () => ({ permanent: true, direction: "right", offset: [11, 0], className: "tt" });

      startRef.current = L.marker(mission.start, { draggable: true, icon: dot("start") })
        .addTo(map).bindTooltip("Launch", tt());
      goalRef.current = L.marker(mission.goal, { draggable: true, icon: dot("goal") })
        .addTo(map).bindTooltip("Objective", tt());
      startRef.current.on("dragend", replanNow);
      goalRef.current.on("dragend", replanNow);

      enemyRefs.current = mission.enemies.map((pos) => makeEnemy(pos));

      // A settle-only invalidateSize so tiles lay out correctly after mount. No
      // fitBounds: under React StrictMode the effect mounts twice, and a
      // fitBounds on the second, mid-remount container collapses to a world
      // view. The fixed setView zoom above is deterministic and safe.
      setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 200);

      // Click empty map to drop a new threat.
      map.on("click", (e) => {
        enemyRefs.current.push(makeEnemy([e.latlng.lat, e.latlng.lng]));
        replanNow();
      });

      // Re-plan when the view changes, so the overlay is always computed at
      // full resolution over exactly what is on screen.
      let moveTimer = null;
      map.on("moveend", () => {
        clearTimeout(moveTimer);
        moveTimer = setTimeout(() => { if (mapRef.current) computeRef.current(); }, 350);
      });

      const h0 = timeToHour(mission.time);
      setDate(mission.date); setHour(h0);
      setMode(h0 < 13 ? "morning" : "evening");
      setCoords({ start: mission.start, goal: mission.goal });
      setReady(true);
    })();
    return () => { cancelled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, []);

  useEffect(() => {
    if (!ready) return;
    setPlanning(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => computeRef.current(), 400);
    return () => clearTimeout(debounceRef.current);
  }, [mode, hour, date, vehicle, ready]);

  useEffect(() => { const t = setTimeout(() => setShowHint(false), 9000); return () => clearTimeout(t); }, []);
  useEffect(() => { document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = ""; }; }, []);

  function pickMode(m) {
    if (m === "morning") setHour(7.5);
    else if (m === "evening") setHour(18.5);
    setMode(m);
  }

  const hh = Math.floor(hour), mm = Math.round((hour - hh) * 60);
  const hourLabel = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const az = sun ? sun.azimuth_deg : null;
  const isNight = sun ? sun.altitude_deg <= 0 : false;
  const fmt = (c) => c ? `${c[0].toFixed(4)}, ${c[1].toFixed(4)}` : "—";

  return (
    <div>
      <div ref={containerRef} id="map-root" />
      <a className="editlink" href="/">↤ Edit mission</a>

      <div className={`console${planning ? " busy" : ""}`}>
        <header>
          <span className="logo">Umbra</span>
          <span className="busytag">planning…</span>
          <span className="tagline">Concealed Ingress · Carpathians</span>
        </header>

        {stats && (
          <div className="stats">
            <div><b>{stats.km.toFixed(1)}</b><span>km route</span></div>
            <div><b className={stats.exposedPct > 25 ? "warn" : "good"}>{stats.exposedPct}%</b><span>exposed</span></div>
            <div><b>{stats.threats}</b><span>threats</span></div>
          </div>
        )}
        {error && <div className="errbar">⚠ {error}</div>}

        {saving && (
          <div className="saving">
            <div className="savingnum">−{saving.reductionPct}%</div>
            <div className="savinglabel">time exposed · {saving.directSeconds}s → {saving.plannedSeconds}s<br />+{saving.detourPct}% distance</div>
          </div>
        )}

        <div>
          <span className="glabel">Platform</span>
          <div className="seg">
            <button data-on={vehicle === "quadLow"} onClick={() => setVehicle("quadLow")}>Quad · low</button>
            <button data-on={vehicle === "quadFpv"} onClick={() => setVehicle("quadFpv")}>Quad · FPV</button>
            <button data-on={vehicle === "ugvTracked"} onClick={() => setVehicle("ugvTracked")}>UGV</button>
          </div>
        </div>

        <div>
          <span className="glabel">Sun window</span>
          <div className="seg">
            <button data-on={mode === "morning"} onClick={() => pickMode("morning")}>Morning</button>
            <button data-on={mode === "evening"} onClick={() => pickMode("evening")}>Evening</button>
            <button data-on={mode === "compare"} onClick={() => pickMode("compare")}>Compare</button>
          </div>
        </div>

        <div>
          <div className="field">
            <span className="glabel">Date · season</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field">
            <span className="glabel">Time of day <b>{hourLabel}</b></span>
            <input type="range" min="5" max="19" step="0.5" value={hour}
              disabled={mode === "compare"} onChange={(e) => setHour(parseFloat(e.target.value))} />
          </div>
        </div>

        <div className="sunrow">
          <div className="dial">
            <span className="card n">N</span><span className="card s">S</span>
            <div className={`dial-arm${isNight || az == null ? " night" : ""}`} style={{ transform: `rotate(${az ?? 90}deg)` }}>
              <div className="sun" />
            </div>
          </div>
          <div className="sunvals">
            <div><b>{az != null ? az.toFixed(0) + "°" : "—"}</b><span>azimuth</span></div>
            <div><b>{sun ? sun.altitude_deg.toFixed(0) + "°" : "—"}</b><span>altitude</span></div>
          </div>
        </div>

        <div className="coordbox">
          <div><span className="ck ck-a" />Launch <em>{fmt(coords?.start)}</em></div>
          <div><span className="ck ck-b" />Objective <em>{fmt(coords?.goal)}</em></div>
        </div>

        <div className="legend">
          <span className="glabel">Threat visibility</span>
          <div className="heatbar"><span>hidden</span><i /><span>seen</span></div>
          <div className="row"><span className="sw line dash" />Direct — shortest</div>
          <div className="row"><span className="sw line" style={{ background: "#ffb020" }} />Planned — concealed</div>
          <div className="row"><span className="sw" style={{ background: "rgba(150,58,170,.8)" }} />Reduced visibility (in shadow)</div>
          <div className="row"><span className="sw" style={{ background: "rgba(56,92,178,.7)" }} />Shadow cover (terrain + buildings)</div>
          <div className="row"><span className="sw line" style={{ background: "#ffb020" }} />Morning approach</div>
          <div className="row"><span className="sw line" style={{ background: "#3b9bff" }} />Evening approach</div>
        </div>

        <div className="status">
          {live ? <span className="live">● LIVE — routing engine</span> : "● mock — start the route server for live routing"}
        </div>
      </div>

      <div className={`hint${showHint ? "" : " hide"}`}>
        <span>Drag <b>launch</b> / <b>objective</b> · click the map to <b>add a threat</b> · click a threat to remove</span>
        <button className="x" onClick={() => setShowHint(false)} aria-label="Dismiss">×</button>
      </div>
    </div>
  );
}
