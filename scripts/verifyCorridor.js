// Positive controls for the corridor route, guarding two bugs that both
// produced confident, wrong-looking-plausible output.

import fs from "node:fs";
import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, exposureCount } from "../src/viewshed.js";
import { computeShadow } from "../src/shadow.js";
import { loadObstacleHeightsSync } from "../src/obstaclesNode.js";
import { buildSurface } from "../src/obstacles.js";
import { computeGradedGlare, weightedExposure } from "../src/glare.js";
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
const slope = computeSlope(dem);
// The demo sweeps line of sight over the SURFACE - ground plus trees and
// buildings - and gates trafficability on the same obstacles. Testing bare
// terrain instead measured a different tool: far less exposure, no gradient
// between balanced and safest, and nothing for the sun to work with.
const obstacleHeight = loadObstacleHeightsSync(dem);
const surface = buildSurface(dem, obstacleHeight);

const mission = JSON.parse(fs.readFileSync("data/threats.json", "utf8"));

// The corridor controls place their OWN threats rather than using the shipped
// mission. A test that depends on demo tuning fails whenever the demo is
// retuned, which is exactly what happened when sensor ranges were corrected
// from an invented 20-30 km to a sourced 2-4 km: the shipped route stopped
// being seen at all, and "planning reduces exposure" failed on 0 s vs 0 s.
// That was the scenario changing, not the router breaking.
//
// These sit directly over the corridor with generous range, so there is
// always real exposure to reduce.
const threats = parseThreats([
  // Positioned on ground that genuinely overwatches the corridor, with the
  // sourced sensor ranges. Two earlier versions of this scenario were wrong in
  // opposite directions and both made checks meaningless:
  //
  //   the shipped mission - retuning the demo turned the suite red, which is
  //   the scenario changing rather than the router breaking
  //   two blanket 12 km sensors - they covered everything, so the minimum-
  //   exposure route was already found at penalty 50 and "safest beats
  //   balanced" could never be true
  //
  // What a gradient test needs is threats that leave a CHOICE: enough exposure
  // on the direct line to matter, and enough clear ground that paying for a
  // detour buys something.
  { label: "east ridge OP", type: "optical", lat: 48.1723, lon: 24.4793, mastHeight: 6, maxRangeKm: 2 },
  { label: "west ridge EW", type: "ew", lat: 48.1820, lon: 24.4259, mastHeight: 18, maxRangeKm: 4 },
  { label: "south radar", type: "radar", lat: 48.1520, lon: 24.4520, mastHeight: 12, maxRangeKm: 4 },
], dem);
const ceilings = threats.map((t) =>
  computeCeiling(dem, t, { observerHeight: t.mastHeight, maxRangeMetres: t.maxRangeMetres, surface: surface })
);
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
  const passable = computeTrafficable(dem, vehicle, slope, obstacleHeight);
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
  passable: computeTrafficable(dem, v, slope, obstacleHeight),
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
  // Bare slope, not the real obstacle layer: this section isolates ONE
  // synthetic obstacle. Carrying the real trees and buildings as well means
  // the baseline route already detours around them and the comparison
  // measures nothing.
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

// -------------------------------------------------------- route options
console.log("\n  safest and reduced-visibility must behave as advertised");

{
  const v = VEHICLES.quadLow;
  const passable = computeTrafficable(dem, v, slope, obstacleHeight);
  const plain = exposureCount(dem, ceilings, v.heightAboveGround);
  const grids = { passable, exposure: plain, shadow: null, elev: dem.elev };

  const balanced = findPath(dem, start, goal, grids, { vehicle: v, exposurePenalty: 50 });
  const safest = findPath(dem, start, goal, grids, { vehicle: v, exposurePenalty: 400 });

  console.log("    balanced " + (balanced.metres / 1000).toFixed(1) + " km / " +
    balanced.exposedSeconds.toFixed(0) + "s, safest " + (safest.metres / 1000).toFixed(1) +
    " km / " + safest.exposedSeconds.toFixed(0) + "s");
  check("  safest is less exposed than balanced",
    safest.exposedSeconds < balanced.exposedSeconds,
    safest.exposedSeconds.toFixed(0) + "s vs " + balanced.exposedSeconds.toFixed(0) + "s");
  check("  and pays for it in distance", safest.metres > balanced.metres,
    ((safest.metres / balanced.metres - 1) * 100).toFixed(0) + "% further");
  check("  safest is still a bounded detour", safest.metres < balanced.metres * 2);

  // A HIGH sun must leave the sun-aware route identical to the plain one:
  // nothing is dazzled, nothing is shadowed, so there is nothing to exploit.
  // A LOW sun must change it. This pair is the check that the sun input is
  // actually wired to the router rather than merely reported alongside it.
  function sunAwareRoute(hourUtc) {
    const at = new Date(Date.UTC(2026, 7, 15, Math.floor(hourUtc), (hourUtc % 1) * 60));
    const sun = solarPosition(at, 48.17, 24.5);
    const shadow = computeShadow(dem, sun).shadow;
    const glares = threats.map((t) => computeGradedGlare(dem, t, sun));
    const weighted = weightedExposure(dem, ceilings, glares, v.heightAboveGround,
      { glareDiscount: 0.5 });
    return {
      sun,
      route: findPath(dem, start, goal,
        { passable, exposure: weighted, shadow, elev: dem.elev },
        { vehicle: v, exposurePenalty: 50, shadowDiscount: 0.35 }),
    };
  }
  const same = (a, b) => a.trace.length === b.trace.length &&
    a.trace.every((c, i) => c === b.trace[i]);

  const high = sunAwareRoute(10.5);
  const low = sunAwareRoute(16.5);
  console.log("    sun " + high.sun.elevation.toFixed(0) + " deg -> " +
    (same(high.route, balanced) ? "same as balanced" : "diverges") + ", sun " +
    low.sun.elevation.toFixed(0) + " deg -> " +
    (same(low.route, balanced) ? "same as balanced" : "diverges"));
  check("  a high sun leaves the route unchanged", same(high.route, balanced));
  check("  a low sun changes it", !same(low.route, balanced));

  // Whatever it does to the path, it must never break the hard constraints.
  let allPassable = true;
  for (const index of low.route.trace) {
    if (passable[index] === 0) allPassable = false;
  }
  check("  the sun-aware route stays on passable ground", allPassable);
  check("  and stays a bounded detour", low.route.metres < balanced.metres * 2,
    ((low.route.metres / balanced.metres - 1) * 100).toFixed(0) + "% vs balanced");
}

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
