// Positive controls for the two adaptations: coverage siting and
// chronolocation. Both are arranged so a broken implementation produces a
// visibly wrong answer rather than a plausible one.

import { loadDemSync, findExtremes } from "../src/demNode.js";
import { computeCoverage, coveredFraction, candidateSites, selectSites } from "../src/coverage.js";
import { expectedAt, checkClaim, shadowBearingFromSun, elevationFromShadowRatio } from "../src/chrono.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}
const pct = (f) => (f * 100).toFixed(1) + "%";

const dem = loadDemSync();
const { summit, valley } = findExtremes(dem);

// ---------------------------------------------------------------- coverage
console.log("\nCOVERAGE  siting must prefer ground that actually sees the area");

const opts = { antennaHeight: 10, receiverHeight: 1.5, maxRangeMetres: 15000 };
const summitCoverage = computeCoverage(dem, summit, opts);
const valleyCoverage = computeCoverage(dem, valley, opts);
const summitReach = coveredFraction(summitCoverage, null);
const valleyReach = coveredFraction(valleyCoverage, null);

console.log("  repeater on the summit covers " + pct(summitReach));
console.log("  repeater on the valley floor covers " + pct(valleyReach));
check("high ground covers far more than a valley floor", summitReach > valleyReach * 5,
  pct(summitReach) + " vs " + pct(valleyReach));

// A taller antenna must never reduce coverage, and on a summit it must help.
const tall = coveredFraction(computeCoverage(dem, summit, { ...opts, antennaHeight: 40 }), null);
check("a taller antenna covers at least as much", tall >= summitReach,
  pct(tall) + " at 40 m vs " + pct(summitReach) + " at 10 m");

// Greedy selection must beat placing a site at the geometric centre. This is
// the claim the whole module rests on, so it is the one worth testing.
const centre = { x: Math.round(dem.width / 2), y: Math.round(dem.height / 2) };
const centreReach = coveredFraction(computeCoverage(dem, centre, opts), null);
const candidates = candidateSites(dem, 120, null);
const chosen = selectSites(dem, candidates, 1, opts);
const greedyReach = chosen.sites[0].newlyCoveredFraction;
console.log("  centre of the map covers " + pct(centreReach) +
  ", greedy first pick covers " + pct(greedyReach));
check("greedy beats placing a site at the centre", greedyReach > centreReach,
  pct(greedyReach) + " vs " + pct(centreReach));

// Each additional site must add coverage, and add less than the one before it.
const four = selectSites(dem, candidates, 4, opts);
let diminishing = true;
for (let i = 1; i < four.sites.length; i++) {
  if (four.sites[i].newlyCovered > four.sites[i - 1].newlyCovered) {
    diminishing = false;
  }
}
console.log("  four sites add " +
  four.sites.map((s) => pct(s.newlyCoveredFraction)).join(", "));
check("returns diminish with each extra site", diminishing);
check("cumulative coverage increases", four.sites[3].cumulativeFraction > four.sites[0].cumulativeFraction);

// --------------------------------------------------------- chronolocation
console.log("\nCHRONOLOCATION  a derived observation must round-trip");

const lat = 50.4501;
const lon = 30.5234;
const truth = "2026-08-15T14:00:00Z";

// The observation is DERIVED from the truth rather than invented, so the test
// exercises the consistent path. Inventing plausible-looking numbers only ever
// tests the rejection path, which is the easy half.
const expected = expectedAt(new Date(truth), lat, lon);
const observed = {
  shadowBearingDeg: expected.shadowBearing,
  shadowLengthRatio: expected.shadowLengthRatio,
};
console.log("  truth " + truth + " gives shadow " + expected.shadowBearing.toFixed(1) +
  " deg at " + expected.shadowLengthRatio.toFixed(3) + "x height");

const atTruth = checkClaim({ lat, lon, timeUtc: truth }, observed);
check("the true time is judged consistent", atTruth.consistent === true);

const lie = checkClaim({ lat, lon, timeUtc: "2026-08-15T11:00:00Z" }, observed);
check("a three hour error is judged inconsistent", lie.consistent === false);

// And it must recover the real time, not merely reject the wrong one.
let recovered = false;
for (const window of lie.alternativeWindows) {
  const target = new Date(truth).getTime();
  if (window.start.getTime() <= target && target <= window.end.getTime()) {
    recovered = true;
    console.log("  recovered window " + window.start.toISOString().slice(11, 16) +
      " to " + window.end.toISOString().slice(11, 16) + " UTC brackets the true time");
  }
}
check("the true time is recovered from the shadow alone", recovered);

// Wrong hemisphere must fail even with the right clock time.
const wrongPlace = checkClaim({ lat: -33.9, lon: 151.2, timeUtc: truth }, observed);
check("the same shadow is inconsistent in Sydney", wrongPlace.consistent === false);

// Night must be rejected outright.
const night = checkClaim({ lat, lon, timeUtc: "2026-08-15T01:00:00Z" }, observed);
check("a night-time claim is rejected", night.consistent === false);

// Shadow geometry must invert cleanly.
const ratio = 1.729;
const impliedElevation = elevationFromShadowRatio(ratio);
console.log("  a shadow " + ratio + "x height implies a sun " + impliedElevation.toFixed(1) + " deg up");
check("shadow ratio inverts to the right elevation",
  Math.abs(impliedElevation - expected.sunElevation) < 0.5,
  impliedElevation.toFixed(2) + " vs " + expected.sunElevation.toFixed(2));
check("shadow bearing is opposite the sun",
  Math.abs(((shadowBearingFromSun(expected.sunAzimuth) - expected.sunAzimuth + 360) % 360) - 180) < 0.01);

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
