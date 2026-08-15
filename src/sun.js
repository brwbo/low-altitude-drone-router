// Solar position from a timestamp and a position on the globe.
//
// This is the NOAA solar position algorithm, written out rather than pulled
// from a library, because it is about sixty lines of arithmetic and a
// dependency is one more thing that can fail to install.
//
// Returns azimuth in degrees clockwise from north (0 = north, 90 = east,
// 180 = south, 270 = west) and elevation in degrees above the horizon.
// Elevation is negative when the sun is below the horizon.

const DEG = Math.PI / 180;

function toRad(d) {
  return d * DEG;
}

function toDeg(r) {
  return r / DEG;
}

// Julian day from a JavaScript Date, using UTC throughout.
function julianDay(date) {
  return date.getTime() / 86400000 + 2440587.5;
}

export function solarPosition(date, latitude, longitude) {
  const jd = julianDay(date);
  const t = (jd - 2451545.0) / 36525.0;

  // Geometric mean longitude and anomaly of the sun.
  let meanLongitude = 280.46646 + t * (36000.76983 + t * 0.0003032);
  meanLongitude = ((meanLongitude % 360) + 360) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);

  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  // Equation of centre - the correction for the orbit not being circular.
  const centre =
    Math.sin(toRad(meanAnomaly)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(toRad(2 * meanAnomaly)) * (0.019993 - 0.000101 * t) +
    Math.sin(toRad(3 * meanAnomaly)) * 0.000289;

  const trueLongitude = meanLongitude + centre;

  // Apparent longitude, corrected for nutation.
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude =
    trueLongitude - 0.00569 - 0.00478 * Math.sin(toRad(omega));

  // Obliquity of the ecliptic - the tilt of the earth's axis.
  const meanObliquity =
    23 +
    (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(toRad(omega));

  const declination = toDeg(
    Math.asin(Math.sin(toRad(obliquity)) * Math.sin(toRad(apparentLongitude)))
  );

  // Equation of time, in minutes: the gap between clock noon and solar noon.
  const y = Math.tan(toRad(obliquity / 2)) * Math.tan(toRad(obliquity / 2));
  const equationOfTime =
    4 *
    toDeg(
      y * Math.sin(2 * toRad(meanLongitude)) -
        2 * eccentricity * Math.sin(toRad(meanAnomaly)) +
        4 *
          eccentricity *
          y *
          Math.sin(toRad(meanAnomaly)) *
          Math.cos(2 * toRad(meanLongitude)) -
        0.5 * y * y * Math.sin(4 * toRad(meanLongitude)) -
        1.25 * eccentricity * eccentricity * Math.sin(2 * toRad(meanAnomaly))
    );

  // Minutes past midnight UTC.
  const minutesUtc =
    date.getUTCHours() * 60 +
    date.getUTCMinutes() +
    date.getUTCSeconds() / 60 +
    date.getUTCMilliseconds() / 60000;

  // True solar time, then the hour angle: 0 at solar noon, negative in the
  // morning, positive in the afternoon.
  let trueSolarTime = minutesUtc + equationOfTime + 4 * longitude;
  trueSolarTime = ((trueSolarTime % 1440) + 1440) % 1440;
  let hourAngle = trueSolarTime / 4 - 180;

  const latRad = toRad(latitude);
  const decRad = toRad(declination);
  const haRad = toRad(hourAngle);

  let cosZenith =
    Math.sin(latRad) * Math.sin(decRad) +
    Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
  cosZenith = Math.min(1, Math.max(-1, cosZenith));
  const zenith = toDeg(Math.acos(cosZenith));
  let elevation = 90 - zenith;

  // Azimuth, measured clockwise from north.
  let azimuth;
  const denominator = Math.cos(latRad) * Math.sin(toRad(zenith));
  if (Math.abs(denominator) < 1e-9) {
    azimuth = hourAngle > 0 ? 180 : 0;
  } else {
    // Numerator order matters and is easy to get backwards. Negating it
    // mirrors the sun's track about the east-west axis, which sends it through
    // north at midday in the northern hemisphere while leaving the elevation
    // perfectly correct - so only an azimuth check catches it.
    let cosAz = (Math.sin(latRad) * cosZenith - Math.sin(decRad)) / denominator;
    cosAz = Math.min(1, Math.max(-1, cosAz));
    const acosAz = toDeg(Math.acos(cosAz));
    if (hourAngle > 0) {
      azimuth = (acosAz + 180) % 360;
    } else {
      azimuth = (540 - acosAz) % 360;
    }
  }

  return {
    azimuth: azimuth,
    elevation: elevation + refraction(elevation),
    elevationGeometric: elevation,
    declination: declination,
    equationOfTime: equationOfTime,
    hourAngle: hourAngle,
  };
}

// Atmospheric refraction lifts the apparent sun slightly, and the effect is
// largest exactly when it matters here - at low sun angles, which is when
// terrain shadows are longest.
function refraction(elevationDeg) {
  if (elevationDeg > 85) {
    return 0;
  }
  const te = Math.tan(toRad(elevationDeg));
  let correction;
  if (elevationDeg > 5) {
    correction =
      58.1 / te - 0.07 / (te * te * te) + 0.000086 / (te * te * te * te * te);
  } else if (elevationDeg > -0.575) {
    correction =
      1735 +
      elevationDeg *
        (-518.2 + elevationDeg * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)));
  } else {
    correction = -20.772 / te;
  }
  return correction / 3600;
}

// Scans a day in fixed steps and returns the times the sun crosses the
// horizon. Simple and robust - avoids a separate closed-form sunrise routine
// that could disagree with solarPosition and be wrong in a different way.
export function sunTimes(date, latitude, longitude, stepMinutes) {
  const step = stepMinutes || 2;
  const startOfDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );

  let sunrise = null;
  let sunset = null;
  let highest = null;

  let previous = solarPosition(startOfDay, latitude, longitude);
  for (let minute = step; minute <= 1440; minute += step) {
    const at = new Date(startOfDay.getTime() + minute * 60000);
    const now = solarPosition(at, latitude, longitude);

    if (highest === null || now.elevation > highest.elevation) {
      highest = { at: at, elevation: now.elevation, azimuth: now.azimuth };
    }
    if (previous.elevation < 0 && now.elevation >= 0 && sunrise === null) {
      sunrise = at;
    }
    if (previous.elevation >= 0 && now.elevation < 0 && sunset === null) {
      sunset = at;
    }
    previous = now;
  }

  return { sunrise: sunrise, sunset: sunset, solarNoon: highest };
}
