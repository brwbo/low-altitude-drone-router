// Positive controls for the corridor route, guarding two bugs that both
// produced confident, wrong-looking-plausible output.

import fs from "node:fs";
import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, exposureCount } from "../src/viewshed.js";
import { computeShadow } from "../src/shadow.js";
import { solarPosition } from "../src/sun.js";
import { findPath } from "../src/pathfind.js";
import { parseThreats } from "../src/threats.js";
import { lonLatToGrid } from "../src/coords.js";
import { VEHICLES, computeSlope, computeTrafficable, resolveVehicles, VehicleInputError } from "../src/vehicles.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}

const dem = loadDemSync();
const cellCount = dem.width * dem.height;
const mission = JSON.parse(fs.readFileSync("data/threats.json", "utf8"));
const threats = parseThreats(mission.threats, dem);
const ceilings = threats.map((t) =>
  computeCeiling(dem, t, { observerHeight: t.mastHeight, maxRangeMetres: t.maxRangeMetres })
);
const slope = computeSlope(dem);
const cell = (s) => {
  const c = lonLatToGrid(dem, s.lat, s.lon);
  return { x: Math.round(c.x), y: Math.round(c.y) };
};
const start = cell(mission.mission.start);
const goal = cell(mission.mission.goal);
const sun = solarPosition(new Date(mission.mission.timeUtc), 48.17, 24.5);
const shadow = computeShadow(dem, sun).shadow;

console.log("\nCORRIDOR  the planned route must be a route, and a sane one");

for (const id of ["ugvTracked", "quadLow"]) {
  const vehicle = VEHICLES[id];
  const passable = computeTrafficable(dem, vehicle, slope);
  const exposure = exposureCount(dem, ceilings, vehicle.heightAboveGround);
  const grids = { passable, exposure, shadow, elev: dem.elev };

  const direct = findPath(dem, start, goal, grids, { vehicle, exposurePenalty: 0 });
  const planned = findPath(dem, start, goal, grids, {
    vehicle, exposurePenalty: 50, shadowDiscount: 0.35,
  });

  console.log("  " + vehicle.label + ": direct " + (direct.metres / 1000).toFixed(1) +
    " km / " + direct.exposedSeconds.toFixed(0) + " s exposed, planned " +
    (planned.metres / 1000).toFixed(1) + " km / " + planned.exposedSeconds.toFixed(0) + " s");

  check("  both routes exist", direct.found && planned.found);

  // The point of the whole thing. If avoiding exposure does not reduce
  // exposure, the cost function is not doing what it claims.
  check("  planning reduces exposure", planned.exposedSeconds < direct.exposedSeconds,
    planned.exposedSeconds.toFixed(0) + " s vs " + direct.exposedSeconds.toFixed(0) + " s");

  // GUARDS A REAL BUG. shadowBonus used to subtract from step cost, making
  // edge weights negative, which makes Dijkstra invalid. It returned routes
  // 800 times longer than direct while looking like it worked. Any detour
  // beyond a small multiple means the cost function has gone negative again.
  check("  detour stays within 2x the direct route",
    planned.metres < direct.metres * 2,
    ((planned.metres / direct.metres - 1) * 100).toFixed(0) + "% detour");

  // GUARDS A REAL BUG. The old candidate sampler returned routes crossing
  // ground the vehicle could not traverse and reported the endurance as OK.
  let allPassable = true;
  for (const index of planned.trace) {
    if (passable[index] === 0) allPassable = false;
  }
  check("  no cell on the planned route is impassable", allPassable,
    planned.trace.length + " cells");

  check("  direct route is the shorter one", direct.metres <= planned.metres + 1);
}

// A shadow discount must never flip a step cost negative, at any setting.
console.log("\n  shadow discount is clamped and never inverts the cost");
const v = VEHICLES.quadLow;
const grids = {
  passable: computeTrafficable(dem, v, slope),
  exposure: exposureCount(dem, ceilings, v.heightAboveGround),
  shadow: shadow,
  elev: dem.elev,
};
const extreme = findPath(dem, start, goal, grids, {
  vehicle: v, exposurePenalty: 50, shadowDiscount: 99,
});
check("an absurd discount still yields a bounded route",
  extreme.found && extreme.metres < 100000,
  (extreme.metres / 1000).toFixed(1) + " km");

// ------------------------------------------------------------- obstacles
console.log("\n  obstacles must stop ground vehicles and low aircraft only");

// A 20 m structure plus the 5 m clearance stops anything operating below 25 m
// and nothing above it. This is the whole difference between a UGV and a
// quadcopter, so it is asserted rather than assumed.
const obstacle = new Float32Array(cellCount);
for (let y = 380; y < 430; y++) {
  for (let x = 480; x < 620; x++) {
    obstacle[y * dem.width + x] = 20;
  }
}

const behaviour = [];
for (const id of ["ugvTracked", "quadNap", "quadLow", "quadFpv"]) {
  const v = VEHICLES[id];
  const clear = computeTrafficable(dem, v, slope);
  const withObstacle = computeTrafficable(dem, v, slope, obstacle);
  const wrap = (p) => ({ passable: p, exposure: new Uint8Array(cellCount), elev: dem.elev });
  const before = findPath(dem, start, goal, wrap(clear), { vehicle: v });
  const after = findPath(dem, start, goal, wrap(withObstacle), { vehicle: v });
  behaviour.push({
    v: v,
    detoured: after.found && after.metres > before.metres + 1,
    crossesObstacle: after.found && after.trace.some((i) => obstacle[i] > 0),
  });
}

for (const b of behaviour) {
  const tallEnough = b.v.heightAboveGround >= 25;
  check("  " + b.v.label.padEnd(28) + (tallEnough ? "clears it" : "goes around it"),
    tallEnough ? !b.detoured : b.detoured);
  // Nothing below the obstacle top may ever route through it.
  if (!tallEnough) {
    check("  " + b.v.label.padEnd(28) + "never passes through it", !b.crossesObstacle);
  }
}

// A ground vehicle is stopped by an obstacle of ANY height, however low.
const lowWall = new Float32Array(cellCount);
for (let y = 380; y < 430; y++) {
  for (let x = 480; x < 620; x++) {
    lowWall[y * dem.width + x] = 1.5;
  }
}
const ugv = VEHICLES.ugvTracked;
const ugvBlocked = computeTrafficable(dem, ugv, slope, lowWall);
let wallIsSolid = true;
for (let y = 380; y < 430; y++) {
  for (let x = 480; x < 620; x++) {
    if (ugvBlocked[y * dem.width + x] === 1) wallIsSolid = false;
  }
}
check("  a 1.5 m obstacle still stops a ground vehicle", wallIsSolid);

// And an aircraft well above it is untouched.
const fpvOverLowWall = computeTrafficable(dem, VEHICLES.quadFpv, slope, lowWall);
let fpvUnaffected = true;
for (let y = 380; y < 430; y++) {
  for (let x = 480; x < 620; x++) {
    if (fpvOverLowWall[y * dem.width + x] === 0) fpvUnaffected = false;
  }
}
check("  the same obstacle does not trouble an aircraft at 30 m", fpvUnaffected);

// Omitting the obstacle layer must behave exactly as before.
let identicalWithoutLayer = true;
const withLayer = computeTrafficable(dem, ugv, slope, new Float32Array(cellCount));
const withoutLayer = computeTrafficable(dem, ugv, slope);
for (let i = 0; i < cellCount; i++) {
  if (withLayer[i] !== withoutLayer[i]) identicalWithoutLayer = false;
}
check("  an empty obstacle layer changes nothing", identicalWithoutLayer);

// ------------------------------------------------------- vehicle selection
console.log("\n  the mission's vehicle input resolves correctly");

check("  \"ground\" returns only ground platforms",
  resolveVehicles("ground").vehicles.every((v) => v.airborne === false));
check("  \"air\" returns only aircraft",
  resolveVehicles("air").vehicles.every((v) => v.airborne === true));
check("  \"all\" returns every platform",
  resolveVehicles("all").vehicles.length === Object.keys(VEHICLES).length);
check("  a specific id returns exactly one",
  resolveVehicles("quadLow").vehicles.length === 1 &&
  resolveVehicles("quadLow").vehicles[0].id === "quadLow");
check("  matching is case-insensitive",
  resolveVehicles("AIR").vehicles.length === resolveVehicles("air").vehicles.length &&
  resolveVehicles("QuadLow").vehicles[0].id === "quadLow");

let rejected = 0;
for (const bad of [undefined, null, "", "helicopter", "fixedwing", 42, "  "]) {
  try {
    resolveVehicles(bad);
  } catch (error) {
    if (error instanceof VehicleInputError) rejected = rejected + 1;
  }
}
check("  every invalid vehicle input is rejected", rejected === 7, rejected + " of 7");

// The classes must partition the fleet with nothing missing or double-counted.
const ground = resolveVehicles("ground").vehicles.map((v) => v.id);
const air = resolveVehicles("air").vehicles.map((v) => v.id);
const overlap = ground.filter((id) => air.indexOf(id) !== -1);
check("  ground and air do not overlap", overlap.length === 0);
check("  ground plus air covers every platform",
  ground.length + air.length === Object.keys(VEHICLES).length,
  ground.length + " ground + " + air.length + " air of " + Object.keys(VEHICLES).length);

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
