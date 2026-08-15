// Chronolocation: check a claimed time and place against the shadows.
//
// Usage:
//   node scripts/chrono.js expect <lat> <lon> <ISO time>
//   node scripts/chrono.js check  <lat> <lon> <ISO time> <shadowBearingDeg> <shadowLengthRatio>

import { expectedAt, checkClaim, timesMatchingShadow, elevationFromShadowRatio } from "../src/chrono.js";

const NAMES = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const bearingName = (d) => NAMES[Math.round(d / 22.5) % 16];
const hhmm = (d) => d.toISOString().slice(11, 16) + " UTC";

const mode = process.argv[2] || "expect";
const lat = Number(process.argv[3]);
const lon = Number(process.argv[4]);
const timeUtc = process.argv[5];

if (!Number.isFinite(lat) || !Number.isFinite(lon) || !timeUtc) {
  console.error("usage: node scripts/chrono.js expect <lat> <lon> <ISO time>");
  console.error("       node scripts/chrono.js check <lat> <lon> <ISO time> <shadowBearing> <lengthRatio>");
  process.exit(1);
}

if (mode === "expect") {
  const expected = expectedAt(new Date(timeUtc), lat, lon);
  console.log("\n=== EXPECTED SOLAR CONDITIONS ===");
  console.log("claim     " + lat.toFixed(4) + ", " + lon.toFixed(4) + " at " + timeUtc);
  if (!expected.daylight) {
    console.log("\nThe sun was " + (-expected.sunElevation).toFixed(1) +
      " degrees BELOW the horizon. There would be no shadow.");
    process.exit(0);
  }
  console.log("sun       " + expected.sunElevation.toFixed(1) + " deg elevation, " +
    expected.sunAzimuth.toFixed(0) + " deg (" + bearingName(expected.sunAzimuth) + ")");
  console.log("shadows   point " + expected.shadowBearing.toFixed(0) + " deg (" +
    bearingName(expected.shadowBearing) + ")");
  console.log("length    " + expected.shadowLengthRatio.toFixed(2) +
    " times the height of the object casting it");
  console.log("\nso a 2 m post casts a " + (2 * expected.shadowLengthRatio).toFixed(2) +
    " m shadow pointing " + bearingName(expected.shadowBearing) + "\n");
  process.exit(0);
}

const shadowBearingDeg = Number(process.argv[6]);
const shadowLengthRatio = Number(process.argv[7]);
const observed = {};
if (Number.isFinite(shadowBearingDeg)) observed.shadowBearingDeg = shadowBearingDeg;
if (Number.isFinite(shadowLengthRatio)) observed.shadowLengthRatio = shadowLengthRatio;

const result = checkClaim({ lat: lat, lon: lon, timeUtc: timeUtc }, observed);

console.log("\n=== CLAIM CHECK ===");
console.log("claim     " + lat.toFixed(4) + ", " + lon.toFixed(4) + " at " + timeUtc);
if (observed.shadowBearingDeg !== undefined) {
  console.log("observed  shadow pointing " + observed.shadowBearingDeg.toFixed(0) +
    " deg (" + bearingName(observed.shadowBearingDeg) + ")");
}
if (observed.shadowLengthRatio !== undefined) {
  console.log("          shadow " + observed.shadowLengthRatio.toFixed(2) +
    "x object height, implying a sun elevation of " +
    elevationFromShadowRatio(observed.shadowLengthRatio).toFixed(1) + " deg");
}

if (result.expected.daylight) {
  console.log("\nexpected  shadow pointing " + result.expected.shadowBearing.toFixed(0) +
    " deg (" + bearingName(result.expected.shadowBearing) + "), " +
    result.expected.shadowLengthRatio.toFixed(2) + "x height" +
    "  [sun " + result.expected.sunElevation.toFixed(1) + " deg]");
}

console.log("\nVERDICT   " + (result.consistent ? "CONSISTENT" : "INCONSISTENT"));
for (const reason of result.reasons) {
  console.log("  - " + reason);
}

if (!result.consistent && result.alternativeWindows.length > 0) {
  console.log("\nthe observed shadow would fit these times on the claimed date:");
  for (const window of result.alternativeWindows) {
    if (window.start.getTime() === window.end.getTime()) {
      console.log("  " + hhmm(window.start));
    } else {
      console.log("  " + hhmm(window.start) + " to " + hhmm(window.end));
    }
  }
} else if (!result.consistent) {
  console.log("\nno time on the claimed date produces this shadow at this location.");
}

console.log(
  "\nNote: agreeing shadows do not prove a photograph is genuine. This can only\n" +
  "show a claim is inconsistent, which is the useful direction.\n"
);
