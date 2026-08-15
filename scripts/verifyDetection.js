// Detection must fall off with range rather than stopping at a cliff.

import { loadDemSync } from "../src/demNode.js";
import { computeCeiling } from "../src/viewshed.js";
import { detectionStrength, confidentRangeFor, computeDetectionField, rangeWeightedExposure }
  from "../src/detection.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}

const dem = loadDemSync();
const threat = { x: 667, y: 630, type: "optical", mastHeight: 10, maxRangeMetres: 20000 };
const confident = confidentRangeFor(threat);

console.log("\nDETECTION FALLOFF");
console.log("  max range " + (threat.maxRangeMetres / 1000) + " km, confident inside " +
  (confident / 1000) + " km");

check("detection is certain inside the confident range",
  detectionStrength(confident * 0.5, confident, 20000) === 1);
check("detection is still certain exactly at it",
  detectionStrength(confident, confident, 20000) === 1);
check("detection is zero beyond the maximum",
  detectionStrength(20001, confident, 20000) === 0);

// The shape is the point: it must fall, and fall as an inverse square.
const at2x = detectionStrength(confident * 2, confident, 20000);
const at4x = detectionStrength(confident * 4, confident, 20000);
console.log("  at 2x confident range: " + at2x.toFixed(3) + ", at 4x: " + at4x.toFixed(3));
check("doubling the range quarters the strength", Math.abs(at2x - 0.25) < 0.001);
check("quadrupling it drops by sixteen", Math.abs(at4x - 0.0625) < 0.001);
check("strength decreases monotonically with range",
  at2x < 1 && at4x < at2x);

// Never outside 0..1, at any range.
let bounded = true;
for (let r = 0; r <= 30000; r += 250) {
  const v = detectionStrength(r, confident, 20000);
  if (v < 0 || v > 1) bounded = false;
}
check("strength stays within 0 and 1 at every range", bounded);

// A threat may state its own confident range.
check("a stated confident range is honoured",
  confidentRangeFor({ maxRangeMetres: 20000, confidentRangeMetres: 3000 }) === 3000);
check("an absent one falls back to a quarter of the maximum",
  confidentRangeFor({ maxRangeMetres: 20000 }) === 5000);

// The field must be strongest at the threat and weakest far away.
const field = computeDetectionField(dem, threat);
const atThreat = field[threat.y * dem.width + threat.x];
const farCorner = field[0];
console.log("  field at the sensor: " + atThreat.toFixed(3) + ", at the far corner: " +
  farCorner.toFixed(3));
check("the field is strongest at the sensor", atThreat === 1);
check("the field is weaker far away", farCorner < atThreat);

// The whole point: weighted exposure must be lower than a plain count, because
// most of a sensor's nominal range is not a place it detects things well.
const ceilings = [computeCeiling(dem, threat, { observerHeight: 10, maxRangeMetres: 20000 })];
const weighted = rangeWeightedExposure(dem, [threat], ceilings, 15);

let seenCells = 0;
let weightSum = 0;
for (let i = 0; i < weighted.length; i++) {
  if (dem.elev[i] + 15 > ceilings[0][i]) seenCells = seenCells + 1;
  weightSum = weightSum + weighted[i];
}
console.log("  " + seenCells + " cells in view, total detection weight " + weightSum.toFixed(0));
check("weighted exposure is well below a flat count", weightSum < seenCells * 0.6,
  weightSum.toFixed(0) + " against " + seenCells + " if range were ignored");
check("no cell is ever weighted above the threat count",
  weighted.every((w) => w <= 1.0001));

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED");
  process.exit(1);
}
console.log("all checks passed");
