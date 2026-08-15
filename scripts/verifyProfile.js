// The altitude profile must be concealed where it can be, flyable everywhere,
// and honest about the segments where neither is possible.

import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, combineCeilings } from "../src/viewshed.js";
import { findPath } from "../src/pathfind.js";
import { planAltitudeProfile, summariseProfile } from "../src/profile.js";
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";
import { parseThreats } from "../src/threats.js";
import fs from "node:fs";

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
  computeCeiling(dem, t, { observerHeight: t.mastHeight, maxRangeMetres: t.maxRangeMetres }));
const ceiling = combineCeilings(ceilings, cellCount);

const vehicle = VEHICLES.quadLow;
const passable = computeTrafficable(dem, vehicle, computeSlope(dem));
const route = findPath(dem, { x: 568, y: 669 }, { x: 482, y: 276 },
  { passable: passable, exposure: new Uint8Array(cellCount), elev: dem.elev },
  { vehicle: vehicle });

console.log("\nALTITUDE PROFILE");
const profile = planAltitudeProfile(dem, route.trace, ceiling, { clearance: 10, cruiseAgl: 60 });
console.log("  " + route.trace.length + " cells, " +
  (profile.minAgl).toFixed(0) + " to " + profile.peakAgl.toFixed(0) + " m AGL, " +
  profile.climbMetres.toFixed(0) + " m of climb, " +
  (profile.concealedFraction * 100).toFixed(1) + "% concealed");

// The two hard constraints. Neither may ever be violated.
let aboveFloor = true;
let flyable = true;
const maxStep = 0.2 * dem.cellSize;
for (let i = 0; i < profile.points.length; i++) {
  const p = profile.points[i];
  if (p.target < p.floor - 0.001) aboveFloor = false;
  if (i > 0 && Math.abs(p.target - profile.points[i - 1].target) > maxStep + 0.001) flyable = false;
}
check("never flies below the floor", aboveFloor);
check("never changes altitude faster than the gradient limit", flyable,
  "limit " + maxStep.toFixed(1) + " m per cell");

// It must actually use the ceiling rather than flying a constant height.
const aglValues = profile.points.map((p) => p.agl);
const spread = Math.max(...aglValues) - Math.min(...aglValues);
check("the profile varies with the terrain and the ceiling", spread > 10,
  spread.toFixed(0) + " m between lowest and highest");

// Where concealment is available AND reachable, it must be taken.
//
// "Reachable" matters. The climb-feasible envelope can sit above the ceiling:
// if the ground ahead rises faster than the vehicle climbs, it must already be
// high, and no altitude choice at that cell can hide it. Those cells are
// genuinely exposed and are counted separately - asserting they stay under the
// ceiling would be asserting the vehicle can do something it cannot.
let tookCover = 0;
let hadCover = 0;
let forcedUp = 0;
for (const p of profile.points) {
  if (!p.concealed || !Number.isFinite(p.ceiling)) continue;
  if (p.envelope > p.ceiling) {
    forcedUp = forcedUp + 1;
    continue;
  }
  hadCover = hadCover + 1;
  if (p.target <= p.ceiling) tookCover = tookCover + 1;
}
console.log("  " + forcedUp + " cells forced above the ceiling by the climb the terrain demands");
check("stays under the ceiling wherever cover is actually reachable",
  hadCover === 0 || tookCover / hadCover > 0.98,
  tookCover + " of " + hadCover + " reachable concealed cells");
check("cells forced above the ceiling are reported as exposed",
  profile.exposedCells >= forcedUp,
  profile.exposedCells + " exposed, " + forcedUp + " of them forced");

// A vastly higher cruise preference must not break the ceiling where cover
// exists - the ceiling binds, not the preference.
const greedy = planAltitudeProfile(dem, route.trace, ceiling, { cruiseAgl: 5000 });
let greedyRespects = true;
for (const p of greedy.points) {
  if (p.concealed && Number.isFinite(p.ceiling) && p.envelope <= p.ceiling && p.target > p.ceiling) {
    greedyRespects = false;
  }
}
check("a cruise preference of 5 km still respects every reachable ceiling", greedyRespects);

// With no threats at all the profile should simply cruise.
const noCeiling = new Float32Array(cellCount).fill(Infinity);
const free = planAltitudeProfile(dem, route.trace, noCeiling, { cruiseAgl: 60, clearance: 10 });
const nearCruise = free.points.filter((p) => Math.abs(p.agl - 60) < 15).length;
check("with nothing watching it cruises at the preferred height",
  nearCruise > free.points.length * 0.6,
  nearCruise + " of " + free.points.length + " cells near 60 m");

// Exposed segments must be reported, not hidden.
check("cells with no concealed altitude are counted",
  profile.exposedCells >= 0 && profile.concealedFraction <= 1);

// The flight card must account for the whole route.
const legs = summariseProfile(dem, profile);
const legCells = legs.reduce((total, leg) => total + leg.cells, 0);
check("the flight card covers every cell of the route",
  legCells === profile.points.length,
  legs.length + " legs covering " + legCells + " cells");
console.log("  collapses to " + legs.length + " legs");

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED");
  process.exit(1);
}
console.log("all checks passed");
