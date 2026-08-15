// HTTP wrapper around the corridor planner, speaking the frontend's contract.
//
//   POST /route  { start:[lat,lon], goal:[lat,lon], datetime, enemies:[[lat,lon],...] }
//   ->           { route:[[lat,lon],...], sun:{azimuth_deg,altitude_deg},
//                  exposure:{ bbox:[minLat,minLon,maxLat,maxLon], rows, cols, grid } }
//
// No dependencies — plain node:http, so it runs with `node server.js`.

import http from "node:http";
import { loadDemSync } from "./src/demNode.js";
import { computeCeiling } from "./src/viewshed.js";
import { loadObstacleHeightsSync } from "./src/obstaclesNode.js";
import { buildSurface } from "./src/obstacles.js";
import { solarPosition } from "./src/sun.js";
import { computeShadow } from "./src/shadow.js";
import { computeGradedGlare, weightedExposure } from "./src/glare.js";
import { findPath } from "./src/pathfind.js";
import { parseThreats } from "./src/threats.js";
import { lonLatToGrid, gridToLonLat, insideBounds, describeBounds } from "./src/coords.js";
import { computeSlope, computeTrafficable, resolveVehicles, VEHICLES } from "./src/vehicles.js";

// ---- one-time setup (heavy, done at boot) ----
const dem = loadDemSync();
const lat0 = (dem.latTop + dem.latBottom) / 2;
const lon0 = (dem.lonLeft + dem.lonRight) / 2;
const cellCount = dem.width * dem.height;
const obstacleHeight = loadObstacleHeightsSync(dem);
const surface = buildSurface(dem, obstacleHeight);
// A DEM-shaped object whose "elevation" is the surface (ground + buildings and
// trees), so the sun-shadow sweep casts shadows from buildings too, not just
// terrain. Everything a shadow falls behind - a ridge or a building - is cover.
const surfaceDem = { ...dem, elev: surface };
const slope = computeSlope(dem);
const EXPOSURE_PENALTY = 50;

// The platform is chosen per request. A quadcopter flies OVER buildings, so
// they only block a threat's sightline to it; a UGV must drive AROUND them, so
// they are impassable ground. The vehicle also sets the flight height, which
// changes how much the buildings hide it. Trafficability is recomputed per
// request because it differs completely between air and ground.
const DEFAULT_VEHICLE = "quadNap";
function resolveVehicle(id) {
  return VEHICLES[id] || VEHICLES[DEFAULT_VEHICLE];
}

function cell(lat, lon) {
  const c = lonLatToGrid(dem, lat, lon);
  return { x: Math.min(dem.width - 1, Math.max(0, Math.round(c.x))), y: Math.min(dem.height - 1, Math.max(0, Math.round(c.y))) };
}

function plan(body) {
  const [sLat, sLon] = body.start || [];
  const [gLat, gLon] = body.goal || [];
  if (![sLat, sLon, gLat, gLon].every(Number.isFinite)) return { error: "start and goal are required as [lat,lon]" };
  if (!insideBounds(dem, sLat, sLon) || !insideBounds(dem, gLat, gLon))
    return { error: "start or goal outside the map (" + describeBounds(dem) + ")" };

  const vehicle = resolveVehicle(body.vehicle);
  const AGL = vehicle.heightAboveGround;
  const passable = computeTrafficable(dem, vehicle, slope, obstacleHeight);

  const when = new Date(body.datetime || Date.now());
  const raw = (body.enemies || [])
    .filter((e) => Array.isArray(e) && insideBounds(dem, e[0], e[1]))
    // 5 km, not 20: detecting a small drone optically at 20 km is unreal, and
    // over Carpathian ridgelines a 20 km range let three threats see nearly the
    // whole map, so the "threat visibility" heat covered everything regardless
    // of where the threats sat. A realistic range keeps it local to each one.
    .map((e, i) => ({ label: "threat " + (i + 1), lat: e[0], lon: e[1],
      mastHeight: e[2] ?? 2, maxRangeKm: e[3] ?? 2.5 }));
  const threats = parseThreats(raw, dem);

  const sun = solarPosition(when, lat0, lon0);
  const shadowResult = computeShadow(surfaceDem, sun); // buildings cast shadows too

  const ceilings = threats.map((t) =>
    computeCeiling(dem, t, { observerHeight: t.mastHeight, maxRangeMetres: t.maxRangeMetres, surface }));
  const glares = threats.map((t) => computeGradedGlare(dem, t, sun));
  const exposure = weightedExposure(dem, ceilings, glares, AGL, { glareDiscount: 0.5 });

  // Darkness blinds the sensors. They see little below the horizon and
  // everything by full day; moving in the dark is the most basic concealment
  // there is, and it is what makes the time of day genuinely change the route.
  // The daylight factor runs from 0.12 in the dark (civil twilight begins near
  // -6 deg) to 1 once the sun is a comfortable 10 deg up.
  const daylight = Math.max(0.12, Math.min(1, (sun.elevation + 6) / 16));
  const effExposure = new Float32Array(cellCount);
  for (let i = 0; i < cellCount; i++) effExposure[i] = exposure[i] * daylight;

  const grids = { passable, exposure: effExposure, shadow: shadowResult.shadow, elev: dem.elev };
  const s = cell(sLat, sLon), g = cell(gLat, gLon);
  // direct = shortest passable route, ignoring who sees it; planned = concealed.
  // Comparing the two is how the tool shows what the concealment costs and buys.
  const direct = findPath(dem, s, g, grids, { vehicle, exposurePenalty: 0 });
  const planned = findPath(dem, s, g, grids,
    { vehicle, exposurePenalty: EXPOSURE_PENALTY, shadowDiscount: 0.65 });
  if (!planned.found) return { error: planned.reason || "no route found" };

  const toLL = (trace) => trace.map((i) => {
    const ll = gridToLonLat(dem, i % dem.width, Math.floor(i / dem.width));
    return [ll.lat, ll.lon];
  });
  const route = toLL(planned.trace);
  const directRoute = direct.found ? toLL(direct.trace) : route;
  const dSec = direct.found ? direct.exposedSeconds : planned.exposedSeconds;
  const pSec = planned.exposedSeconds;

  // downsample the exposure field into the overlay grid, normalised 0..1
  // Downsample the daylight-adjusted field into the overlay grid by AVERAGING
  // over every DEM cell each overlay cell covers - not by sampling one nearest
  // cell. Nearest-sampling a high-contrast viewshed aliases it into fake blind
  // spots: a threat standing in open ground would show a speckled disc full of
  // holes it does not actually have. The block average is the true fraction of
  // that patch the threat can see, so open ground reads solid and the holes
  // that remain are real terrain masking. The value is clamped to 1, so a cell
  // clearly seen by even one watcher is full-strength (red); partial cover at
  // the edge of a range or behind a ridge fades through orange to nothing.
  // The terrain-shadow field is averaged the same way, in the same pass, so the
  // map can show where the ground is in shade - concealment from optical
  // sensors, and the ground a shadow-seeking route prefers.
  // The overlay covers the VIEW area, not the whole 40 km DEM. An 80x80 grid
  // spread over 40 km is 500 m per cell - meaningless at a 1 km urban view. The
  // operator's area of interest (the mission points, padded) is downsampled
  // instead, so the grid resolves to a few metres locally and buildings and
  // their line-of-sight shadows actually show. The client may send an explicit
  // `view` bbox (its current map bounds); otherwise it is derived here.
  const shadowArr = shadowResult.shadow;
  let view = Array.isArray(body.view) && body.view.length === 4 ? body.view : null;
  if (!view) {
    const lats = [sLat, gLat], lons = [sLon, gLon];
    for (const e of body.enemies || []) { if (Array.isArray(e)) { lats.push(e[0]); lons.push(e[1]); } }
    const latPad = Math.max(0.004, (Math.max(...lats) - Math.min(...lats)) * 0.4);
    const lonPad = Math.max(0.006, (Math.max(...lons) - Math.min(...lons)) * 0.4);
    view = [Math.min(...lats) - latPad, Math.min(...lons) - lonPad,
            Math.max(...lats) + latPad, Math.max(...lons) + lonPad];
  }
  // Clamp the view to the DEM and convert its corners to grid cells.
  const vMinLat = Math.max(dem.latBottom, view[0]), vMinLon = Math.max(dem.lonLeft, view[1]);
  const vMaxLat = Math.min(dem.latTop, view[2]), vMaxLon = Math.min(dem.lonRight, view[3]);
  const topLeft = cell(vMaxLat, vMinLon), bottomRight = cell(vMinLat, vMaxLon);
  const vx0 = Math.min(topLeft.x, bottomRight.x), vx1 = Math.max(topLeft.x, bottomRight.x);
  const vy0 = Math.min(topLeft.y, bottomRight.y), vy1 = Math.max(topLeft.y, bottomRight.y);
  const vw = Math.max(1, vx1 - vx0), vh = Math.max(1, vy1 - vy0);

  // Buildings are averaged in the same pass so the map can show the footprints
  // the engine actually masks with - the ground truth for why a threat's line
  // of sight stops where it does in a built-up area.
  const oh = obstacleHeight;
  const rows = 80, cols = 80, grid = [], shadowGrid = [], buildingGrid = [];
  for (let r = 0; r < rows; r++) {
    grid[r] = []; shadowGrid[r] = []; buildingGrid[r] = [];
    const gy0 = vy0 + Math.floor((r / rows) * vh);
    const gy1 = Math.max(gy0 + 1, vy0 + Math.floor(((r + 1) / rows) * vh));
    for (let c = 0; c < cols; c++) {
      const gx0 = vx0 + Math.floor((c / cols) * vw);
      const gx1 = Math.max(gx0 + 1, vx0 + Math.floor(((c + 1) / cols) * vw));
      let sum = 0, sh = 0, bld = 0, n = 0;
      for (let gy = gy0; gy < gy1; gy++) {
        const rowBase = gy * dem.width;
        for (let gx = gx0; gx < gx1; gx++) {
          const idx = rowBase + gx;
          sum += effExposure[idx]; sh += shadowArr[idx];
          if (oh && oh[idx] > 0) bld += 1;
          n++;
        }
      }
      grid[r][c] = Math.min(1, sum / n);
      shadowGrid[r][c] = sh / n;
      buildingGrid[r][c] = bld / n;
    }
  }
  const bbox = [vMinLat, vMinLon, vMaxLat, vMaxLon];

  const contours = buildContours(vx0, vy0, vw, vh, bbox);

  return {
    route,
    direct: { route: directRoute, exposedSeconds: Math.round(dSec) },
    planned: { route, exposedSeconds: Math.round(pSec) },
    stats: {
      directSeconds: Math.round(dSec),
      plannedSeconds: Math.round(pSec),
      reductionPct: dSec > 0 ? Math.round((1 - pSec / dSec) * 100) : 0,
      detourPct: (direct.found && direct.metres > 0) ? Math.round((planned.metres / direct.metres - 1) * 100) : 0,
      vehicle: vehicle.label,
    },
    sun: { azimuth_deg: sun.azimuth, altitude_deg: sun.elevation, night: shadowResult.night === true },
    exposure: { bbox, rows, cols, grid },
    shadow: { bbox, rows, cols, grid: shadowGrid },
    buildings: { bbox, rows, cols, grid: buildingGrid },
    contours,
    vehicle: { id: vehicle.id, label: vehicle.label, airborne: vehicle.airborne === true, aglMetres: AGL },
  };
}

// Elevation contour lines over the view, by marching squares. Samples the DEM
// into a modest grid, then for each contour level emits the line segments where
// the terrain crosses it - the "lines" of a topographic map. Returned as
// [lat,lon] segment pairs grouped by level, for the client to stroke.
function buildContours(vx0, vy0, vw, vh, viewBbox) {
  const [minLat, minLon, maxLat, maxLon] = viewBbox;
  const gw = 90, gh = 90;
  const z = new Float32Array(gw * gh);
  let zmin = Infinity, zmax = -Infinity;
  for (let r = 0; r < gh; r++) {
    const gy = Math.min(dem.height - 1, vy0 + Math.round((r / (gh - 1)) * vh));
    for (let c = 0; c < gw; c++) {
      const gx = Math.min(dem.width - 1, vx0 + Math.round((c / (gw - 1)) * vw));
      const v = dem.elev[gy * dem.width + gx];
      z[r * gw + c] = v;
      if (v < zmin) zmin = v; if (v > zmax) zmax = v;
    }
  }
  // A sensible interval: aim for ~8-14 lines across the visible relief.
  const span = Math.max(1, zmax - zmin);
  const steps = [5, 10, 20, 25, 50, 100, 200];
  let interval = steps[steps.length - 1];
  for (const s of steps) { if (span / s <= 14) { interval = s; break; } }

  const gridLat = (r) => maxLat - (r / (gh - 1)) * (maxLat - minLat);
  const gridLon = (c) => minLon + (c / (gw - 1)) * (maxLon - minLon);
  const interp = (c1, v1, c2, v2, level) => c1 + (c2 - c1) * ((level - v1) / (v2 - v1));

  const segments = [];
  const first = Math.ceil(zmin / interval) * interval;
  for (let level = first; level < zmax; level += interval) {
    for (let r = 0; r < gh - 1; r++) {
      for (let c = 0; c < gw - 1; c++) {
        const tl = z[r * gw + c], tr = z[r * gw + c + 1];
        const bl = z[(r + 1) * gw + c], br = z[(r + 1) * gw + c + 1];
        const pts = [];
        // Crossings on the four cell edges.
        if ((tl < level) !== (tr < level)) pts.push([gridLat(r), gridLon(interp(c, tl, c + 1, tr, level))]);
        if ((tr < level) !== (br < level)) pts.push([gridLat(interp(r, tr, r + 1, br, level)), gridLon(c + 1)]);
        if ((br < level) !== (bl < level)) pts.push([gridLat(r + 1), gridLon(interp(c, bl, c + 1, br, level))]);
        if ((bl < level) !== (tl < level)) pts.push([gridLat(interp(r, tl, r + 1, bl, level)), gridLon(c)]);
        // Two crossings -> one segment; four (a saddle) -> two, paired in order.
        if (pts.length === 2) segments.push([pts[0], pts[1]]);
        else if (pts.length === 4) { segments.push([pts[0], pts[1]]); segments.push([pts[2], pts[3]]); }
      }
    }
  }
  return { interval, segments };
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "POST" && req.url === "/route") {
    let data = "";
    req.on("data", (d) => { data += d; });
    req.on("end", () => {
      try {
        const out = plan(JSON.parse(data || "{}"));
        res.writeHead(out.error ? 400 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
    return;
  }
  res.writeHead(404); res.end("not found");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("umbra route server → http://localhost:" + PORT + "/route");
  console.log("map bounds: " + describeBounds(dem) + "  (vehicle chosen per request)");
});
