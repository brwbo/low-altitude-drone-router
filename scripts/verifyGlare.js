// Positive controls for approaching out of the sun.

import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, exposureCount } from "../src/viewshed.js";
import {
  computeGlare, computeGradedGlare, glareIntensity,
  weightedExposure, glareCoverage, isOptical,
} from "../src/glare.js";
import { solarPosition } from "../src/sun.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}
const pct = (f) => (f * 100).toFixed(1) + "%";

const dem = loadDemSync();
const centre = { x: 667, y: 630, type: "optical", mastHeight: 4, maxRangeMetres: 30000 };

console.log("\nGLARE  the wedge must point at the sun, from each observer");

// The mean bearing of dazzled cells, measured from the threat, must equal the
// sun's azimuth. This is the check that catches a sign or axis error - a
// fraction alone would look fine with the wedge pointing the wrong way.
function meanBearingOfGlare(glare) {
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  for (let y = 0; y < dem.height; y += 4) {
    for (let x = 0; x < dem.width; x += 4) {
      if (glare[y * dem.width + x] !== 1) continue;
      const east = x - centre.x;
      const north = -(y - centre.y);
      const len = Math.hypot(east, north);
      if (len < 5) continue;
      sumX = sumX + east / len;
      sumY = sumY + north / len;
      n = n + 1;
    }
  }
  if (n === 0) return null;
  let bearing = (Math.atan2(sumX, sumY) * 180) / Math.PI;
  if (bearing < 0) bearing = bearing + 360;
  return bearing;
}

let allAligned = true;
for (const azimuth of [0, 45, 90, 135, 180, 225, 270, 315]) {
  const glare = computeGlare(dem, centre, { azimuth: azimuth, elevation: 10 });
  const measured = meanBearingOfGlare(glare);
  // Math.abs(((a - b + 540) % 360) - 180) IS the angular difference. An
  // earlier version of this check inverted it again on the next line and
  // failed on a wedge that was correct to half a degree.
  const diff = measured === null ? 999 : Math.abs(((measured - azimuth + 540) % 360) - 180);
  if (diff > 3) {
    allAligned = false;
    console.log("    MISALIGNED: azimuth " + azimuth + " -> wedge at " +
      (measured === null ? "none" : measured.toFixed(1)) + " deg");
  }
}
check("the wedge points at the sun for all eight azimuths", allAligned);

// Wedge size must scale with the half angle.
const narrow = computeGlare(dem, centre, { azimuth: 90, elevation: 10 }, { halfAngleDeg: 5 });
const wide = computeGlare(dem, centre, { azimuth: 90, elevation: 10 }, { halfAngleDeg: 40 });
const count = (g) => { let n = 0; for (const v of g) if (v === 1) n++; return n; };
check("a wider wedge dazzles more ground", count(wide) > count(narrow) * 3,
  count(narrow) + " cells at 5 deg vs " + count(wide) + " at 40 deg");

// Roughly the expected share of a full circle.
const expected = (2 * 18) / 360;
const measured18 = count(computeGlare(dem, centre, { azimuth: 90, elevation: 10 })) / (dem.width * dem.height);
check("an 18 degree half-angle covers roughly a tenth of the map",
  Math.abs(measured18 - expected) < 0.03,
  pct(measured18) + " against an expected " + pct(expected));

// Sun height gates it.
check("a high sun dazzles nobody",
  count(computeGlare(dem, centre, { azimuth: 90, elevation: 60 })) === 0);
check("a sun below the horizon dazzles nobody",
  count(computeGlare(dem, centre, { azimuth: 90, elevation: -5 })) === 0);
check("a low sun does dazzle",
  count(computeGlare(dem, centre, { azimuth: 90, elevation: 8 })) > 0);

// Sensor type gates it. This is the point of carrying the type through.
console.log("\n  only optical sensors are affected");
for (const [type, shouldGlare] of [["optical", true], ["observer", true],
                                   ["radar", false], ["ew", false], ["thermal", false]]) {
  const threat = { x: 667, y: 630, type: type, maxRangeMetres: 30000 };
  const n = count(computeGlare(dem, threat, { azimuth: 90, elevation: 10 }));
  check("  " + type.padEnd(9) + (shouldGlare ? "is dazzled" : "is not affected"),
    shouldGlare ? n > 0 : n === 0, n + " cells");
}
check("isOptical agrees with the behaviour",
  isOptical({ type: "optical" }) && !isOptical({ type: "radar" }) && !isOptical({ type: "ew" }));

// Weighted exposure must sit between the discounted and undiscounted counts.
console.log("\n  weighted exposure stays bounded");
const sun = solarPosition(new Date("2026-08-15T15:00:00Z"), 48.17, 24.5);
const ceilings = [computeCeiling(dem, centre, { observerHeight: 4, maxRangeMetres: 30000 })];
const glares = [computeGlare(dem, centre, sun)];
const plain = exposureCount(dem, ceilings, 15);
const weighted = weightedExposure(dem, ceilings, glares, 15, { glareDiscount: 0.5 });

let bounded = true;
let anyDiscounted = false;
for (let i = 0; i < plain.length; i++) {
  if (weighted[i] > plain[i] + 1e-6) bounded = false;
  if (weighted[i] < plain[i] - 1e-6) anyDiscounted = true;
  if (weighted[i] < 0) bounded = false;
}
check("weighted exposure never exceeds the plain count", bounded);
check("some cells are actually discounted", anyDiscounted);

const noDiscount = weightedExposure(dem, ceilings, glares, 15, { glareDiscount: 0 });
let matchesPlain = true;
for (let i = 0; i < plain.length; i++) {
  if (Math.abs(noDiscount[i] - plain[i]) > 1e-6) matchesPlain = false;
}
check("a zero discount reproduces the plain count exactly", matchesPlain);

const clamped = weightedExposure(dem, ceilings, glares, 15, { glareDiscount: 99 });
let stillPositive = true;
for (let i = 0; i < clamped.length; i++) {
  if (clamped[i] < 0) stillPositive = false;
}
check("an absurd discount is clamped and never goes negative", stillPositive);

const cover = glareCoverage(dem, ceilings, glares, 15);
check("glare coverage is a valid fraction",
  cover.fraction >= 0 && cover.fraction <= 1 && cover.helpedCells <= cover.exposedCells,
  pct(cover.fraction) + " of " + cover.exposedCells + " exposed cells");

// Graded dazzle: strength must scale with how low the sun is, and taper off
// the sun's bearing. A flat in-or-out flag treated a blinding 3 degree sun the
// same as a mild 24 degree one; this is the fix, and these guard it.
console.log("\n  graded dazzle scales with sun height and bearing");

const lowSun = { azimuth: 90, elevation: 3 };
const highSun = { azimuth: 90, elevation: 22 };
check("a lower sun dazzles harder than a higher one",
  glareIntensity(lowSun) > glareIntensity(highSun),
  glareIntensity(lowSun).toFixed(2) + " vs " + glareIntensity(highSun).toFixed(2));
check("glare intensity is zero once the sun is above the cutoff",
  glareIntensity({ azimuth: 90, elevation: 30 }) === 0);
check("glare intensity is zero below the horizon",
  glareIntensity({ azimuth: 90, elevation: -2 }) === 0);

const gradedLow = computeGradedGlare(dem, centre, lowSun);
const gradedHigh = computeGradedGlare(dem, centre, highSun);
let maxLow = 0;
let maxHigh = 0;
for (let i = 0; i < gradedLow.length; i++) {
  if (gradedLow[i] > maxLow) maxLow = gradedLow[i];
  if (gradedHigh[i] > maxHigh) maxHigh = gradedHigh[i];
}
check("graded glare never exceeds 1", maxLow <= 1 && maxHigh <= 1,
  "peak " + maxLow.toFixed(2));
check("a low sun produces stronger peak dazzle than a high one", maxLow > maxHigh,
  maxLow.toFixed(2) + " vs " + maxHigh.toFixed(2));

// A cell dead on the sun's bearing must be dazzled harder than one at the edge
// of the wedge. Pick a cell due east of the threat (the sun's bearing) and one
// angled well off it but still inside the 18 degree wedge.
const onAxis = gradedLow[centre.y * dem.width + Math.min(dem.width - 1, centre.x + 40)];
const offAxisY = Math.max(0, centre.y - 12);
const offAxis = gradedLow[offAxisY * dem.width + Math.min(dem.width - 1, centre.x + 40)];
check("dead-centre on the sun dazzles harder than the wedge edge",
  onAxis > offAxis,
  onAxis.toFixed(2) + " on axis vs " + offAxis.toFixed(2) + " off axis");

const gradedThermal = computeGradedGlare(dem, { x: 667, y: 630, type: "thermal", mastHeight: 4 }, lowSun);
let thermalPeak = 0;
for (let i = 0; i < gradedThermal.length; i++) {
  if (gradedThermal[i] > thermalPeak) thermalPeak = gradedThermal[i];
}
check("a thermal threat is never dazzled, even at graded strength", thermalPeak === 0);

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
