// Positive controls for solar position and terrain shadow.
//
// Solar geometry is checkable against facts that do not depend on this code:
// the sun is due south at solar noon in the northern hemisphere, its noon
// elevation is fixed by latitude and declination, and it is below the horizon
// at local midnight. If the implementation is wrong, these fail loudly.

import { loadDemSync } from "../src/demNode.js";
import { solarPosition, sunTimes } from "../src/sun.js";
import { computeShadow } from "../src/shadow.js";

let failures = 0;

function check(label, passed, detail) {
  if (!passed) {
    failures = failures + 1;
  }
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}

function pct(f) {
  return (f * 100).toFixed(1) + "%";
}

function hhmm(date) {
  return (
    String(date.getUTCHours()).padStart(2, "0") +
    ":" +
    String(date.getUTCMinutes()).padStart(2, "0") +
    " UTC"
  );
}

const dem = loadDemSync();
const lat = (dem.latTop + dem.latBottom) / 2;
const lon = (dem.lonLeft + dem.lonRight) / 2;

console.log("\nSTEP 6  Solar position against facts this code cannot fake");
console.log("  site " + lat.toFixed(3) + " N, " + lon.toFixed(3) + " E  (Carpathians)");

const times = sunTimes(new Date("2026-08-15T12:00:00Z"), lat, lon);
console.log(
  "  2026-08-15  sunrise " + hhmm(times.sunrise) +
  "   solar noon " + hhmm(times.solarNoon.at) +
  "   sunset " + hhmm(times.sunset)
);
console.log(
  "  noon elevation " + times.solarNoon.elevation.toFixed(2) +
  " deg, azimuth " + times.solarNoon.azimuth.toFixed(1) + " deg"
);

// At solar noon in the northern hemisphere the sun is due south.
check(
  "sun is due south at solar noon",
  Math.abs(times.solarNoon.azimuth - 180) < 1.0,
  times.solarNoon.azimuth.toFixed(2) + " deg"
);

// Noon elevation must equal 90 - latitude + declination.
const noonSun = solarPosition(times.solarNoon.at, lat, lon);
const predicted = 90 - lat + noonSun.declination;
check(
  "noon elevation matches 90 - lat + declination",
  Math.abs(times.solarNoon.elevation - predicted) < 0.5,
  "computed " + times.solarNoon.elevation.toFixed(2) +
    ", predicted " + predicted.toFixed(2) +
    " (declination " + noonSun.declination.toFixed(2) + ")"
);

// Sunrise in the east, sunset in the west.
const atSunrise = solarPosition(times.sunrise, lat, lon);
const atSunset = solarPosition(times.sunset, lat, lon);
console.log(
  "  sunrise azimuth " + atSunrise.azimuth.toFixed(1) +
  " deg, sunset azimuth " + atSunset.azimuth.toFixed(1) + " deg"
);
check("sun rises in the eastern half", atSunrise.azimuth > 0 && atSunrise.azimuth < 180);
check("sun sets in the western half", atSunset.azimuth > 180 && atSunset.azimuth < 360);

// Mid-August in the Carpathians: daylight should be somewhere near 14 hours.
const daylightHours = (times.sunset - times.sunrise) / 3600000;
check(
  "daylight length is plausible for mid-August at 48 N",
  daylightHours > 13 && daylightHours < 15,
  daylightHours.toFixed(2) + " hours"
);

// Below the horizon in the middle of the night.
const midnight = solarPosition(new Date("2026-08-15T00:00:00Z"), lat, lon);
check("sun is below the horizon at midnight", midnight.elevation < 0, midnight.elevation.toFixed(1) + " deg");

// Southern hemisphere sanity: due NORTH at noon, and the seasons invert.
const southNoon = sunTimes(new Date("2026-08-15T12:00:00Z"), -33.9, 151.2);
check(
  "southern hemisphere sun is due north at noon",
  Math.abs(southNoon.solarNoon.azimuth) < 1.5 || Math.abs(southNoon.solarNoon.azimuth - 360) < 1.5,
  southNoon.solarNoon.azimuth.toFixed(2) + " deg"
);

// Solstice check at a known latitude - the sun is overhead at the Tropic of Cancer.
const solstice = sunTimes(new Date("2026-06-21T12:00:00Z"), 23.44, 0);
check(
  "sun is overhead at the Tropic of Cancer on the June solstice",
  solstice.solarNoon.elevation > 89.0,
  solstice.solarNoon.elevation.toFixed(2) + " deg"
);

console.log("\nSTEP 7  Terrain shadow must lengthen as the sun drops");

const samples = [];
for (let hour = 3; hour <= 19; hour++) {
  const at = new Date(Date.UTC(2026, 7, 15, hour, 0, 0));
  const sun = solarPosition(at, lat, lon);
  const started = Date.now();
  const result = computeShadow(dem, sun);
  const ms = Date.now() - started;
  samples.push({ hour: hour, sun: sun, result: result, ms: ms });
  console.log(
    "  " + String(hour).padStart(2, "0") + ":00 UTC  " +
    "elev " + sun.elevation.toFixed(1).padStart(6) + " deg  " +
    "az " + sun.azimuth.toFixed(0).padStart(3) + " deg  " +
    "shadowed " + pct(result.shadowedFraction).padStart(6) +
    "  (" + ms + " ms)"
  );
}

const daylight = samples.filter((s) => s.sun.elevation > 1);
let highest = daylight[0];
let lowest = daylight[0];
for (const s of daylight) {
  if (s.sun.elevation > highest.sun.elevation) highest = s;
  if (s.sun.elevation < lowest.sun.elevation) lowest = s;
}

check(
  "low sun casts more shadow than high sun",
  lowest.result.shadowedFraction > highest.result.shadowedFraction,
  pct(lowest.result.shadowedFraction) + " at " + lowest.sun.elevation.toFixed(1) +
    " deg vs " + pct(highest.result.shadowedFraction) + " at " + highest.sun.elevation.toFixed(1) + " deg"
);

// Shadow requires terrain sloping away from the sun more steeply than the
// sun's own elevation. So near-zero shadow at high sun is the CORRECT answer
// for this terrain, not a bug - the steepest slope in the grid decides it.
let steepestSlopeDeg = 0;
for (let y = 1; y < dem.height - 1; y++) {
  for (let x = 1; x < dem.width - 1; x++) {
    const i = y * dem.width + x;
    const dzdx = (dem.elev[i + 1] - dem.elev[i - 1]) / (2 * dem.cellSize);
    const dzdy = (dem.elev[i + dem.width] - dem.elev[i - dem.width]) / (2 * dem.cellSize);
    const slope = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    if (slope > steepestSlopeDeg) {
      steepestSlopeDeg = slope;
    }
  }
}
console.log("  steepest slope in the grid: " + steepestSlopeDeg.toFixed(1) + " deg");
check(
  "high sun above the steepest slope leaves almost nothing shadowed",
  highest.sun.elevation < steepestSlopeDeg || highest.result.shadowedFraction < 0.02,
  "sun " + highest.sun.elevation.toFixed(1) + " deg vs steepest slope " +
    steepestSlopeDeg.toFixed(1) + " deg, shadowed " + pct(highest.result.shadowedFraction)
);

// The informative check: shadow must fall monotonically as the sun climbs.
// A single fraction proves nothing; the ordering across the whole day does.
const bySunHeight = daylight.slice().sort((a, b) => a.sun.elevation - b.sun.elevation);
let monotonic = true;
let firstBreak = "";
for (let i = 1; i < bySunHeight.length; i++) {
  if (bySunHeight[i].result.shadowedFraction > bySunHeight[i - 1].result.shadowedFraction + 1e-9) {
    monotonic = false;
    firstBreak =
      "at " + bySunHeight[i].sun.elevation.toFixed(1) + " deg shadow rose to " +
      pct(bySunHeight[i].result.shadowedFraction);
    break;
  }
}
check("shadow falls monotonically as the sun climbs", monotonic, firstBreak);

check(
  "low sun shadows a large share of the terrain",
  lowest.result.shadowedFraction > 0.3,
  pct(lowest.result.shadowedFraction) + " at " + lowest.sun.elevation.toFixed(1) + " deg"
);

// Night must be total, and this is the check that catches a sign error on
// elevation - a flipped sign would light the map up at midnight.
const nightSun = solarPosition(new Date("2026-08-15T00:00:00Z"), lat, lon);
const nightShadow = computeShadow(dem, nightSun);
check("everything is shadowed at night", nightShadow.shadowedFraction === 1 && nightShadow.night === true);

// Shadows must fall on the opposite side to the sun. At dawn the sun is in the
// east, so shadows sit on WESTERN slopes; at dusk the reverse. Comparing the
// two catches an inverted direction vector, which a fraction alone cannot.
function shadowedSideBias(dem, shadowGrid) {
  // Positive means shadow sits preferentially on west-facing ground.
  let westFacingShadowed = 0;
  let eastFacingShadowed = 0;
  for (let y = 1; y < dem.height - 1; y++) {
    for (let x = 1; x < dem.width - 1; x++) {
      const i = y * dem.width + x;
      if (shadowGrid[i] !== 1) {
        continue;
      }
      const slopeEast = dem.elev[i + 1] - dem.elev[i - 1];
      if (slopeEast > 0) {
        westFacingShadowed = westFacingShadowed + 1;
      } else if (slopeEast < 0) {
        eastFacingShadowed = eastFacingShadowed + 1;
      }
    }
  }
  return (westFacingShadowed - eastFacingShadowed) / (westFacingShadowed + eastFacingShadowed);
}

const morning = solarPosition(new Date("2026-08-15T05:00:00Z"), lat, lon);
const evening = solarPosition(new Date("2026-08-15T17:00:00Z"), lat, lon);
const morningBias = shadowedSideBias(dem, computeShadow(dem, morning).shadow);
const eveningBias = shadowedSideBias(dem, computeShadow(dem, evening).shadow);
console.log(
  "  morning sun az " + morning.azimuth.toFixed(0) + " deg -> west-facing shadow bias " + morningBias.toFixed(3)
);
console.log(
  "  evening sun az " + evening.azimuth.toFixed(0) + " deg -> west-facing shadow bias " + eveningBias.toFixed(3)
);
check(
  "morning and evening shadows fall on opposite slopes",
  morningBias > 0 && eveningBias < 0,
  "morning " + morningBias.toFixed(3) + ", evening " + eveningBias.toFixed(3)
);

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
