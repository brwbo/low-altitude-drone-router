// Headless proof that the spine is correct, before any UI exists.
//
// Every check here is a positive control: it is arranged so that a broken
// implementation produces a visibly wrong number rather than a plausible one.
// A pretty red overlay on a map cannot tell you the sweep is working; these can.

import { loadDemSync, findExtremes } from "../src/demNode.js";
import { computeCeiling, combineCeilings } from "../src/viewshed.js";
import { computeFloor, computeHeadroom, passableFraction, hiddenFraction } from "../src/corridor.js";

let failures = 0;

function check(label, passed, detail) {
  const mark = passed ? "PASS" : "FAIL";
  if (!passed) {
    failures = failures + 1;
  }
  console.log("  [" + mark + "] " + label + (detail ? "  " + detail : ""));
}

function pct(fraction) {
  return (fraction * 100).toFixed(1) + "%";
}

// ---------------------------------------------------------------- step 2
console.log("\nSTEP 2  DEM loads and the numbers match dem.json");

const dem = loadDemSync();
const cellCount = dem.width * dem.height;

let observedMin = dem.elev[0];
let observedMax = dem.elev[0];
for (let i = 1; i < dem.elev.length; i++) {
  if (dem.elev[i] < observedMin) observedMin = dem.elev[i];
  if (dem.elev[i] > observedMax) observedMax = dem.elev[i];
}

console.log("  grid " + dem.width + " x " + dem.height + " at " + dem.cellSize + " m");
check("cell count matches", dem.elev.length === cellCount, dem.elev.length + " cells");
check(
  "min elevation matches metadata",
  observedMin === dem.minElevation,
  "read " + observedMin + " m, expected " + dem.minElevation + " m"
);
check(
  "max elevation matches metadata",
  observedMax === dem.maxElevation,
  "read " + observedMax + " m, expected " + dem.maxElevation + " m"
);

// ---------------------------------------------------------------- step 3
console.log("\nSTEP 3  Viewshed positive control: a summit must see far more than a valley floor");

const { summit, valley } = findExtremes(dem);
console.log(
  "  summit at " + summit.x + "," + summit.y +
  " (" + dem.elev[summit.y * dem.width + summit.x] + " m)   " +
  "valley at " + valley.x + "," + valley.y +
  " (" + dem.elev[valley.y * dem.width + valley.x] + " m)"
);

function seenFractionOnGround(dem, ceiling, agl) {
  let seen = 0;
  for (let i = 0; i < ceiling.length; i++) {
    if (dem.elev[i] + agl > ceiling[i]) {
      seen = seen + 1;
    }
  }
  return seen / ceiling.length;
}

const startedAt = Date.now();
const summitCeiling = computeCeiling(dem, summit, { observerHeight: 2 });
const sweepMs = Date.now() - startedAt;
const valleyCeiling = computeCeiling(dem, valley, { observerHeight: 2 });

const summitSeen = seenFractionOnGround(dem, summitCeiling, 30);
const valleySeen = seenFractionOnGround(dem, valleyCeiling, 30);

console.log("  one sweep took " + sweepMs + " ms");
console.log("  summit sees " + pct(summitSeen) + " of the map at 30 m AGL");
console.log("  valley sees " + pct(valleySeen) + " of the map at 30 m AGL");
check("summit sees more than valley", summitSeen > valleySeen);
check("summit sees a substantial share", summitSeen > 0.10, pct(summitSeen));
check("valley is genuinely enclosed", valleySeen < summitSeen / 2, pct(valleySeen));

// ---------------------------------------------------------------- step 4
console.log("\nSTEP 4  Flying higher must expose you more");

const floor = computeFloor(dem, { clearance: 10 });
const headroom = computeHeadroom(floor, summitCeiling);

const hidden30 = hiddenFraction(dem, summitCeiling, 30);
const hidden80 = hiddenFraction(dem, summitCeiling, 80);
const hidden150 = hiddenFraction(dem, summitCeiling, 150);

console.log("  hidden at  30 m AGL: " + pct(hidden30));
console.log("  hidden at  80 m AGL: " + pct(hidden80));
console.log("  hidden at 150 m AGL: " + pct(hidden150));
check("30 m hides more than 80 m", hidden30 > hidden80);
check("80 m hides more than 150 m", hidden80 > hidden150);
console.log("  passable (positive headroom): " + pct(passableFraction(headroom)));

// ---------------------------------------------------------------- step 5
console.log("\nSTEP 5  A second commanding position must materially cut cover");

// "Cover never increases" would be a tautology - combineCeilings takes a
// minimum, so it cannot fail however broken the sweep is. The check that
// carries information is that a SECOND HIGH position removes a substantial
// amount of cover. A sweep that silently returns nothing useful fails this.
function highestCellFarFrom(dem, origin, minCellsAway) {
  let bestIndex = -1;
  for (let i = 0; i < dem.elev.length; i++) {
    const x = i % dem.width;
    const y = Math.floor(i / dem.width);
    if (Math.hypot(x - origin.x, y - origin.y) < minCellsAway) {
      continue;
    }
    if (bestIndex === -1 || dem.elev[i] > dem.elev[bestIndex]) {
      bestIndex = i;
    }
  }
  return { x: bestIndex % dem.width, y: Math.floor(bestIndex / dem.width) };
}

const secondThreat = highestCellFarFrom(dem, summit, 400);
console.log(
  "  second threat at " + secondThreat.x + "," + secondThreat.y +
  " (" + dem.elev[secondThreat.y * dem.width + secondThreat.x] + " m), " +
  Math.round(Math.hypot(secondThreat.x - summit.x, secondThreat.y - summit.y) * dem.cellSize / 1000) +
  " km from the first"
);

const secondCeiling = computeCeiling(dem, secondThreat, { observerHeight: 2 });
const combined = combineCeilings([summitCeiling, secondCeiling], cellCount);

const hiddenOne = hiddenFraction(dem, summitCeiling, 30);
const hiddenBoth = hiddenFraction(dem, combined, 30);
const lost = hiddenOne - hiddenBoth;
console.log("  hidden from 1 threat at 30 m: " + pct(hiddenOne));
console.log("  hidden from 2 threats at 30 m: " + pct(hiddenBoth));
console.log("  cover removed by the second threat: " + pct(lost));
check("second threat removes real cover", lost > 0.05, pct(lost) + " removed, need > 5.0%");
check("some cover still survives two threats", hiddenBoth > 0.10, pct(hiddenBoth));

// ---------------------------------------------------------------- step 6
console.log("\nSTEP 6  Endurance check must reject what the platform cannot do");

const { VEHICLES, checkEndurance } = await import("../src/vehicles.js");
const quad = VEHICLES.quadLow;

// A route inside the level range with no climbing must be feasible; one well
// beyond it must not be. Asserting only one direction would pass on a function
// that always returned the same answer.
const shortRoute = { metres: 5000, ascentMetres: 0 };
const longRoute = { metres: 200000, ascentMetres: 0 };
const shortResult = checkEndurance(shortRoute, quad);
const longResult = checkEndurance(longRoute, quad);

console.log("  " + quad.label + " level range: " + (shortResult.levelRangeMetres / 1000).toFixed(1) + " km");
check("5 km route is feasible", shortResult.feasible === true);
check("200 km route is not feasible", longResult.feasible === false);

// Climbing must consume endurance. Same distance, different ascent.
const flat = checkEndurance({ metres: 15000, ascentMetres: 0 }, quad);
const hilly = checkEndurance({ metres: 15000, ascentMetres: 1200 }, quad);
console.log(
  "  15 km flat needs " + (flat.requiredSeconds / 60).toFixed(0) +
  " min, same distance with 1200 m of climb needs " + (hilly.requiredSeconds / 60).toFixed(0) + " min"
);
check("climbing costs endurance", hilly.requiredSeconds > flat.requiredSeconds);

// The reserve must actually be held back, not quietly spent.
const usableIfNoReserve = quad.enduranceMinutes * 60;
check(
  "reserve is withheld from the usable budget",
  flat.usableSeconds < usableIfNoReserve,
  (flat.usableSeconds / 60).toFixed(0) + " min usable of " + quad.enduranceMinutes + " min total"
);

// ---------------------------------------------------------------- step 7
console.log("\nSTEP 7  Mast height only helps a sensor that can clear its own skyline");

const { sweepMastHeight } = await import("../src/sensitivity.js");

// Raising a mast buys visibility only where the extra height clears the local
// crest. On a summit the first few metres do that and buy a great deal. On a
// valley floor enclosed by 1000 m of terrain, no realistic mast helps at all.
// Asserting only "higher sees more" would pass on almost any implementation;
// requiring the summit to be far more mast-sensitive than the valley tests the
// mechanism rather than the direction.
const mastHeights = [0, 5, 20, 60];
const summitThreat = { x: summit.x, y: summit.y, maxRangeMetres: 30000 };
const valleyThreat = { x: valley.x, y: valley.y, maxRangeMetres: 30000 };

const summitSweep = sweepMastHeight(dem, [summitThreat], quad, mastHeights);
const valleySweep = sweepMastHeight(dem, [valleyThreat], quad, mastHeights);
const summitLoss = summitSweep[0].concealed - summitSweep[summitSweep.length - 1].concealed;
const valleyLoss = valleySweep[0].concealed - valleySweep[valleySweep.length - 1].concealed;

console.log("  summit threat, 0 to 60 m of mast: " + pct(summitLoss) + " of cover lost");
console.log("  valley threat, 0 to 60 m of mast: " + pct(valleyLoss) + " of cover lost");
check("raising a mast never increases cover", summitLoss >= 0 && valleyLoss >= 0);
check(
  "a summit sensor gains far more from a mast than an enclosed one",
  summitLoss > valleyLoss * 10,
  pct(summitLoss) + " vs " + pct(valleyLoss)
);

// The gain is front-loaded: the first 5 m must beat the following 55 m.
const firstFive = summitSweep[0].concealed - summitSweep[1].concealed;
const remaining = summitSweep[1].concealed - summitSweep[summitSweep.length - 1].concealed;
console.log("  first 5 m: " + pct(firstFive) + "   next 55 m: " + pct(remaining));
check("mast benefit is front-loaded", firstFive > remaining, pct(firstFive) + " vs " + pct(remaining));

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
