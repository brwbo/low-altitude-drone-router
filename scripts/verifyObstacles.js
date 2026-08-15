// Positive controls for obstacle masking.
//
// The claim being guarded is the one that justifies the whole feature: on flat
// ground, where terrain hides nothing, a building row or treeline is the only
// thing that conceals a drone - and a viewshed over bare ground misses it
// entirely. If this test can pass with obstacle masking switched off, the
// feature is doing nothing and the flat-ground corridor is a fiction.
//
// A synthetic flat plain is used on purpose. On real hills the terrain would
// do the masking and hide whether the obstacles contribute anything; a dead
// flat grid forces the obstacle surface to be the only possible cause of any
// concealment that appears.

import { computeCeiling } from "../src/viewshed.js";
import { buildSurface, checkObstacleShape } from "../src/obstacles.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}

// A dead flat plain at 100 m, 60 x 60 cells of 30 m.
const width = 60;
const height = 60;
const cellSize = 30;
const elev = new Int16Array(width * height);
for (let i = 0; i < elev.length; i++) {
  elev[i] = 100;
}
const dem = { width: width, height: height, cellSize: cellSize, elev: elev };

// A threat on the west edge, looking east across the plain.
const threat = { x: 5, y: 30, mastHeight: 2, maxRangeMetres: Infinity };

// A north-south wall of 30 m obstacles at x = 30: a building row or treeline
// running across the drone's path. Everything east of it should fall into its
// line-of-sight shadow.
const obstacleHeight = new Uint8Array(width * height);
for (let y = 0; y < height; y++) {
  obstacleHeight[y * width + 30] = 30;
}

console.log("\nOBSTACLES  buildings and trees must create cover on flat ground");

// The surface builder must add heights onto the ground, not replace them.
const surface = buildSurface(dem, obstacleHeight);
check("surface adds obstacle height onto the ground",
  surface[30 * width + 30] === 130 && surface[30 * width + 10] === 100,
  "wall cell " + surface[30 * width + 30] + " m, open cell " + surface[30 * width + 10] + " m");

const bareCeiling = computeCeiling(dem, threat, { observerHeight: threat.mastHeight });
const maskedCeiling = computeCeiling(dem, threat, {
  observerHeight: threat.mastHeight,
  surface: surface,
});

// A cell well behind the wall, straight along the threat's line of sight.
const behind = 30 * width + 45;
const bareBehind = bareCeiling[behind];
const maskedBehind = maskedCeiling[behind];
console.log("  cell behind the wall: bare ceiling " + bareBehind.toFixed(1) +
  " m, masked ceiling " + maskedBehind.toFixed(1) + " m (ground 100 m)");

// THE POINT. Bare flat ground gives a drone behind the wall almost no room -
// the ceiling sits barely above the ground, so it is exposed at any real
// altitude. The wall lifts that ceiling by tens of metres, which is the
// concealment. If these two are equal, obstacle masking is not wired in.
check("the wall raises the ceiling behind it", maskedBehind > bareBehind + 20,
  "+" + (maskedBehind - bareBehind).toFixed(1) + " m of cover");

check("bare flat ground offers almost no cover", bareBehind < 110,
  bareBehind.toFixed(1) + " m ceiling, " + (bareBehind - 100).toFixed(1) + " m above ground");

// Concealed share of the plain at 20 m above ground: how much of the map a
// drone at 20 m AGL is hidden over. Bare flat ground should conceal almost
// nothing; the wall should carve out a real shadow east of it.
function concealedFraction(ceiling, flightHeight) {
  let concealed = 0;
  for (let i = 0; i < ceiling.length; i++) {
    if (elev[i] + flightHeight <= ceiling[i]) {
      concealed = concealed + 1;
    }
  }
  return concealed / ceiling.length;
}
const bareHidden = concealedFraction(bareCeiling, 20);
const maskedHidden = concealedFraction(maskedCeiling, 20);
console.log("  concealed at 20 m AGL: bare " + (bareHidden * 100).toFixed(1) +
  "%, with obstacles " + (maskedHidden * 100).toFixed(1) + "%");
check("obstacles conceal ground that bare terrain does not",
  maskedHidden > bareHidden + 0.05,
  "+" + ((maskedHidden - bareHidden) * 100).toFixed(1) + " points");

// A grid of the wrong size must be rejected, not silently misaligned.
let rejected = false;
try {
  checkObstacleShape(dem, new Uint8Array(10));
} catch (error) {
  rejected = true;
}
check("a wrong-sized obstacle grid is rejected", rejected);

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
