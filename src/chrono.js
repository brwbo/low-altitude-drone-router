// Chronolocation: checking a claimed time and place against the sun.
//
// A photograph carries two measurable solar facts. The direction a shadow
// points gives the sun's bearing, because a shadow falls opposite the sun.
// The ratio of a shadow's length to the height of the object casting it gives
// the sun's elevation, because that ratio is exactly 1 / tan(elevation).
//
// Both are fixed by date, time and latitude. So a claim of "this was taken at
// X on date D at time T" is checkable: compute what the sun was doing and see
// whether the shadows agree. This does not prove a photograph is genuine. It
// can only show that a claim is inconsistent, which is the useful direction.

import { solarPosition } from "./sun.js";

// Shadows point away from the sun.
export function shadowBearingFromSun(sunAzimuthDeg) {
  return (sunAzimuthDeg + 180) % 360;
}

export function sunAzimuthFromShadow(shadowBearingDeg) {
  return (shadowBearingDeg + 180) % 360;
}

// A vertical object of height h casts a shadow of length h / tan(elevation).
export function shadowLengthRatio(sunElevationDeg) {
  if (sunElevationDeg <= 0) {
    return Infinity;
  }
  return 1 / Math.tan((sunElevationDeg * Math.PI) / 180);
}

export function elevationFromShadowRatio(ratio) {
  if (ratio <= 0) {
    return 90;
  }
  return (Math.atan(1 / ratio) * 180) / Math.PI;
}

function angularDifference(a, b) {
  let diff = Math.abs(a - b) % 360;
  if (diff > 180) {
    diff = 360 - diff;
  }
  return diff;
}

// What the sun was doing at a claimed place and moment.
export function expectedAt(date, latitude, longitude) {
  const sun = solarPosition(date, latitude, longitude);
  return {
    sunAzimuth: sun.azimuth,
    sunElevation: sun.elevation,
    shadowBearing: shadowBearingFromSun(sun.azimuth),
    shadowLengthRatio: shadowLengthRatio(sun.elevation),
    daylight: sun.elevation > 0,
  };
}

// Every moment on a given date at which the sun would produce the observed
// shadow. Scanned rather than solved, so a single implementation of the solar
// maths serves both directions and the two cannot disagree.
export function timesMatchingShadow(date, latitude, longitude, observed, options) {
  const opts = options || {};
  const bearingTolerance = opts.bearingToleranceDeg === undefined ? 5 : opts.bearingToleranceDeg;
  const ratioTolerance = opts.ratioTolerance === undefined ? 0.15 : opts.ratioTolerance;
  const stepMinutes = opts.stepMinutes === undefined ? 1 : opts.stepMinutes;

  const startOfDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );

  const matches = [];
  for (let minute = 0; minute < 1440; minute += stepMinutes) {
    const at = new Date(startOfDay.getTime() + minute * 60000);
    const sun = solarPosition(at, latitude, longitude);
    if (sun.elevation <= 0) {
      continue;
    }

    let ok = true;
    if (observed.shadowBearingDeg !== undefined) {
      const expected = shadowBearingFromSun(sun.azimuth);
      if (angularDifference(expected, observed.shadowBearingDeg) > bearingTolerance) {
        ok = false;
      }
    }
    if (ok && observed.shadowLengthRatio !== undefined) {
      const expected = shadowLengthRatio(sun.elevation);
      const relative = Math.abs(expected - observed.shadowLengthRatio) /
        Math.max(observed.shadowLengthRatio, 0.001);
      if (relative > ratioTolerance) {
        ok = false;
      }
    }

    if (ok) {
      matches.push({
        at: at,
        sunAzimuth: sun.azimuth,
        sunElevation: sun.elevation,
        shadowBearing: shadowBearingFromSun(sun.azimuth),
        shadowLengthRatio: shadowLengthRatio(sun.elevation),
      });
    }
  }

  // Collapse runs of consecutive minutes into windows.
  const windows = [];
  for (const match of matches) {
    const last = windows[windows.length - 1];
    if (last && match.at.getTime() - last.end.getTime() <= stepMinutes * 60000) {
      last.end = match.at;
    } else {
      windows.push({ start: match.at, end: match.at });
    }
  }

  return { matches: matches, windows: windows };
}

// The verdict a verifier actually wants: does the claim hold up?
//
// Deliberately worded as consistent / inconsistent rather than true / false.
// Agreeing shadows do not prove a photograph was taken where it says. They
// only fail to disprove it.
export function checkClaim(claim, observed, options) {
  const opts = options || {};
  const bearingTolerance = opts.bearingToleranceDeg === undefined ? 5 : opts.bearingToleranceDeg;
  const ratioTolerance = opts.ratioTolerance === undefined ? 0.15 : opts.ratioTolerance;

  const at = new Date(claim.timeUtc);
  const expected = expectedAt(at, claim.lat, claim.lon);

  const reasons = [];
  let consistent = true;

  if (!expected.daylight) {
    consistent = false;
    reasons.push(
      "the sun was " + expected.sunElevation.toFixed(1) +
      " degrees below the horizon at the claimed time, so there would be no shadow at all"
    );
  }

  let bearingError = null;
  if (observed.shadowBearingDeg !== undefined && expected.daylight) {
    bearingError = angularDifference(expected.shadowBearing, observed.shadowBearingDeg);
    if (bearingError > bearingTolerance) {
      consistent = false;
      reasons.push(
        "shadow bearing is " + observed.shadowBearingDeg.toFixed(0) +
        " degrees but should be " + expected.shadowBearing.toFixed(0) +
        " degrees, off by " + bearingError.toFixed(0)
      );
    }
  }

  let ratioError = null;
  if (observed.shadowLengthRatio !== undefined && expected.daylight) {
    ratioError =
      Math.abs(expected.shadowLengthRatio - observed.shadowLengthRatio) /
      Math.max(observed.shadowLengthRatio, 0.001);
    if (ratioError > ratioTolerance) {
      consistent = false;
      const impliedElevation = elevationFromShadowRatio(observed.shadowLengthRatio);
      reasons.push(
        "shadow length implies a sun elevation of " + impliedElevation.toFixed(1) +
        " degrees, but at the claimed time it was " + expected.sunElevation.toFixed(1) + " degrees"
      );
    }
  }

  const alternatives = consistent
    ? { windows: [] }
    : timesMatchingShadow(at, claim.lat, claim.lon, observed, opts);

  return {
    consistent: consistent,
    expected: expected,
    bearingError: bearingError,
    ratioError: ratioError,
    reasons: reasons,
    alternativeWindows: alternatives.windows,
  };
}
