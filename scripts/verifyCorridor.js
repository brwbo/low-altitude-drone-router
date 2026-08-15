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
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}

const dem = loadDemSync();
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

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
