// Repeater and observer siting for a search area.
//
// Usage:  node scripts/coverage.js [number of sites] [antenna height m]
//   node scripts/coverage.js 4 10

import fs from "node:fs";
import { loadDemSync } from "../src/demNode.js";
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";
import { candidateSites, selectSites, computeCoverage, coveredFraction } from "../src/coverage.js";
import { gridToLonLat } from "../src/coords.js";
import { encodePng, hillshadeRgb, blend } from "../src/png.js";

const siteCount = Number(process.argv[2] || 4);
const antennaHeight = Number(process.argv[3] || 10);

const dem = loadDemSync();
const cellCount = dem.width * dem.height;
const pct = (f) => (f * 100).toFixed(1) + "%";

// Search area: the middle of the map. Anything a team is expected to cover.
const areaMask = new Uint8Array(cellCount);
let areaCells = 0;
for (let y = 200; y < dem.height - 200; y++) {
  for (let x = 200; x < dem.width - 200; x++) {
    areaMask[y * dem.width + x] = 1;
    areaCells = areaCells + 1;
  }
}

// Equipment has to be carried in, so candidates are limited to ground a team
// on foot could actually reach. Reusing the UGV slope model for that.
const slope = computeSlope(dem);
const reachable = computeTrafficable(dem, VEHICLES.ugvTracked, slope);
const candidates = candidateSites(dem, 70, reachable);

console.log("\n=== REPEATER / OBSERVER SITING ===");
console.log("search area   " + (areaCells * 900 / 1e6).toFixed(0) + " km2");
console.log("antenna       " + antennaHeight + " m, handheld at 1.5 m, 15 km range");
console.log("candidates    " + candidates.length + " reachable positions on a 2.1 km lattice");

const started = Date.now();
const result = selectSites(dem, candidates, siteCount, {
  antennaHeight: antennaHeight,
  receiverHeight: 1.5,
  maxRangeMetres: 15000,
  areaMask: areaMask,
});
console.log("solved in     " + ((Date.now() - started) / 1000).toFixed(1) + " s\n");

console.log("--- greedy maximum coverage ---");
console.log(
  "site".padEnd(6) + "position".padEnd(22) + "elev".padStart(7) +
  "adds".padStart(9) + "cumulative".padStart(13)
);
for (let i = 0; i < result.sites.length; i++) {
  const entry = result.sites[i];
  const ll = gridToLonLat(dem, entry.site.x, entry.site.y);
  console.log(
    ("#" + (i + 1)).padEnd(6) +
    (ll.lat.toFixed(4) + ", " + ll.lon.toFixed(4)).padEnd(22) +
    (entry.elevation + " m").padStart(7) +
    pct(entry.newlyCoveredFraction).padStart(9) +
    pct(entry.cumulativeFraction).padStart(13)
  );
}

const finalCoverage = result.sites.length > 0
  ? result.sites[result.sites.length - 1].cumulativeFraction
  : 0;
console.log(
  "\n" + result.sites.length + " sites cover " + pct(finalCoverage) +
  " of the search area. " + pct(1 - finalCoverage) + " stays dark."
);

// A single site placed naively, for comparison. The centre of the area is the
// obvious choice and it is usually a bad one.
const centre = { x: Math.round(dem.width / 2), y: Math.round(dem.height / 2) };
const naive = computeCoverage(dem, centre, {
  antennaHeight: antennaHeight,
  receiverHeight: 1.5,
  maxRangeMetres: 15000,
});
console.log(
  "for comparison, one site at the centre of the area covers " +
  pct(coveredFraction(naive, areaMask)) + " on its own; the first chosen site covers " +
  pct(result.sites[0].newlyCoveredFraction)
);

// --- render ---------------------------------------------------------------
const rgb = hillshadeRgb(dem);
for (let i = 0; i < cellCount; i++) {
  if (areaMask[i] === 0) {
    blend(rgb, i, 0, 0, 0, 0.45);
    continue;
  }
  if (result.covered[i] === 1) {
    blend(rgb, i, 40, 190, 90, 0.38);
  } else {
    blend(rgb, i, 210, 40, 40, 0.42);
  }
}
function stamp(x, y, r, g, b, radius) {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const px = x + dx;
      const py = y + dy;
      if (px < 0 || py < 0 || px >= dem.width || py >= dem.height) continue;
      if (dx * dx + dy * dy > radius * radius) continue;
      blend(rgb, py * dem.width + px, r, g, b, 1);
    }
  }
}
for (const entry of result.sites) {
  stamp(entry.site.x, entry.site.y, 255, 255, 255, 9);
  stamp(entry.site.x, entry.site.y, 20, 70, 220, 6);
}
fs.writeFileSync("data/coverage.png", encodePng(dem.width, dem.height, rgb));
console.log("\nwrote data/coverage.png  (green = in contact, red = no link, blue = chosen sites)");
