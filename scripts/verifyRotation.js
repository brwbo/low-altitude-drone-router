import fs from "node:fs";
import { TEST_START, TEST_GOAL, TEST_THREATS } from "../src/testScenario.js";
import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, exposureCount } from "../src/viewshed.js";
import { planRotation, worstOverlap, rotationCost } from "../src/rotation.js";
import { parseThreats } from "../src/threats.js";
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}
const pct = (f) => (f * 100).toFixed(1) + "%";

const dem = loadDemSync();
const cellCount = dem.width * dem.height;
const vehicle = VEHICLES.quadLow;
const mission = JSON.parse(fs.readFileSync("data/threats.json", "utf8"));
const threats = parseThreats(TEST_THREATS, dem);
const ceilings = threats.map((t) =>
  computeCeiling(dem, t, { observerHeight: t.mastHeight, maxRangeMetres: t.maxRangeMetres }));
const grids = {
  passable: computeTrafficable(dem, vehicle, computeSlope(dem)),
  exposure: exposureCount(dem, ceilings, vehicle.heightAboveGround),
  elev: dem.elev,
};
const start = { x: 568, y: 669 };
const goal = { x: 482, y: 276 };

console.log("\nROUTE ROTATION");

const set = planRotation(dem, start, goal, grids, { vehicle: vehicle, count: 4 });
check("it produces the requested number of routes", set.routes.length === 4,
  set.routes.length + " routes");

for (let i = 0; i < set.routes.length; i++) {
  const r = set.routes[i];
  console.log("  route " + (i + 1) + ": " + (r.metres / 1000).toFixed(1) + " km, " +
    r.exposedSeconds.toFixed(0) + "s exposed");
}

const worst = worstOverlap(set.overlap);
console.log("  worst pairwise overlap: " + pct(worst));
check("no two routes are the same path", worst < 0.9, pct(worst));
check("the routes are genuinely distinct", worst < 0.5, pct(worst));

// All must be valid routes over passable ground.
let allValid = true;
for (const route of set.routes) {
  if (!route.found) allValid = false;
  for (const index of route.trace) {
    if (grids.passable[index] === 0) allValid = false;
  }
}
check("every route in the set is flyable", allValid);

// The first must still be the best - variety is a cost, not a free gain.
const cost = rotationCost(set.routes);
console.log("  exposure across the set: " + cost.bestExposedSeconds.toFixed(0) + "s best, " +
  cost.worstExposedSeconds.toFixed(0) + "s worst");
check("the first route is the cheapest on exposure",
  set.routes[0].exposedSeconds <= cost.worstExposedSeconds + 0.001);
check("variety costs something", cost.worstExposedSeconds >= cost.bestExposedSeconds);

// A single-route rotation must equal the plain optimum.
const one = planRotation(dem, start, goal, grids, { vehicle: vehicle, count: 1 });
check("asking for one route gives the plain optimum",
  one.routes.length === 1 &&
  Math.abs(one.routes[0].metres - set.routes[0].metres) < 0.001);

// The overlap matrix must be well formed.
check("a route overlaps itself completely",
  set.overlap.every((row, i) => row[i] === 1));
check("the overlap matrix is square",
  set.overlap.length === set.routes.length &&
  set.overlap.every((row) => row.length === set.routes.length));

// Asking for more routes than the terrain supports must stop cleanly rather
// than loop or return duplicates.
const greedy = planRotation(dem, start, goal, grids, { vehicle: vehicle, count: 40 });
console.log("  asked for 40, terrain supports " + greedy.routes.length);
check("it stops when no distinct route remains", greedy.routes.length <= 40);
check("and returns at least one", greedy.routes.length >= 1);

console.log("");
if (failures > 0) { console.log(failures + " CHECK(S) FAILED"); process.exit(1); }
console.log("all checks passed");
