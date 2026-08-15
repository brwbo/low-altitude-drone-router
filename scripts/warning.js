// Civilian early warning: where do spotters go to buy the most time?
//
// Usage:  node scripts/warning.js [observers] [drone altitude m ASL]
//   node scripts/warning.js 4 1200

import fs from "node:fs";
import { loadDemSync } from "../src/demNode.js";
import { gridToLonLat } from "../src/coords.js";
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";
import { candidateSites } from "../src/coverage.js";
import { selectObservers, warningFromTownItself, DEFAULT_CRUISE_SPEED } from "../src/warning.js";
import { encodePng, hillshadeRgb, blend } from "../src/png.js";

const observerCount = Number(process.argv[2] || 4);
const droneAltitude = Number(process.argv[3] || 1200);

const dem = loadDemSync();
const cellCount = dem.width * dem.height;

const NAMES = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const mmss = (s) => Math.floor(s / 60) + "m " + String(Math.round(s % 60)).padStart(2, "0") + "s";

// Put the town on low ground, which is where towns are and which is also the
// hardest case: a settlement in a valley sees nothing coming.
let townIndex = 0;
for (let y = 300; y < dem.height - 300; y++) {
  for (let x = 300; x < dem.width - 300; x++) {
    const i = y * dem.width + x;
    if (dem.elev[i] < dem.elev[townIndex] || townIndex === 0) {
      townIndex = i;
    }
  }
}
const town = { x: townIndex % dem.width, y: Math.floor(townIndex / dem.width) };
const townLl = gridToLonLat(dem, town.x, town.y);

const options = {
  droneAltitudeMetres: droneAltitude,
  sensorRangeMetres: 15000,
  maxRangeMetres: 18000,
  observerHeight: 1.7,
  cruiseSpeed: DEFAULT_CRUISE_SPEED,
};

console.log("\n=== CIVILIAN EARLY WARNING ===");
console.log("town            " + townLl.lat.toFixed(4) + ", " + townLl.lon.toFixed(4) +
  " at " + dem.elev[townIndex] + " m");
console.log("incoming drone  " + droneAltitude + " m above sea level, " +
  options.cruiseSpeed + " m/s assumed cruise");
console.log("observers see   15 km, standing at 1.7 m");
console.log("approaches      8 bearings out to 18 km");
console.log("\nNOTE: cruise speed is a planning placeholder, not a measured figure.");
console.log("Every warning time below scales directly with it.\n");

// --- the baseline ---------------------------------------------------------
const baseline = warningFromTownItself(dem, town, options);
console.log("--- one observer standing in the town ---");
console.log("  worst approach " + mmss(baseline.worstWarningSeconds) +
  ",  average " + mmss(baseline.meanWarningSeconds));

// --- siting ---------------------------------------------------------------
const slope = computeSlope(dem);
const reachable = computeTrafficable(dem, VEHICLES.ugvTracked, slope);
const candidates = candidateSites(dem, 60, reachable);
console.log("\n  " + candidates.length + " reachable candidate positions");

const started = Date.now();
const result = selectObservers(dem, town, candidates, observerCount, options);
console.log("  solved in " + ((Date.now() - started) / 1000).toFixed(1) + " s\n");

console.log("--- greedy on worst-case warning time ---");
console.log("obs".padEnd(5) + "position".padEnd(22) + "elev".padStart(7) +
  "worst".padStart(10) + "average".padStart(10));
for (let i = 0; i < result.sites.length; i++) {
  const entry = result.sites[i];
  const ll = gridToLonLat(dem, entry.site.x, entry.site.y);
  console.log(
    ("#" + (i + 1)).padEnd(5) +
    (ll.lat.toFixed(4) + ", " + ll.lon.toFixed(4)).padEnd(22) +
    (entry.elevation + " m").padStart(7) +
    mmss(entry.worstWarningSeconds).padStart(10) +
    mmss(entry.meanWarningSeconds).padStart(10)
  );
}

console.log("\n--- warning by approach bearing ---");
for (let i = 0; i < result.approaches.length; i++) {
  const seconds = result.detectionByBearing[i] / result.cruiseSpeed;
  const bar = "#".repeat(Math.round(seconds / 8));
  console.log(
    "  " + NAMES[i].padEnd(3) +
    (result.detectionByBearing[i] / 1000).toFixed(1).padStart(6) + " km  " +
    mmss(seconds).padStart(8) + "  " + bar
  );
}

const gain = result.worstWarningSeconds - baseline.worstWarningSeconds;
console.log(
  "\n" + result.sites.length + " observers give the town " + mmss(result.worstWarningSeconds) +
  " on its worst approach, against " + mmss(baseline.worstWarningSeconds) +
  " from the town itself."
);
console.log("That is " + mmss(gain) + " more time to reach shelter, from " +
  result.sites.length + " people standing in the right places.");

// --- render ---------------------------------------------------------------
const rgb = hillshadeRgb(dem);
for (const approach of result.approaches) {
  for (const point of approach.points) {
    blend(rgb, point.index, 235, 170, 30, 0.5);
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
  stamp(entry.site.x, entry.site.y, 30, 110, 230, 6);
}
stamp(town.x, town.y, 255, 255, 255, 12);
stamp(town.x, town.y, 20, 160, 60, 8);

fs.writeFileSync("data/warning.png", encodePng(dem.width, dem.height, rgb));
console.log("\nwrote data/warning.png  (green = town, blue = observers, orange = approach rays)\n");
