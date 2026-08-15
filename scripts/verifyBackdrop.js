import { loadDemSync, findExtremes } from "../src/demNode.js";
import { computeCeiling } from "../src/viewshed.js";
import { computeBackdrop, backdropWeight, skylinedFraction } from "../src/backdrop.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}
const pct = (f) => (f * 100).toFixed(1) + "%";

const dem = loadDemSync();
const { summit, valley } = findExtremes(dem);

console.log("\nBACKDROP  sky silhouette versus terrain clutter");

const threat = { x: valley.x, y: valley.y };
const ceiling = computeCeiling(dem, threat, { observerHeight: 2 });

// Climbing must put more of the route against sky. This is the check that
// matters: it is the mechanism, and a broken sweep would not reproduce it.
let previous = -1;
let monotonic = true;
for (const agl of [5, 20, 60, 150, 400]) {
  const sky = computeBackdrop(dem, threat, agl, { observerHeight: 2 });
  const stat = skylinedFraction(dem, ceiling, sky, agl);
  console.log("  at " + String(agl).padStart(3) + " m AGL: " + pct(stat.fraction).padStart(6) +
    " of what it can see is silhouetted");
  if (previous >= 0 && stat.fraction < previous - 1e-9) monotonic = false;
  previous = stat.fraction;
}
check("flying higher silhouettes you more often", monotonic);

// From a summit looking down, almost everything has terrain behind it.
const fromSummit = computeBackdrop(dem, summit, 15, { observerHeight: 2 });
const summitCeiling = computeCeiling(dem, summit, { observerHeight: 2 });
const summitStat = skylinedFraction(dem, summitCeiling, fromSummit, 15);
console.log("  from the summit, " + pct(summitStat.fraction) + " silhouetted");
check("an observer on high ground mostly sees vehicles against terrain",
  summitStat.fraction < 0.35, pct(summitStat.fraction));

// Sanity: the grid is a valid mask and not degenerate either way.
let ones = 0;
for (const v of fromSummit) ones = ones + v;
check("the backdrop mask is not everything", ones < fromSummit.length);
check("the backdrop mask is not nothing", ones > 0);

// Very high up, everything visible must be against sky.
const veryHigh = computeBackdrop(dem, threat, 5000, { observerHeight: 2 });
const highStat = skylinedFraction(dem, ceiling, veryHigh, 5000);
check("at 5 km everything in view is silhouetted", highStat.fraction > 0.99,
  pct(highStat.fraction));

// The weighting must discount terrain backdrops and never invert.
const sample = new Uint8Array([1, 0]);
const skyW = backdropWeight(sample, 0);
const terrainW = backdropWeight(sample, 1);
console.log("  weight against sky " + skyW.toFixed(2) + ", against terrain " + terrainW.toFixed(2));
check("a silhouette weighs more than clutter", skyW > terrainW);
check("neither weight is negative", skyW >= 0 && terrainW >= 0);
check("a zero discount makes them equal",
  backdropWeight(sample, 0, { terrainDiscount: 0 }) === backdropWeight(sample, 1, { terrainDiscount: 0 }));
check("an absurd discount is clamped",
  backdropWeight(sample, 1, { terrainDiscount: 99 }) >= 0);

console.log("");
if (failures > 0) { console.log(failures + " CHECK(S) FAILED"); process.exit(1); }
console.log("all checks passed");
