import fs from "node:fs";
import { TEST_START, TEST_GOAL, TEST_THREATS } from "../src/testScenario.js";
import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, exposureCount } from "../src/viewshed.js";
import { planMission, outAndBack, MissionError } from "../src/mission.js";
import { findPath } from "../src/pathfind.js";
import { parseThreats } from "../src/threats.js";
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}

const dem = loadDemSync();
const cellCount = dem.width * dem.height;
const vehicle = VEHICLES.quadLow;
const mission = JSON.parse(fs.readFileSync("data/threats.json", "utf8"));
const threats = parseThreats(TEST_THREATS, dem);
const ceilings = threats.map((t) =>
  computeCeiling(dem, t, { observerHeight: t.mastHeight, maxRangeMetres: t.maxRangeMetres }));
const exposure = exposureCount(dem, ceilings, vehicle.heightAboveGround);
const grids = {
  passable: computeTrafficable(dem, vehicle, computeSlope(dem)),
  exposure: exposure,
  elev: dem.elev,
};

const base = { x: 568, y: 669, label: "base" };
const dropA = { x: 482, y: 276, label: "drop A", dwellSeconds: 60 };
const dropB = { x: 700, y: 420, label: "drop B", dwellSeconds: 30 };

console.log("\nMULTI-LEG MISSIONS");

// Two waypoints must reproduce a single leg exactly.
const single = planMission(dem, [base, dropA], grids, { vehicle: vehicle });
const direct = findPath(dem, base, dropA, grids, { vehicle: vehicle });
check("a two-point mission matches a plain route",
  single.complete && Math.abs(single.totals.metres - direct.metres) < 0.001);

// Three waypoints must be the sum of their legs, not something else.
const multi = planMission(dem, [base, dropA, dropB], grids, { vehicle: vehicle });
const legOne = findPath(dem, base, dropA, grids, { vehicle: vehicle });
const legTwo = findPath(dem, dropA, dropB, grids, { vehicle: vehicle });
console.log("  base -> drop A -> drop B: " + (multi.totals.metres / 1000).toFixed(1) +
  " km, " + multi.totals.exposedSeconds.toFixed(0) + "s exposed, " +
  multi.totals.dwellSeconds + "s dwell");
check("legs are planned and totalled correctly", multi.complete && multi.legs.length === 2);
check("distance is the sum of the legs",
  Math.abs(multi.totals.metres - (legOne.metres + legTwo.metres)) < 0.001);

// The trace must be continuous across the join, not two disconnected pieces.
let contiguous = true;
for (let i = 1; i < multi.trace.length; i++) {
  const a = multi.trace[i - 1];
  const b = multi.trace[i];
  const dx = Math.abs((a % dem.width) - (b % dem.width));
  const dy = Math.abs(Math.floor(a / dem.width) - Math.floor(b / dem.width));
  if (dx > 1 || dy > 1) contiguous = false;
}
check("the joined trace has no gap at the waypoint", contiguous,
  multi.trace.length + " cells");
check("the join is not double-counted",
  multi.trace.length === legOne.trace.length + legTwo.trace.length - 1);

// Dwell must count against the clock and against endurance.
check("dwell is added to mission time",
  Math.abs(multi.totals.seconds - (multi.totals.movingSeconds + 90)) < 0.001);
const noDwell = planMission(dem,
  [base, { ...dropA, dwellSeconds: 0 }, { ...dropB, dwellSeconds: 0 }], grids, { vehicle });
check("dwell costs endurance",
  multi.endurance.requiredSeconds > noDwell.endurance.requiredSeconds,
  (multi.endurance.requiredSeconds - noDwell.endurance.requiredSeconds).toFixed(0) + "s more");

// Out and back must return to the start.
const sortie = planMission(dem, outAndBack(base, [dropA]), grids, { vehicle: vehicle });
check("an out-and-back returns to its base",
  sortie.complete && sortie.trace[sortie.trace.length - 1] === base.y * dem.width + base.x);
check("and is roughly twice a one-way leg",
  sortie.totals.metres > direct.metres * 1.9 && sortie.totals.metres < direct.metres * 2.1,
  (sortie.totals.metres / 1000).toFixed(1) + " km against " +
  (direct.metres / 1000).toFixed(1) + " km one way");

// A failed leg must be named, not swallowed.
const unreachable = { x: 5, y: 5, label: "off in the corner" };
const ugv = VEHICLES.ugvWheeled;
const ugvGrids = {
  passable: computeTrafficable(dem, ugv, computeSlope(dem)),
  exposure: exposure, elev: dem.elev,
};
const broken = planMission(dem, [base, unreachable], ugvGrids, { vehicle: ugv });
check("an impossible leg is reported with its number and both labels",
  broken.complete === false && typeof broken.reason === "string" &&
  broken.reason.indexOf("leg 1") === 0);
if (!broken.complete) console.log("  " + broken.reason);

// Too few waypoints must be rejected.
let threw = false;
try { planMission(dem, [base], grids, { vehicle: vehicle }); }
catch (error) { threw = error instanceof MissionError; }
check("a mission with one waypoint is rejected", threw);

console.log("");
if (failures > 0) { console.log(failures + " CHECK(S) FAILED"); process.exit(1); }
console.log("all checks passed");
