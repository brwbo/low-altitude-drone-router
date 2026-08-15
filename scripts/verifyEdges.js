// Adversarial tests. Everything that could plausibly go wrong on stage:
// boundary positions, degenerate inputs, unexercised code branches, error
// paths, and numerical hygiene.
//
// The most important section is the shadow sweep across all eight octants.
// computeShadow picks between a row-major and a column-major sweep depending
// on which axis the sun direction is dominant in, and until now only two
// azimuths had ever been tested - both landing in the same branch.

import fs from "node:fs";
import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, combineCeilings, exposureCount } from "../src/viewshed.js";
import { computeShadow } from "../src/shadow.js";
import { solarPosition, sunTimes } from "../src/sun.js";
import { findPath } from "../src/pathfind.js";
import { parseThreat, parseThreats, ThreatInputError } from "../src/threats.js";
import { parseLatLon, lonLatToGrid, gridToLonLat, insideBounds } from "../src/coords.js";
import { VEHICLES, computeSlope, computeTrafficable, checkEndurance } from "../src/vehicles.js";
import { computeFloor, computeHeadroom, hiddenFraction } from "../src/corridor.js";

let failures = 0;
let checks = 0;
function check(label, passed, detail) {
  checks = checks + 1;
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}
function section(title) {
  console.log("\n" + title);
}
const finite = (v) => Number.isFinite(v);

const dem = loadDemSync();
const cellCount = dem.width * dem.height;
const slope = computeSlope(dem);

// ========================================================== 1. THE DATA
section("1. DATA INTEGRITY");

let anyNaN = false;
let anyAbsurd = false;
for (let i = 0; i < dem.elev.length; i++) {
  const v = dem.elev[i];
  if (!Number.isFinite(v)) anyNaN = true;
  if (v < -500 || v > 9000) anyAbsurd = true;
}
check("no non-finite elevations", !anyNaN);
check("no physically absurd elevations", !anyAbsurd);
check("grid dimensions are positive integers",
  Number.isInteger(dem.width) && Number.isInteger(dem.height) && dem.width > 0 && dem.height > 0);
check("cell size is positive", dem.cellSize > 0);
check("bounds are ordered", dem.latTop > dem.latBottom && dem.lonRight > dem.lonLeft);

// Coordinate round trip at all four corners plus the centre.
let worstError = 0;
for (const [x, y] of [[0, 0], [dem.width - 1, 0], [0, dem.height - 1],
                      [dem.width - 1, dem.height - 1], [667, 630]]) {
  const ll = gridToLonLat(dem, x, y);
  const back = lonLatToGrid(dem, ll.lat, ll.lon);
  worstError = Math.max(worstError, Math.hypot(back.x - x, back.y - y));
}
check("grid to lat/lon round trips at every corner", worstError < 1.5,
  "worst error " + worstError.toFixed(3) + " cells");

// ============================================== 2. SHADOW, ALL OCTANTS
section("2. SHADOW SWEEP - all eight octants, both code branches");

// The sweep switches branch at |dx| == |dy|, i.e. every 45 degrees. Testing
// only two azimuths left half the branches unexercised.
const octantResults = [];
for (let azimuth = 0; azimuth < 360; azimuth += 45) {
  const fake = { azimuth: azimuth, elevation: 12 };
  const result = computeShadow(dem, fake);
  octantResults.push({ azimuth, fraction: result.shadowedFraction, shadow: result.shadow });
  console.log("  azimuth " + String(azimuth).padStart(3) + " deg -> " +
    (result.shadowedFraction * 100).toFixed(1).padStart(5) + "% shadowed");
}
const fractions = octantResults.map((r) => r.fraction);
check("every octant produces shadow", fractions.every((f) => f > 0.05));
check("no octant is fully shadowed at 12 deg", fractions.every((f) => f < 0.95));

// At a fixed sun elevation, shadow fraction should be broadly similar in every
// direction over this terrain. A branch that is wrong shows up as an outlier.
const meanFraction = fractions.reduce((a, b) => a + b, 0) / fractions.length;
const worstDeviation = Math.max(...fractions.map((f) => Math.abs(f - meanFraction) / meanFraction));
check("no octant deviates wildly from the others", worstDeviation < 0.45,
  "worst deviation " + (worstDeviation * 100).toFixed(0) + "% from a mean of " +
  (meanFraction * 100).toFixed(1) + "%");

// Opposite azimuths must shadow opposite slopes, in all four opposing pairs.
function eastWestBias(shadowGrid) {
  let west = 0;
  let east = 0;
  for (let y = 1; y < dem.height - 1; y += 3) {
    for (let x = 1; x < dem.width - 1; x += 3) {
      const i = y * dem.width + x;
      if (shadowGrid[i] !== 1) continue;
      const d = dem.elev[i + 1] - dem.elev[i - 1];
      if (d > 0) west = west + 1;
      else if (d < 0) east = east + 1;
    }
  }
  return (west - east) / Math.max(1, west + east);
}
const bias90 = eastWestBias(octantResults[2].shadow);   // sun east
const bias270 = eastWestBias(octantResults[6].shadow);  // sun west
check("sun in the east and sun in the west shadow opposite slopes",
  bias90 > 0 && bias270 < 0,
  "east " + bias90.toFixed(3) + ", west " + bias270.toFixed(3));

// Degenerate sun angles.
check("sun exactly on the horizon means total shadow",
  computeShadow(dem, { azimuth: 180, elevation: 0 }).shadowedFraction === 1);
check("sun below the horizon means total shadow",
  computeShadow(dem, { azimuth: 180, elevation: -10 }).night === true);
const overhead = computeShadow(dem, { azimuth: 180, elevation: 89.9 });
check("sun overhead casts almost no shadow", overhead.shadowedFraction < 0.01,
  (overhead.shadowedFraction * 100).toFixed(3) + "%");
check("azimuth 360 behaves like azimuth 0",
  Math.abs(computeShadow(dem, { azimuth: 360, elevation: 12 }).shadowedFraction -
           computeShadow(dem, { azimuth: 0, elevation: 12 }).shadowedFraction) < 0.001);

// ================================================ 3. VIEWSHED EDGE CASES
section("3. VIEWSHED - corners, edges and degenerate ranges");

for (const [name, pos] of [["top-left", { x: 0, y: 0 }],
                           ["bottom-right", { x: dem.width - 1, y: dem.height - 1 }],
                           ["top edge", { x: 667, y: 0 }],
                           ["left edge", { x: 0, y: 630 }]]) {
  const ceiling = computeCeiling(dem, pos, { observerHeight: 10 });
  let bad = 0;
  for (let i = 0; i < ceiling.length; i++) {
    if (Number.isNaN(ceiling[i])) bad = bad + 1;
  }
  check("threat at the " + name + " produces no NaN", bad === 0);
}

const zeroRange = computeCeiling(dem, { x: 667, y: 630 }, { observerHeight: 2, maxRangeMetres: 1 });
let seenAtZeroRange = 0;
for (let i = 0; i < zeroRange.length; i++) {
  if (dem.elev[i] + 30 > zeroRange[i]) seenAtZeroRange = seenAtZeroRange + 1;
}
check("a one-metre sensor range sees essentially nothing", seenAtZeroRange < 20,
  seenAtZeroRange + " cells");

const zeroHeight = computeCeiling(dem, { x: 667, y: 630 }, { observerHeight: 0 });
check("a zero-height observer still works", !Number.isNaN(zeroHeight[0]));

// Raising the observer must never increase concealment anywhere.
const low = computeCeiling(dem, { x: 667, y: 630 }, { observerHeight: 2 });
const high = computeCeiling(dem, { x: 667, y: 630 }, { observerHeight: 100 });
check("a higher observer never gives you more cover",
  hiddenFraction(dem, high, 30) <= hiddenFraction(dem, low, 30),
  (hiddenFraction(dem, high, 30) * 100).toFixed(1) + "% vs " +
  (hiddenFraction(dem, low, 30) * 100).toFixed(1) + "%");

// Combining a single ceiling must be the identity.
const single = combineCeilings([low], cellCount);
let identical = true;
for (let i = 0; i < cellCount; i++) {
  if (single[i] !== low[i]) identical = false;
}
check("combining one ceiling changes nothing", identical);

// Exposure count must never exceed the number of threats.
const counts = exposureCount(dem, [low, high], 30);
let overCount = false;
for (let i = 0; i < counts.length; i++) {
  if (counts[i] > 2) overCount = true;
}
check("exposure count never exceeds the threat count", !overCount);

// Monotonicity across the whole altitude range.
let monotonic = true;
let previous = 1;
for (const agl of [0, 5, 15, 30, 50, 80, 120, 200, 400, 1000]) {
  const h = hiddenFraction(dem, low, agl);
  if (h > previous + 1e-9) monotonic = false;
  previous = h;
}
check("cover falls monotonically from 0 to 1000 m AGL", monotonic);

// ================================================== 4. THREAT INPUT
section("4. THREAT INPUT - every way an operator can get it wrong");

const bad = [
  [null, "null"],
  [{}, "empty object"],
  [{ lat: 48.1, lon: "east" }, "non-numeric longitude"],
  [{ lat: 91, lon: 24.5 }, "latitude above 90"],
  [{ lat: 48.1, lon: 181 }, "longitude above 180"],
  [{ lat: 50.45, lon: 30.52 }, "valid but off this map"],
  [{ lat: 48.1, lon: 24.5, mastHeight: -5 }, "negative mast"],
  [{ lat: 48.1, lon: 24.5, mastHeight: 5000 }, "absurd mast"],
  [{ lat: 48.1, lon: 24.5, maxRangeKm: 0 }, "zero range"],
  [{ lat: 48.1, lon: 24.5, maxRangeKm: -3 }, "negative range"],
  [{ position: "not coordinates" }, "unparseable position string"],
  [{ x: -1, y: 5 }, "negative grid cell"],
  [{ x: 99999, y: 5 }, "grid cell off the map"],
];
let rejectedAll = true;
for (const [input, name] of bad) {
  let threw = false;
  try {
    parseThreat(input, dem, 0);
  } catch (error) {
    threw = error instanceof ThreatInputError;
  }
  if (!threw) {
    rejectedAll = false;
    console.log("    NOT REJECTED: " + name);
  }
}
check("all " + bad.length + " malformed threats are rejected", rejectedAll);

let emptyThrew = false;
try {
  parseThreats([], dem);
} catch (error) {
  emptyThrew = error instanceof ThreatInputError;
}
check("an empty threat list is rejected", emptyThrew);

// Valid forms must all be accepted.
const good = [
  { lat: 48.1, lon: 24.5 },
  { position: "48.1, 24.5" },
  { position: "48.1 24.5" },
  { x: 100, y: 100 },
  { lat: 48.1, lon: 24.5, mastHeight: 0 },
  { lat: 48.1, lon: 24.5, maxRangeKm: 0.5 },
];
let acceptedAll = true;
for (const input of good) {
  try {
    const t = parseThreat(input, dem, 0);
    if (!finite(t.x) || !finite(t.y) || !finite(t.groundElevation)) acceptedAll = false;
  } catch (error) {
    acceptedAll = false;
    console.log("    WRONGLY REJECTED: " + JSON.stringify(input) + " - " + error.message);
  }
}
check("all " + good.length + " valid threat forms are accepted", acceptedAll);

// Exact boundary coordinates must be inside, not off by one.
check("the exact north-west corner is inside bounds", insideBounds(dem, dem.latTop, dem.lonLeft));
check("the exact south-east corner is inside bounds", insideBounds(dem, dem.latBottom, dem.lonRight));
check("a hair outside the corner is rejected", !insideBounds(dem, dem.latTop + 0.001, dem.lonLeft));
check("parseLatLon rejects a single number", parseLatLon("48.1") === null);
check("parseLatLon handles negatives", parseLatLon("-33.9, 151.2").lat === -33.9);

// ===================================================== 5. PATHFINDING
section("5. PATHFINDING - degenerate and impossible routes");

const vehicle = VEHICLES.quadLow;
const passable = computeTrafficable(dem, vehicle, slope);
const grids = { passable, exposure: new Uint8Array(cellCount), shadow: null, elev: dem.elev };

const samePoint = findPath(dem, { x: 500, y: 500 }, { x: 500, y: 500 }, grids, { vehicle });
check("start equal to goal returns a zero-length route",
  samePoint.found && samePoint.metres === 0, samePoint.metres + " m");

const adjacent = findPath(dem, { x: 500, y: 500 }, { x: 501, y: 500 }, grids, { vehicle });
check("adjacent cells give exactly one cell of travel",
  adjacent.found && Math.abs(adjacent.metres - dem.cellSize) < 0.001);

const cornerToCorner = findPath(dem, { x: 0, y: 0 },
  { x: dem.width - 1, y: dem.height - 1 }, grids, { vehicle });
check("corner to corner across the whole map works", cornerToCorner.found,
  cornerToCorner.found ? (cornerToCorner.metres / 1000).toFixed(1) + " km" : cornerToCorner.reason);

const blocked = new Uint8Array(cellCount);
const blockedResult = findPath(dem, { x: 500, y: 500 }, { x: 600, y: 600 },
  { passable: blocked, exposure: new Uint8Array(cellCount), elev: dem.elev }, { vehicle });
check("a completely impassable map returns no route, not a crash",
  blockedResult.found === false && typeof blockedResult.reason === "string");

// An island: a passable start with no passable way out.
const island = new Uint8Array(cellCount).fill(1);
for (let y = 490; y <= 510; y++) {
  for (let x = 490; x <= 510; x++) {
    if (y === 490 || y === 510 || x === 490 || x === 510) island[y * dem.width + x] = 0;
  }
}
const islandResult = findPath(dem, { x: 500, y: 500 }, { x: 600, y: 600 },
  { passable: island, exposure: new Uint8Array(cellCount), elev: dem.elev }, { vehicle });
check("a walled-in start reports no route", islandResult.found === false);

// Every returned route must be internally consistent.
const real = findPath(dem, { x: 569, y: 666 }, { x: 482, y: 276 }, grids,
  { vehicle, exposurePenalty: 50 });
check("route distance is consistent with its trace length",
  real.metres >= (real.trace.length - 1) * dem.cellSize - 1 &&
  real.metres <= (real.trace.length - 1) * dem.cellSize * Math.SQRT2 + 1);
check("route reports only finite numbers",
  finite(real.metres) && finite(real.seconds) && finite(real.ascentMetres) &&
  finite(real.exposedSeconds) && finite(real.cost));
check("exposed time never exceeds total time", real.exposedSeconds <= real.seconds + 0.001,
  real.exposedSeconds.toFixed(0) + " s of " + real.seconds.toFixed(0) + " s");

// Consecutive trace cells must actually be adjacent.
let contiguous = true;
for (let i = 1; i < real.trace.length; i++) {
  const a = real.trace[i - 1];
  const b = real.trace[i];
  const dx = Math.abs((a % dem.width) - (b % dem.width));
  const dy = Math.abs(Math.floor(a / dem.width) - Math.floor(b / dem.width));
  if (dx > 1 || dy > 1) contiguous = false;
}
check("the route is contiguous with no jumps", contiguous, real.trace.length + " cells");

// ============================================================ 6. SUN
section("6. SUN - extreme latitudes and date boundaries");

const arcticSummer = sunTimes(new Date("2026-06-21T12:00:00Z"), 78.2, 15.6);
check("polar day: the sun never sets at 78 N in June",
  arcticSummer.sunrise === null && arcticSummer.sunset === null,
  "noon elevation " + arcticSummer.solarNoon.elevation.toFixed(1) + " deg");

const arcticWinter = sunTimes(new Date("2026-12-21T12:00:00Z"), 78.2, 15.6);
check("polar night: the sun never rises at 78 N in December",
  arcticWinter.solarNoon.elevation < 0,
  "best elevation " + arcticWinter.solarNoon.elevation.toFixed(1) + " deg");

const equator = sunTimes(new Date("2026-03-20T12:00:00Z"), 0, 0);
check("equinox at the equator gives near-overhead sun",
  equator.solarNoon.elevation > 88, equator.solarNoon.elevation.toFixed(2) + " deg");
const equatorDaylight = (equator.sunset - equator.sunrise) / 3600000;
check("equinox at the equator gives about twelve hours of daylight",
  equatorDaylight > 11.5 && equatorDaylight < 12.6, equatorDaylight.toFixed(2) + " hours");

let dateBoundaryOk = true;
for (const stamp of ["2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z",
                     "2026-02-28T12:00:00Z", "2028-02-29T12:00:00Z"]) {
  const s = solarPosition(new Date(stamp), 48.17, 24.5);
  if (!finite(s.azimuth) || !finite(s.elevation) || s.azimuth < 0 || s.azimuth > 360) {
    dateBoundaryOk = false;
  }
}
check("date boundaries and leap days produce valid angles", dateBoundaryOk);

let azimuthAlwaysValid = true;
for (let minute = 0; minute < 1440; minute += 7) {
  const at = new Date(Date.UTC(2026, 7, 15, 0, minute));
  const s = solarPosition(at, 48.17, 24.5);
  if (!(s.azimuth >= 0 && s.azimuth <= 360)) azimuthAlwaysValid = false;
  if (!(s.elevation >= -90 && s.elevation <= 90)) azimuthAlwaysValid = false;
}
check("azimuth and elevation stay in range across a whole day", azimuthAlwaysValid);

// ====================================================== 7. ENDURANCE
section("7. ENDURANCE AND CORRIDOR ARITHMETIC");

const zeroTrip = checkEndurance({ metres: 0, ascentMetres: 0 }, vehicle);
check("a zero-length route is feasible", zeroTrip.feasible === true);
check("a zero-length route uses no endurance", zeroTrip.requiredSeconds === 0);
const hugeTrip = checkEndurance({ metres: 1e9, ascentMetres: 0 }, vehicle);
check("an enormous route is infeasible", hugeTrip.feasible === false);
check("margin stays finite on an enormous route", finite(hugeTrip.marginFraction));

const floor = computeFloor(dem, { clearance: 10 });
const headroom = computeHeadroom(floor, low);
let headroomFinite = true;
for (let i = 0; i < headroom.length; i++) {
  if (Number.isNaN(headroom[i])) headroomFinite = false;
}
check("headroom contains no NaN", headroomFinite);
check("floor is always above ground", floor[0] > dem.elev[0]);

// ==================================================== 8. PERFORMANCE
section("8. PERFORMANCE - will it feel alive on stage");

const t0 = Date.now();
computeCeiling(dem, { x: 667, y: 630 }, { observerHeight: 10 });
const sweepMs = Date.now() - t0;
const t1 = Date.now();
computeShadow(dem, { azimuth: 120, elevation: 15 });
const shadowMs = Date.now() - t1;
const t2 = Date.now();
findPath(dem, { x: 569, y: 666 }, { x: 482, y: 276 }, grids, { vehicle, exposurePenalty: 50 });
const pathMs = Date.now() - t2;

console.log("  viewshed sweep " + sweepMs + " ms, shadow " + shadowMs + " ms, route " + pathMs + " ms");
check("a viewshed sweep stays interactive", sweepMs < 400, sweepMs + " ms");
check("a shadow sweep stays interactive", shadowMs < 400, shadowMs + " ms");
check("a route stays interactive", pathMs < 3000, pathMs + " ms");

// ================================================= 9. FILES ON DISK
section("9. FILES THE DEMO DEPENDS ON");

for (const file of ["data/dem.bin", "data/dem.json", "data/threats.json",
                    "src/viewshed.js", "src/sun.js", "src/shadow.js",
                    "src/pathfind.js", "docs/SAFETY.md"]) {
  check(file + " exists", fs.existsSync(file));
}
const missionCheck = JSON.parse(fs.readFileSync("data/threats.json", "utf8"));
check("the shipped mission parses and validates",
  parseThreats(missionCheck.threats, dem).length === missionCheck.threats.length);
check("the shipped start is inside the map",
  insideBounds(dem, missionCheck.mission.start.lat, missionCheck.mission.start.lon));
check("the shipped goal is inside the map",
  insideBounds(dem, missionCheck.mission.goal.lat, missionCheck.mission.goal.lon));

// Every platform must produce a route on the shipped mission. If one cannot,
// the demo has a hole in it.
const startCell = lonLatToGrid(dem, missionCheck.mission.start.lat, missionCheck.mission.start.lon);
const goalCell = lonLatToGrid(dem, missionCheck.mission.goal.lat, missionCheck.mission.goal.lon);
let everyPlatformRoutes = true;
for (const id of ["ugvTracked", "ugvWheeled", "quadNap", "quadLow", "quadFpv"]) {
  const v = VEHICLES[id];
  const p = computeTrafficable(dem, v, slope);
  const r = findPath(dem,
    { x: Math.round(startCell.x), y: Math.round(startCell.y) },
    { x: Math.round(goalCell.x), y: Math.round(goalCell.y) },
    { passable: p, exposure: new Uint8Array(cellCount), elev: dem.elev }, { vehicle: v });
  if (!r.found) {
    everyPlatformRoutes = false;
    console.log("    " + v.label + " cannot route: " + r.reason);
  }
}
check("every platform can route the shipped mission", everyPlatformRoutes);

console.log("\n" + checks + " checks run");
if (failures > 0) {
  console.log(failures + " FAILED");
  process.exit(1);
}
console.log("all passed");
