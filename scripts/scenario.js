// The corridor planner, end to end.
//
// Usage:  node scripts/scenario.js [mission file] [ISO timestamp]
//   node scripts/scenario.js data/threats.json 2026-08-15T04:30:00Z

import fs from "node:fs";
import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, combineCeilings, exposureCount } from "../src/viewshed.js";
import { hiddenFraction } from "../src/corridor.js";
import { loadObstacleHeightsSync } from "../src/obstaclesNode.js";
import { buildSurface } from "../src/obstacles.js";
import { solarPosition, sunTimes } from "../src/sun.js";
import { computeShadow } from "../src/shadow.js";
import { computeGradedGlare, weightedExposure, glareCoverage, isOptical } from "../src/glare.js";
import { findPath } from "../src/pathfind.js";
import { encodePng, hillshadeRgb, blend } from "../src/png.js";
import { parseThreats, describeThreat, ThreatInputError } from "../src/threats.js";
import { lonLatToGrid, insideBounds, describeBounds } from "../src/coords.js";
import {
  VEHICLES, computeSlope, computeTrafficable, concealedFraction,
  checkEndurance, describeEndurance, resolveVehicles, VehicleInputError,
} from "../src/vehicles.js";

const missionFile = process.argv[2] || "data/threats.json";
let mission;
try {
  mission = JSON.parse(fs.readFileSync(missionFile, "utf8"));
} catch (error) {
  console.error("\nCould not read the mission file " + missionFile + ":\n  " +
    error.message + "\n\nExpected JSON with mission.start, mission.goal and a threats array.\n");
  process.exit(1);
}
const when = new Date(process.argv[3] || mission.mission.timeUtc);

const dem = loadDemSync();
const lat = (dem.latTop + dem.latBottom) / 2;
const lon = (dem.lonLeft + dem.lonRight) / 2;
const cellCount = dem.width * dem.height;

// Buildings and trees, if a prepared obstacle grid is present. The surface -
// ground plus whatever stands on it - is what the viewshed sweeps over, so a
// treeline or a building row masks a drone behind it. With no obstacle file
// this is the bare ground and the run is unchanged. On flat steppe, where the
// terrain hides nothing, this is the difference between a corridor and none.
const obstacleHeight = loadObstacleHeightsSync(dem);
const surface = buildSurface(dem, obstacleHeight);
if (obstacleHeight) {
  let obstructed = 0;
  for (let i = 0; i < obstacleHeight.length; i++) {
    if (obstacleHeight[i] > 0) obstructed = obstructed + 1;
  }
  console.log("obstacles " + ((obstructed / obstacleHeight.length) * 100).toFixed(1) +
    "% of cells carry a building or tree (masking surface active)");
}

// Metres of extra travel worth accepting to avoid one second of exposure.
// Calibrated by sweeping: 0 gives 570 s exposed, 50 gives 192 s for a 30%
// detour, and anything past 400 buys 26 s more for a 79% detour. Bad trade.
const EXPOSURE_PENALTY = 50;

const pct = (f) => (f * 100).toFixed(1) + "%";
const NAMES = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const bearingName = (d) => NAMES[Math.round(d / 22.5) % 16];

let threats;
try {
  threats = parseThreats(mission.threats, dem);
} catch (error) {
  if (error instanceof ThreatInputError) {
    console.error("\nBad threat input in " + missionFile + ":\n  " + error.message + "\n");
    process.exit(1);
  }
  throw error;
}

function missionPoint(spec, name) {
  if (!spec || !insideBounds(dem, spec.lat, spec.lon)) {
    console.error("\nmission." + name + " missing or outside the map (" + describeBounds(dem) + ")\n");
    process.exit(1);
  }
  const cell = lonLatToGrid(dem, spec.lat, spec.lon);
  return {
    x: Math.min(dem.width - 1, Math.max(0, Math.round(cell.x))),
    y: Math.min(dem.height - 1, Math.max(0, Math.round(cell.y))),
    label: spec.label || name,
  };
}
// Which platform the route is for. A class shows the trade-off across that
// class; a specific id plans for exactly one.
let selection;
try {
  selection = resolveVehicles(mission.mission.vehicle);
} catch (error) {
  if (error instanceof VehicleInputError) {
    console.error("\n" + error.message + "\n");
    process.exit(1);
  }
  throw error;
}

const start = missionPoint(mission.mission.start, "start");
const goal = missionPoint(mission.mission.goal, "goal");

// ------------------------------------------------------------------ setup
console.log("\n=== CORRIDOR PLANNER ===");
console.log("area    " + ((dem.width * dem.cellSize) / 1000).toFixed(1) + " x " +
  ((dem.height * dem.cellSize) / 1000).toFixed(1) + " km Carpathians at " + dem.cellSize + " m");
console.log("mission " + start.label + " -> " + goal.label);
console.log("planning for " + selection.label +
  (selection.isClass ? " (" + selection.vehicles.length + " platforms)" : ""));
console.log("time    " + when.toISOString());

const sun = solarPosition(when, lat, lon);
const times = sunTimes(when, lat, lon);
const shadowResult = computeShadow(dem, sun);
console.log("sun     " + sun.elevation.toFixed(1) + " deg, " + sun.azimuth.toFixed(0) +
  " deg (" + bearingName(sun.azimuth) + "), " + pct(shadowResult.shadowedFraction) + " of terrain shadowed");

console.log("\n--- threats (operator input) ---");
const ceilings = [];
const opticalCeilings = [];
for (const threat of threats) {
  const threatCeiling = computeCeiling(dem, threat, {
    observerHeight: threat.mastHeight,
    maxRangeMetres: threat.maxRangeMetres,
    surface: surface,
  });
  ceilings.push(threatCeiling);
  // Optical watchers are tracked separately so sun shadow only discounts the
  // ground THEY can see - thermal and radar look straight through shade.
  if (isOptical(threat)) {
    opticalCeilings.push(threatCeiling);
  }
  console.log("  " + describeThreat(threat));
}
const ceiling = combineCeilings(ceilings, cellCount);
const slope = computeSlope(dem);

// Per-cell fraction of the watchers that are optical, at the low-cruise
// height used for routing. Sun shadow is worth only this share, because a
// thermal sensor sees a drone in shade as well as in sun.
function opticalShareAt(heightAboveGround) {
  const share = new Float32Array(cellCount);
  const allCount = exposureCount(dem, ceilings, heightAboveGround);
  const opticalCount = exposureCount(dem, opticalCeilings, heightAboveGround);
  for (let i = 0; i < cellCount; i++) {
    share[i] = allCount[i] > 0 ? opticalCount[i] / allCount[i] : 0;
  }
  return share;
}

// Where an observer at each threat would be looking into the sun. Optical
// threats only - radar does not care what the sun is doing, and thermal can
// invert.
const glares = threats.map((threat) => computeGradedGlare(dem, threat, sun));
const opticalCount = threats.filter(isOptical).length;

// -------------------------------------------------- the altitude trade-off
// The single most important output. Cover does not degrade gently with
// height; it falls away, and this is the curve that shows it.
console.log("\n--- how much cover you lose by climbing ---");
let previousHidden = null;
for (const agl of [5, 15, 30, 50, 80, 120, 200]) {
  const hidden = hiddenFraction(dem, ceiling, agl);
  const delta = previousHidden === null ? "" : ((hidden - previousHidden) * 100).toFixed(1) + " pts";
  console.log("  " + (agl + " m AGL").padStart(9) + "  " + pct(hidden).padStart(6) +
    "  " + delta.padStart(9) + "  " + "#".repeat(Math.round(hidden * 45)));
  previousHidden = hidden;
}

// ---------------------------------------------------------------- routing
console.log("\n--- route by platform ---");
console.log("platform".padEnd(28) + "AGL".padStart(6) + "concealed".padStart(11) +
  "direct".padStart(10) + "planned".padStart(10) + "longest".padStart(9) +
  "detour".padStart(8) + "endurance".padStart(17));

const notes = [];
const rendered = {};

for (const vehicle of selection.vehicles) {
  const id = vehicle.id;
  const passable = computeTrafficable(dem, vehicle, slope);
  // Weighted, not counted: a dazzled optical observer counts for half.
  const exposure = weightedExposure(dem, ceilings, glares, vehicle.heightAboveGround,
    { glareDiscount: 0.5 });
  const opticalShare = opticalShareAt(vehicle.heightAboveGround);
  const grids = {
    passable: passable, exposure: exposure, opticalShare: opticalShare,
    shadow: shadowResult.shadow, elev: dem.elev,
  };

  // Direct is the shortest passable route, ignoring who can see it. Planned
  // weights exposure heavily. Both run through the same pathfinder, so the
  // comparison is like for like - and neither can return a route over ground
  // the vehicle cannot cross, which the old candidate sampler happily did.
  const direct = findPath(dem, start, goal, grids, { vehicle: vehicle, exposurePenalty: 0 });
  const planned = findPath(dem, start, goal, grids, {
    vehicle: vehicle, exposurePenalty: EXPOSURE_PENALTY, shadowDiscount: 0.35,
  });

  if (!direct.found || !planned.found) {
    const reason = direct.reason || planned.reason;
    console.log(vehicle.label.padEnd(28) + (vehicle.heightAboveGround + " m").padStart(6) +
      "   NO ROUTE - " + reason);
    notes.push(vehicle.label + ": " + reason);
    continue;
  }

  const endurance = checkEndurance(planned, vehicle);
  // Start and goal can be the same cell if someone clicks twice in one place.
  const detour = direct.metres > 0
    ? ((planned.metres / direct.metres - 1) * 100).toFixed(0) + "%"
    : "n/a";

  console.log(
    vehicle.label.padEnd(28) +
    (vehicle.heightAboveGround + " m").padStart(6) +
    pct(concealedFraction(dem, ceiling, vehicle)).padStart(11) +
    (direct.exposedSeconds.toFixed(0) + "s").padStart(10) +
    (planned.exposedSeconds.toFixed(0) + "s").padStart(10) +
    (planned.longestExposedRun.toFixed(0) + "s").padStart(9) +
    detour.padStart(8) +
    (endurance.feasible
      ? "OK " + (endurance.marginFraction * 100).toFixed(0) + "% spare"
      : "OVER by " + (-endurance.marginFraction * 100).toFixed(0) + "%").padStart(17)
  );

  if (!endurance.feasible) {
    notes.push(vehicle.label + ": " + describeEndurance(endurance));
  }
  if (rendered[id] === undefined && Object.keys(rendered).length < 2) {
    rendered[id] = { vehicle, passable, exposure, direct, planned };
  }
}

if (notes.length > 0) {
  console.log("\n--- what will not work, and why ---");
  for (const note of notes) {
    console.log("  " + note);
  }
}

// ------------------------------------------------------- departure window
// Analysed against THE ACTUAL ROUTE, not the whole map. What matters is not
// how much terrain is shadowed somewhere, but how much of the ground you will
// actually be exposed on has an observer squinting into the sun.
//
// The two effects pull against each other and the tool should say so rather
// than pick for you: a low sun gives the most shadow and the most glare, but
// the shadow discount also tempts the router onto more exposed ground.
console.log("\n--- departure window, measured on the route itself ---");
const reference = selection.vehicles[selection.vehicles.length - 1];
const referencePassable = computeTrafficable(dem, reference, slope);

const options = [];
for (let minute = 180; minute <= 1110; minute += 30) {
  const at = new Date(Date.UTC(2026, 7, 15, 0, minute));
  const s2 = solarPosition(at, lat, lon);
  if (s2.elevation <= 0) {
    continue;
  }
  const shade = computeShadow(dem, s2);
  const g = threats.map((t) => computeGradedGlare(dem, t, s2));
  const exposureNow = weightedExposure(dem, ceilings, g, reference.heightAboveGround,
    { glareDiscount: 0.5 });
  const r = findPath(dem, start, goal,
    {
      passable: referencePassable, exposure: exposureNow,
      opticalShare: opticalShareAt(reference.heightAboveGround),
      shadow: shade.shadow, elev: dem.elev,
    },
    { vehicle: reference, exposurePenalty: EXPOSURE_PENALTY, shadowDiscount: 0.35 });
  if (!r.found) {
    continue;
  }

  let exposedCells = 0;
  let dazzledCells = 0;
  for (const index of r.trace) {
    let seen = 0;
    let dazzled = 0;
    for (let c = 0; c < ceilings.length; c++) {
      if (dem.elev[index] + reference.heightAboveGround > ceilings[c][index]) {
        seen = seen + 1;
        if (g[c][index] > 0) dazzled = dazzled + 1;
      }
    }
    if (seen > 0) {
      exposedCells = exposedCells + 1;
      if (dazzled > 0) dazzledCells = dazzledCells + 1;
    }
  }
  const exposedSeconds = (exposedCells * dem.cellSize) / reference.speed;
  options.push({
    at: at, sun: s2,
    exposedSeconds: exposedSeconds,
    dazzledFraction: exposedCells === 0 ? 0 : dazzledCells / exposedCells,
    // Seconds spent exposed to an observer who can see you clearly.
    clearlySeenSeconds: exposedSeconds * (1 - (exposedCells === 0 ? 0 : dazzledCells / exposedCells)),
  });
}

options.sort((a, b) => a.clearlySeenSeconds - b.clearlySeenSeconds);
console.log("  " + "time".padEnd(11) + "sun".padStart(14) + "exposed".padStart(10) +
  "dazzled".padStart(10) + "clearly seen".padStart(14));
for (const o of options.slice(0, 6)) {
  console.log(
    "  " + (o.at.toISOString().slice(11, 16) + " UTC").padEnd(11) +
    (o.sun.elevation.toFixed(1) + " " + bearingName(o.sun.azimuth)).padStart(14) +
    (o.exposedSeconds.toFixed(0) + "s").padStart(10) +
    pct(o.dazzledFraction).padStart(10) +
    (o.clearlySeenSeconds.toFixed(0) + "s").padStart(14)
  );
}
const bestWindow = options[0];
const worstWindow = options[options.length - 1];
console.log("\n  Best departure " + bestWindow.at.toISOString().slice(11, 16) + " UTC: " +
  bestWindow.clearlySeenSeconds.toFixed(0) + "s clearly seen, against " +
  worstWindow.clearlySeenSeconds.toFixed(0) + "s at " +
  worstWindow.at.toISOString().slice(11, 16) + " UTC.");
if (bestWindow.dazzledFraction > 0.01) {
  console.log("  Approach from " + bearingName(bestWindow.sun.azimuth) +
    " puts the sun behind you from " + pct(bestWindow.dazzledFraction) +
    " of the ground you can be seen on.");
} else {
  console.log("  No glare advantage is available at that time on this route - the" +
    "\n  geometry does not put any optical observer into the sun.");
}
console.log("  " + opticalCount + " of " + threats.length +
  " threats are optical. Radar and EW are unaffected by any of this.");
console.log("  sunrise " + times.sunrise.toISOString().slice(11, 16) +
  " UTC, sunset " + times.sunset.toISOString().slice(11, 16) + " UTC");
console.log("  NOTE: glare and shadow degrade eyes and cameras only. Radar does not");
console.log("  care. Thermal does not either, and can invert. Terrain masking is the");
console.log("  part that works against every sensor.");

// ----------------------------------------------------------------- render
for (const id of Object.keys(rendered)) {
  const r = rendered[id];
  const rgb = hillshadeRgb(dem);
  for (let i = 0; i < cellCount; i++) {
    if (shadowResult.shadow[i] === 1) blend(rgb, i, 40, 60, 110, 0.22);
    if (r.passable[i] === 0) blend(rgb, i, 15, 15, 15, 0.5);
    if (r.exposure[i] > 0) blend(rgb, i, 205, 30, 30, r.exposure[i] === 1 ? 0.32 : 0.55);
  }
  const stamp = (index, cr, cg, cb, radius) => {
    const cx = index % dem.width;
    const cy = Math.floor(index / dem.width);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= dem.width || y >= dem.height) continue;
        if (dx * dx + dy * dy > radius * radius) continue;
        blend(rgb, y * dem.width + x, cr, cg, cb, 1);
      }
    }
  };
  for (const i of r.direct.trace) stamp(i, 255, 205, 40, 1);
  for (const i of r.planned.trace) stamp(i, 40, 235, 95, 2);
  for (const t of threats) {
    stamp(t.y * dem.width + t.x, 255, 255, 255, 8);
    stamp(t.y * dem.width + t.x, 215, 0, 0, 5);
  }
  stamp(start.y * dem.width + start.x, 255, 255, 255, 7);
  stamp(goal.y * dem.width + goal.x, 255, 255, 255, 7);
  fs.writeFileSync("data/corridor-" + id + ".png", encodePng(dem.width, dem.height, rgb));
}
console.log("\nwrote data/corridor-*.png  (red = seen, blue = shadow, black = impassable,");
console.log("yellow = shortest route, green = planned route)\n");
