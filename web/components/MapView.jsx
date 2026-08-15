"use client";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import { CONFIG, fetchRoute } from "../lib/api";
import { loadMission, timeToHour } from "../lib/mission";

function tintStyle(hour) {
  let c, o;
  if (hour < 5 || hour >= 21) { c = "18,32,84"; o = 0.55; }
  else if (hour < 8)  { c = "255,150,70";  o = 0.42; }
  else if (hour < 16) { c = "255,255,255"; o = 0.06; }
  else if (hour < 19) { c = "255,120,55";  o = 0.42; }
  else                { c = "110,80,170";  o = 0.45; }
  return { background: `linear-gradient(to top, rgba(${c},${o}), rgba(${c},${o * 0.35}) 45%, transparent 80%)` };
}

export default function MapView() {
  const [mode, setMode] = useState("morning");
  const [hour, setHour] = useState(6.5);
  const [date, setDate] = useState(CONFIG.DEMO_DATE);
  const [sun, setSun] = useState(null);
  const [live, setLive] = useState(false);
  const [ready, setReady] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [showHint, setShowHint] = useState(true);
  const [stats, setStats] = useState(null);

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const LRef = useRef(null);
  const startRef = useRef(null);
  const goalRef = useRef(null);
  const enemyRefs = useRef([]);
  const routeLayersRef = useRef([]);
  const exposureRef = useRef(null);
  const computeRef = useRef(() => {});
  const debounceRef = useRef(null);

  function clearRoutes() {
    const map = mapRef.current;
    routeLayersRef.current.forEach((l) => map.removeLayer(l));
    routeLayersRef.current = [];
  }
  function clearExposure() {
    const map = mapRef.current;
    if (exposureRef.current) { map.removeLayer(exposureRef.current); exposureRef.current = null; }
  }
  function drawRoute(route, cls, dashed) {
    const L = LRef.current, map = mapRef.current;
    const color = cls === "route-amber" ? "#f5a623" : cls === "route-direct" ? "#ff5c5c" : "#4aa3ff";
    const opts = dashed
      ? { color, weight: 3, opacity: 0.6, dashArray: "5 9" }
      : { color, weight: 4, opacity: 0.95, className: `route-line ${cls}` };
    routeLayersRef.current.push(L.polyline(route, opts).addTo(map));
  }
  function drawExposure(exposure) {
    const L = LRef.current, map = mapRef.current;
    clearExposure();
    const { rows, cols, grid, bbox } = exposure;
    const cv = document.createElement("canvas");
    cv.width = cols; cv.height = rows;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const v = grid[r][c], i = (r * cols + c) * 4;
      img.data[i] = 235; img.data[i + 1] = 65; img.data[i + 2] = 55;
      img.data[i + 3] = Math.round(v * 115);
    }
    ctx.putImageData(img, 0, 0);
    const bounds = [[bbox[0], bbox[1]], [bbox[2], bbox[3]]];
    exposureRef.current = L.imageOverlay(cv.toDataURL(), bounds,
      { opacity: 0.8, className: "exposure-layer" }).addTo(map);
  }

  async function compute() {
    if (!mapRef.current) return;
    setPlanning(true);
    clearRoutes();
    const body = {
      start: [startRef.current.getLatLng().lat, startRef.current.getLatLng().lng],
      goal: [goalRef.current.getLatLng().lat, goalRef.current.getLatLng().lng],
      enemies: enemyRefs.current.map((m) => [m.getLatLng().lat, m.getLatLng().lng]),
    };
    try {
      if (mode === "compare") {
        clearExposure();
        const am = await fetchRoute({ ...body, datetime: CONFIG.buildDatetime(date, 7.5) }, 7.5);
        const pm = await fetchRoute({ ...body, datetime: CONFIG.buildDatetime(date, 18.5) }, 18.5);
        setLive(am.live);
        drawRoute(am.route, "route-amber");
        drawRoute(pm.route, "route-blue");
        setStats(null);
        setSun(null);
      } else {
        const data = await fetchRoute({ ...body, datetime: CONFIG.buildDatetime(date, hour) }, hour);
        setLive(data.live);
        drawExposure(data.exposure);
        if (data.direct?.route) drawRoute(data.direct.route, "route-direct", true);
        drawRoute((data.planned && data.planned.route) || data.route, "route-amber");
        setStats(data.stats || null);
        setSun(data.sun);
      }
    } finally {
      setPlanning(false);
    }
  }
  computeRef.current = compute;

  function replanNow() {
    setShowHint(false);
    computeRef.current();
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (mapRef.current) return;
      const L = (await import("leaflet")).default;
      if (cancelled) return;
      LRef.current = L;
      const mission = loadMission();
      const map = L.map(containerRef.current, {
        zoomControl: false,
        scrollWheelZoom: true,
        zoomSnap: 0.25, zoomDelta: 0.5,
        wheelPxPerZoomLevel: 140, wheelDebounceTime: 40,
        inertia: true,
      }).setView(mission.center, 11);
      mapRef.current = map;
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        { maxZoom: 20, subdomains: "abcd", attribution: "© OpenStreetMap © CARTO" }).addTo(map);

      const dot = (kind) => L.divIcon({
        className: "pin", html: `<div class="pin-dot pin-${kind}"></div>`,
        iconSize: [15, 15], iconAnchor: [7, 7],
      });
      const enemyIcon = L.divIcon({
        className: "pin", html: `<div class="pin-enemy"></div>`,
        iconSize: [14, 14], iconAnchor: [7, 7],
      });
      const tt = () => ({ permanent: true, direction: "right", offset: [10, 0], className: "tt" });

      startRef.current = L.marker(mission.start, { draggable: true, icon: dot("start") })
        .addTo(map).bindTooltip("Launch", tt());
      goalRef.current = L.marker(mission.goal, { draggable: true, icon: dot("goal") })
        .addTo(map).bindTooltip("Objective", tt());
      startRef.current.on("dragend", replanNow);
      goalRef.current.on("dragend", replanNow);

      enemyRefs.current = mission.enemies.map((pos) => {
        const m = L.marker(pos, { draggable: true, icon: enemyIcon })
          .addTo(map).bindTooltip("Threat", { direction: "top", className: "tt" });
        m.on("dragend", replanNow);
        return m;
      });

      const h0 = timeToHour(mission.time);
      setDate(mission.date);
      setHour(h0);
      setMode(h0 < 13 ? "morning" : "evening");
      setReady(true);
    })();
    return () => { cancelled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, []);

  // debounced re-plan on control changes (smooth scrubbing)
  useEffect(() => {
    if (!ready) return;
    setPlanning(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => computeRef.current(), 400);
    return () => clearTimeout(debounceRef.current);
  }, [mode, hour, date, ready]);

  // auto-dismiss hint
  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), 8000);
    return () => clearTimeout(t);
  }, []);

  // lock page scroll while the full-screen map is mounted
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  function pickMode(m) {
    if (m === "morning") setHour(7.5);
    else if (m === "evening") setHour(18.5);
    setMode(m);
  }

  const hh = Math.floor(hour), mm = Math.round((hour - hh) * 60);
  const hourLabel = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const az = sun ? sun.azimuth_deg : null;
  const isNight = sun ? sun.altitude_deg <= 0 : false;

  return (
    <div>
      <div ref={containerRef} id="map-root" />
      <div id="tint" style={tintStyle(hour)} />
      <a className="editlink" href="/">↤ Edit mission</a>

      <div className={`console${planning ? " busy" : ""}`}>
        <header>
          <span className="logo">Umbra</span>
          <span className="busytag">planning…</span>
          <span className="tagline">Concealed Ingress · Carpathians</span>
        </header>

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
            <input type="range" min="4" max="21" step="0.5" value={hour}
              disabled={mode === "compare"}
              onChange={(e) => setHour(parseFloat(e.target.value))} />
          </div>
        </div>

        <div className="sunrow">
          <div className="dial">
            <span className="card n">N</span><span className="card s">S</span>
            <div className={`dial-arm${isNight || az == null ? " night" : ""}`}
              style={{ transform: `rotate(${az ?? 90}deg)` }}>
              <div className="sun" />
            </div>
          </div>
          <div className="sunvals">
            <div><b>{az != null ? az.toFixed(0) + "°" : "—"}</b><span>azimuth</span></div>
            <div><b>{sun ? sun.altitude_deg.toFixed(0) + "°" : "—"}</b><span>altitude</span></div>
          </div>
        </div>

        {stats && (
          <div className="saving">
            <div className="savingnum">−{stats.reductionPct}%</div>
            <div className="savinglabel">time exposed · {stats.directSeconds}s → {stats.plannedSeconds}s<br />+{stats.detourPct}% distance</div>
          </div>
        )}

        <div className="legend">
          <div className="row"><span className="sw line dash" />Direct — shortest</div>
          <div className="row"><span className="sw line" style={{ background: "#f5a623" }} />Planned — concealed</div>
          <div className="row"><span className="sw" style={{ background: "rgba(255,60,45,.6)" }} />Exposed to threats</div>
        </div>

        <div className="status">
          {live ? <span className="live">● LIVE — routing engine</span> : "● mock — start Ben's server for live routing"}
        </div>
      </div>

      <div className={`hint${showHint ? "" : " hide"}`}>
        <span>Drag <b>launch</b>, <b>objective</b> or <b>threats</b> to re-plan · scroll to zoom</span>
        <button className="x" onClick={() => setShowHint(false)} aria-label="Dismiss">×</button>
      </div>
    </div>
  );
}
