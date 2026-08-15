import { loadDemSync, findExtremes } from "../src/demNode.js";
import { computeCeiling } from "../src/viewshed.js";
import { receivedLevel, audibleRange, computeAudibility, assessAcoustic,
         sourceLevelFor, BARRIER_LOSS_DB, DEFAULT_AMBIENT_DB } from "../src/acoustic.js";
import { findPath } from "../src/pathfind.js";
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}

const dem = loadDemSync();
const cellCount = dem.width * dem.height;

console.log("\nACOUSTIC");

// Spherical spreading: exactly 6 dB per doubling of distance.
const at100 = receivedLevel(88, 100, false);
const at200 = receivedLevel(88, 200, false);
const at400 = receivedLevel(88, 400, false);
console.log("  88 dB source: " + at100.toFixed(1) + " dB at 100 m, " +
  at200.toFixed(1) + " at 200 m, " + at400.toFixed(1) + " at 400 m");
check("doubling the distance costs 6 dB", Math.abs((at100 - at200) - 6.02) < 0.05);
check("and again at the next doubling", Math.abs((at200 - at400) - 6.02) < 0.05);
check("terrain in the way costs the barrier loss",
  Math.abs(receivedLevel(88, 100, false) - receivedLevel(88, 100, true) - BARRIER_LOSS_DB) < 0.001);

// Audible range must follow from the same arithmetic, both ways.
const openRange = audibleRange(88, DEFAULT_AMBIENT_DB, false);
const blockedRange = audibleRange(88, DEFAULT_AMBIENT_DB, true);
console.log("  audible to " + openRange.toFixed(0) + " m in the open, " +
  blockedRange.toFixed(0) + " m with terrain between");
check("terrain shortens the audible range", blockedRange < openRange);
check("audible range agrees with the level model",
  Math.abs(receivedLevel(88, openRange, false) - DEFAULT_AMBIENT_DB) < 0.01);
check("a source quieter than the background is never audible",
  audibleRange(30, 38, false) === 0);

// Louder platforms carry further, and the ordering must be sensible.
check("a cargo quad is louder than a porter",
  sourceLevelFor(VEHICLES.cargoQuad) > sourceLevelFor(VEHICLES.porter));
check("a wheeled UGV is quieter than a tracked one",
  sourceLevelFor(VEHICLES.ugvWheeled) < sourceLevelFor(VEHICLES.ugvTracked));

// The field: audible near, inaudible far, and terrain must matter.
const { valley } = findExtremes(dem);
const listener = { x: valley.x, y: valley.y };
const ceiling = computeCeiling(dem, listener, { observerHeight: 1.7 });
const vehicle = VEHICLES.quadLow;
const field = computeAudibility(dem, listener, ceiling, vehicle);

check("the vehicle is audible directly overhead", field.audible[listener.y * dem.width + listener.x] === 1);
let audibleCells = 0;
for (const v of field.audible) audibleCells = audibleCells + v;
console.log("  " + ((audibleCells / cellCount) * 100).toFixed(2) +
  "% of the map is within earshot of one listener");
check("most of the map is out of earshot", audibleCells < cellCount * 0.5);
check("some of it is within earshot", audibleCells > 0);

// A quieter ambient must extend the audible area, never shrink it.
const quiet = computeAudibility(dem, listener, ceiling, vehicle, { ambientDb: 25 });
let quietCells = 0;
for (const v of quiet.audible) quietCells = quietCells + v;
check("a quieter background makes the vehicle audible further",
  quietCells >= audibleCells,
  quietCells + " cells at 25 dB vs " + audibleCells + " at " + DEFAULT_AMBIENT_DB);

// Along a route.
const passable = computeTrafficable(dem, vehicle, computeSlope(dem));
const route = findPath(dem, { x: 568, y: 669 }, { x: 482, y: 276 },
  { passable: passable, exposure: new Uint8Array(cellCount), elev: dem.elev }, { vehicle });
const heard = assessAcoustic(dem, route.trace, [field.audible], vehicle.speed);
check("audible fraction is a valid proportion",
  heard.audibleFraction >= 0 && heard.audibleFraction <= 1);
check("the longest audible run never exceeds the total",
  heard.longestAudibleRun <= heard.audibleSeconds + 0.001);

console.log("");
if (failures > 0) { console.log(failures + " CHECK(S) FAILED"); process.exit(1); }
console.log("all checks passed");
