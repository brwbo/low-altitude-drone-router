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

// ------------------------------------------------------------ early warning
console.log("\nEARLY WARNING  observers must buy time the town cannot buy itself");

const { selectObservers, warningFromTownItself } = await import("../src/warning.js");

// Town on low ground, which is the hard case and where towns actually are.
let townIndex = 400 * dem.width + 400;
for (let y = 300; y < dem.height - 300; y += 2) {
  for (let x = 300; x < dem.width - 300; x += 2) {
    const i = y * dem.width + x;
    if (dem.elev[i] < dem.elev[townIndex]) townIndex = i;
  }
}
const town = { x: townIndex % dem.width, y: Math.floor(townIndex / dem.width) };
const warnOpts = { droneAltitudeMetres: 1200, sensorRangeMetres: 15000, maxRangeMetres: 18000 };

const baseline = warningFromTownItself(dem, town, warnOpts);
const spotters = candidateSites(dem, 110, null);
const sited = selectObservers(dem, town, spotters, 3, warnOpts);

console.log("  town at " + dem.elev[townIndex] + " m sees itself " +
  baseline.worstWarningSeconds.toFixed(0) + " s of warning on its worst approach");
console.log("  3 sited observers give " + sited.worstWarningSeconds.toFixed(0) + " s");
check("sited observers beat standing in the town", sited.worstWarningSeconds > baseline.worstWarningSeconds,
  sited.worstWarningSeconds.toFixed(0) + " s vs " + baseline.worstWarningSeconds.toFixed(0) + " s");

// Worst case can never exceed the average. Catches a sign or index slip.
check("worst approach is no better than the average",
  sited.worstWarningSeconds <= sited.meanWarningSeconds + 0.001,
  sited.worstWarningSeconds.toFixed(0) + " s worst vs " + sited.meanWarningSeconds.toFixed(0) + " s mean");

// A drone flying HIGHER clears the terrain sooner and is seen further out, so
// warning must increase with altitude. An inverted ceiling test fails this.
const low = selectObservers(dem, town, spotters, 3, { ...warnOpts, droneAltitudeMetres: 800 });
const high = selectObservers(dem, town, spotters, 3, { ...warnOpts, droneAltitudeMetres: 2500 });
console.log("  drone at  800 m -> " + low.meanWarningSeconds.toFixed(0) + " s average warning");
console.log("  drone at 2500 m -> " + high.meanWarningSeconds.toFixed(0) + " s average warning");
check("a higher drone is detected further out", high.meanWarningSeconds > low.meanWarningSeconds,
  high.meanWarningSeconds.toFixed(0) + " s vs " + low.meanWarningSeconds.toFixed(0) + " s");

// Each extra observer must never reduce warning, since the network takes the
// earliest acquisition.
let monotonic = true;
for (let i = 1; i < sited.sites.length; i++) {
  if (sited.sites[i].worstWarningSeconds < sited.sites[i - 1].worstWarningSeconds - 0.001) {
    monotonic = false;
  }
}
check("adding an observer never reduces warning", monotonic);

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
