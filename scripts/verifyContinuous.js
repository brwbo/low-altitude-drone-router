// Longest continuous exposure, as distinct from total exposure.

import { loadDemSync } from "../src/demNode.js";
import { findPath } from "../src/pathfind.js";
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}

const dem = loadDemSync();
const cellCount = dem.width * dem.height;
const vehicle = VEHICLES.quadLow;
const passable = computeTrafficable(dem, vehicle, computeSlope(dem));
const S = { x: 568, y: 669 };
const G = { x: 482, y: 276 };

console.log("\nCONTINUOUS EXPOSURE");

// Nothing exposed at all: every derived figure must be zero, not undefined.
const clean = findPath(dem, S, G,
  { passable: passable, exposure: new Uint8Array(cellCount), elev: dem.elev }, { vehicle });
check("no exposure gives a zero longest run", clean.longestExposedRun === 0);
check("no exposure gives no breaks", clean.exposureBreaks === 0);

// Everything exposed: the longest run must equal the total, with no breaks.
const allSeen = new Uint8Array(cellCount).fill(1);
const soaked = findPath(dem, S, G,
  { passable: passable, exposure: allSeen, elev: dem.elev }, { vehicle });
check("constant exposure makes the longest run equal the total",
  Math.abs(soaked.longestExposedRun - soaked.exposedSeconds) < 0.001,
  soaked.longestExposedRun.toFixed(0) + "s of " + soaked.exposedSeconds.toFixed(0) + "s");
check("constant exposure has no breaks", soaked.exposureBreaks === 0);

// Striped exposure: same total, many breaks, much shorter longest run. This is
// the case the metric exists for - total alone cannot tell the two apart.
const striped = new Uint8Array(cellCount);
for (let i = 0; i < cellCount; i++) {
  striped[i] = Math.floor(i / dem.width) % 6 < 3 ? 1 : 0;
}
const broken = findPath(dem, S, G,
  { passable: passable, exposure: striped, elev: dem.elev }, { vehicle });
console.log("  striped: " + broken.exposedSeconds.toFixed(0) + "s total in " +
  broken.exposureBreaks + " bursts, longest " + broken.longestExposedRun.toFixed(0) + "s");
check("broken exposure has a longest run well below its total",
  broken.longestExposedRun < broken.exposedSeconds * 0.5,
  broken.longestExposedRun.toFixed(0) + "s of " + broken.exposedSeconds.toFixed(0) + "s");
check("broken exposure records the breaks", broken.exposureBreaks > 1);

// Invariants that must hold for any route.
check("longest run never exceeds total exposure",
  broken.longestExposedRun <= broken.exposedSeconds + 0.001);
check("total exposure never exceeds journey time",
  broken.exposedSeconds <= broken.seconds + 0.001);

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED");
  process.exit(1);
}
console.log("all checks passed");
