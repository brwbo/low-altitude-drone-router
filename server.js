// HTTP wrapper around the corridor planner, speaking the frontend's contract.
//
//   POST /route  { start:[lat,lon], goal:[lat,lon], datetime, enemies:[[lat,lon],...] }
//   ->           { route:[[lat,lon],...], sun:{azimuth_deg,altitude_deg},
//                  exposure:{ bbox:[minLat,minLon,maxLat,maxLon], rows, cols, grid } }
//
// No dependencies — plain node:http, so it runs with `node server.js`.

import http from "node:http";
import { loadDemSync } from "./src/demNode.js";
import { computeCeiling, exposureCount } from "./src/viewshed.js";
import { loadObstacleHeightsSync } from "./src/obstaclesNode.js";
import { buildSurface } from "./src/obstacles.js";
import { solarPosition } from "./src/sun.js";
import { computeShadow } from "./src/shadow.js";
import { computeGradedGlare, weightedExposure, isOptical } from "./src/glare.js";
import { findPath } from "./src/pathfind.js";
import { parseThreats } from "./src/threats.js";
import { lonLatToGrid, gridToLonLat, insideBounds, describeBounds } from "./src/coords.js";
import { computeSlope, computeTrafficable, resolveVehicles } from "./src/vehicles.js";

// ---- one-time setup (heavy, done at boot) ----
const dem = loadDemSync();
const lat0 = (dem.latTop + dem.latBottom) / 2;
const lon0 = (dem.lonLeft + dem.lonRight) / 2;
const cellCount = dem.width * dem.height;
const obstacleHeight = loadObstacleHeightsSync(dem);
const surface = buildSurface(dem, obstacleHeight);
const slope = computeSlope(dem);
const vehicle = resolveVehicles("quadLow").vehicles[0];     // low-cruise quad (endurance-feasible)
const passable = computeTrafficable(dem, vehicle, slope, obstacleHeight);
const EXPOSURE_PENALTY = 50;
const AGL = vehicle.heightAboveGround;

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

  const when = new Date(body.datetime || Date.now());
  const raw = (body.enemies || [])
    .filter((e) => Array.isArray(e) && insideBounds(dem, e[0], e[1]))
    .map((e, i) => ({ label: "threat " + (i + 1), type: "optical", lat: e[0], lon: e[1], mastHeight: 10, maxRangeKm: 20 }));
  const threats = parseThreats(raw, dem);

  const sun = solarPosition(when, lat0, lon0);
  const shadowResult = computeShadow(dem, sun);

  const ceilings = [], opticalCeilings = [];
  for (const t of threats) {
    const c = computeCeiling(dem, t, { observerHeight: t.mastHeight, maxRangeMetres: t.maxRangeMetres, surface });
    ceilings.push(c);
    if (isOptical(t)) opticalCeilings.push(c);
  }
  const glares = threats.map((t) => computeGradedGlare(dem, t, sun));
  const exposure = weightedExposure(dem, ceilings, glares, AGL, { glareDiscount: 0.5 });

  const opticalShare = new Float32Array(cellCount);
  if (threats.length) {
    const all = exposureCount(dem, ceilings, AGL);
    const opt = exposureCount(dem, opticalCeilings, AGL);
    for (let i = 0; i < cellCount; i++) opticalShare[i] = all[i] > 0 ? opt[i] / all[i] : 0;
  }

  const grids = { passable, exposure, opticalShare, shadow: shadowResult.shadow, elev: dem.elev };
  const s = cell(sLat, sLon), g = cell(gLat, gLon);
  // direct = shortest passable route (ignores who sees it); planned = concealed.
  const direct = findPath(dem, s, g, grids, { vehicle, exposurePenalty: 0 });
  const planned = findPath(dem, s, g, grids, { vehicle, exposurePenalty: EXPOSURE_PENALTY, shadowDiscount: 0.35 });
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
  const rows = 80, cols = 80, grid = [];
  let max = 0;
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) {
      const gx = Math.round((c / (cols - 1)) * (dem.width - 1));
      const gy = Math.round((r / (rows - 1)) * (dem.height - 1));
      const v = exposure[gy * dem.width + gx] || 0;
      grid[r][c] = v; if (v > max) max = v;
    }
  }
  if (max > 0) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) grid[r][c] = grid[r][c] / max;

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
    sun: { azimuth_deg: sun.azimuth, altitude_deg: sun.elevation },
    exposure: { bbox: [dem.latBottom, dem.lonLeft, dem.latTop, dem.lonRight], rows, cols, grid },
  };
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
  console.log("map bounds: " + describeBounds(dem) + "  (planning for " + vehicle.label + ")");
});
