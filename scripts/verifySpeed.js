import fs from "node:fs";
import { TEST_START, TEST_GOAL, TEST_THREATS } from "../src/testScenario.js";
import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, exposureCount } from "../src/viewshed.js";
import { planSpeedProfile, evaluateSpeeds, sprintTradeoff } from "../src/speed.js";
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
const passable = computeTrafficable(dem, vehicle, computeSlope(dem));
const route = findPath(dem, { x: 568, y: 669 }, { x: 482, y: 276 },
  { passable: passable, exposure: exposure, elev: dem.elev },
  { vehicle: vehicle, exposurePenalty: 50 });

console.log("\nVARIABLE SPEED");

const profile = planSpeedProfile(dem, route.trace, exposure, vehicle);
let sprintCells = 0;
let wrongCells = 0;
for (let i = 0; i < route.trace.length; i++) {
  const seen = exposure[route.trace[i]] > 0;
  if (profile.speeds[i] > profile.cruise) sprintCells = sprintCells + 1;
  if (seen !== (profile.speeds[i] > profile.cruise)) wrongCells = wrongCells + 1;
}
check("it sprints exactly where it is seen and nowhere else", wrongCells === 0,
  sprintCells + " of " + route.trace.length + " cells at sprint");
check("sprint is faster than cruise", profile.sprint > profile.cruise,
  profile.cruise + " -> " + profile.sprint + " m/s");

const trade = sprintTradeoff(dem, route.trace, exposure, vehicle);
console.log("  at cruise:    " + trade.atCruise.seconds.toFixed(0) + "s journey, " +
  trade.atCruise.exposedSeconds.toFixed(0) + "s exposed, " +
  trade.atCruise.enduranceSeconds.toFixed(0) + "s of endurance");
console.log("  with sprint:  " + trade.withSprint.seconds.toFixed(0) + "s journey, " +
  trade.withSprint.exposedSeconds.toFixed(0) + "s exposed, " +
  trade.withSprint.enduranceSeconds.toFixed(0) + "s of endurance");
console.log("  buys " + trade.exposureSavedSeconds.toFixed(0) + "s less in view for " +
  trade.enduranceCostSeconds.toFixed(0) + "s more endurance drawn");

check("sprinting reduces time in view", trade.exposureSavedSeconds > 0);
check("the reduction matches the speed ratio",
  Math.abs(trade.exposureSavedFraction - (1 - trade.cruise / trade.sprint)) < 0.01,
  (trade.exposureSavedFraction * 100).toFixed(1) + "% saved");
check("sprinting shortens the journey", trade.withSprint.seconds < trade.atCruise.seconds);
check("sprinting costs endurance", trade.enduranceCostSeconds > 0);
check("only exposed time is spent sprinting",
  Math.abs(trade.withSprint.sprintingSeconds - trade.withSprint.exposedSeconds) < 0.001);

// A route that is never seen must be unaffected in every respect.
const noExposure = new Uint8Array(cellCount);
const noTrade = sprintTradeoff(dem, route.trace, noExposure, vehicle);
check("a wholly concealed route never sprints",
  noTrade.withSprint.sprintingSeconds === 0 &&
  Math.abs(noTrade.withSprint.seconds - noTrade.atCruise.seconds) < 0.001);
check("and costs no extra endurance",
  Math.abs(noTrade.enduranceCostSeconds) < 0.001);

// A sprint speed equal to cruise must change nothing at all.
const nullTrade = sprintTradeoff(dem, route.trace, exposure, vehicle,
  { sprintSpeed: vehicle.speed });
check("sprinting at cruise speed is a no-op",
  Math.abs(nullTrade.exposureSavedSeconds) < 0.001);

console.log("");
if (failures > 0) { console.log(failures + " CHECK(S) FAILED"); process.exit(1); }
console.log("all checks passed");
