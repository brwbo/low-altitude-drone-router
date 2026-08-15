// Approaching out of the sun.
//
// An observer looking towards a low sun is dazzled: a human squints and loses
// contrast, a camera blooms, its auto-exposure closes down and lens flare
// wrecks the frame. Aircrew have used this for a century.
//
// The geometry is per threat and per cell, not global. What matters is the
// bearing FROM a given observer TO the vehicle, compared with the sun's
// azimuth. If the vehicle sits within a wedge centred on the sun's bearing,
// that observer is looking into it.
//
// Two conditions, both required:
//   the sun is low enough to be in the observer's field of view when looking
//   roughly level at a low-flying vehicle, and
//   the bearing to the vehicle falls inside the wedge.
//
// SCOPE, AND IT IS NARROW. This degrades EYES AND CAMERAS ONLY. Radar does
// not care what the sun is doing. Thermal does not care either, and sun-warmed
// ground can make a cool airframe MORE visible rather than less. So glare is
// applied only to threats whose type is optical, and it discounts detection
// rather than preventing it.

const DEG = Math.PI / 180;

// Threat types that glare actually affects. Anything else is untouched.
const OPTICAL_TYPES = ["optical", "visual", "eo", "camera", "observer", "unknown"];

export function isOptical(threat) {
  const type = String(threat.type || "unknown").toLowerCase();
  return OPTICAL_TYPES.indexOf(type) !== -1;
}

// Bearing in degrees clockwise from north, from a threat cell to a target
// cell. Grid rows run north to south, so y increases southwards.
function bearingFromTo(fromX, fromY, toX, toY) {
  const east = toX - fromX;
  const north = -(toY - fromY);
  let bearing = (Math.atan2(east, north) / DEG) % 360;
  if (bearing < 0) {
    bearing = bearing + 360;
  }
  return bearing;
}

function angularDifference(a, b) {
  let diff = Math.abs(a - b) % 360;
  if (diff > 180) {
    diff = 360 - diff;
  }
  return diff;
}

// How badly the sun dazzles, from 0 to 1, as a function of how low it sits.
//
// A binary in-the-wedge / out-of-the-wedge flag treats a sun at 3 degrees -
// sitting squarely in the observer's eyeline and genuinely blinding - the same
// as one at 24 degrees, which is a mild squint. Dazzle is strongest when the
// sun is lowest, fading to nothing by the elevation above which it is no longer
// in the line of sight to a low-flying vehicle. Below the horizon it is zero.
export function glareIntensity(sun, options) {
  const opts = options || {};
  const maxSunElevation = opts.maxSunElevationDeg === undefined ? 25 : opts.maxSunElevationDeg;
  if (sun.elevation <= 0 || sun.elevation > maxSunElevation) {
    return 0;
  }
  return (maxSunElevation - sun.elevation) / maxSunElevation;
}

// Graded dazzle per cell, 0 to 1, combining two falloffs: how low the sun is,
// and how close the bearing to the vehicle is to the sun's bearing. Dead centre
// on the sun at a hair above the horizon is 1; the edge of the wedge, or a sun
// near the cutoff, tapers to 0. This is the version the router should use, so a
// route is drawn towards the strongest dazzle rather than treating the whole
// wedge as equally good. computeGlare below stays binary for callers and tests
// that only need wedge membership.
export function computeGradedGlare(dem, threat, sun, options) {
  const opts = options || {};
  const halfAngle = opts.halfAngleDeg === undefined ? 18 : opts.halfAngleDeg;

  const graded = new Float32Array(dem.width * dem.height);
  if (!isOptical(threat)) {
    return graded;
  }
  const intensity = glareIntensity(sun, opts);
  if (intensity <= 0) {
    return graded;
  }

  for (let y = 0; y < dem.height; y++) {
    for (let x = 0; x < dem.width; x++) {
      if (x === threat.x && y === threat.y) {
        continue;
      }
      const bearing = bearingFromTo(threat.x, threat.y, x, y);
      const offAxis = angularDifference(bearing, sun.azimuth);
      if (offAxis <= halfAngle) {
        // Linear taper: full dazzle on the sun's bearing, zero at the edge.
        const angularFactor = 1 - offAxis / halfAngle;
        graded[y * dem.width + x] = angularFactor * intensity;
      }
    }
  }

  return graded;
}

// Cells where an observer at this threat would be looking into the sun.
// Returns Uint8Array, 1 = dazzled.
export function computeGlare(dem, threat, sun, options) {
  const opts = options || {};
  const halfAngle = opts.halfAngleDeg === undefined ? 18 : opts.halfAngleDeg;
  const maxSunElevation = opts.maxSunElevationDeg === undefined ? 25 : opts.maxSunElevationDeg;

  const glare = new Uint8Array(dem.width * dem.height);

  if (!isOptical(threat)) {
    return glare;
  }
  // Sun below the horizon dazzles nobody, and a high sun is above the line of
  // sight to something flying low.
  if (sun.elevation <= 0 || sun.elevation > maxSunElevation) {
    return glare;
  }

  for (let y = 0; y < dem.height; y++) {
    for (let x = 0; x < dem.width; x++) {
      if (x === threat.x && y === threat.y) {
        continue;
      }
      const bearing = bearingFromTo(threat.x, threat.y, x, y);
      if (angularDifference(bearing, sun.azimuth) <= halfAngle) {
        glare[y * dem.width + x] = 1;
      }
    }
  }

  return glare;
}

// Weighted exposure: how many threats can effectively see a vehicle at this
// height, with dazzled optical observers counting for less.
//
// This replaces a plain count. Counting a dazzled observer the same as a
// clear-sighted one throws away the whole point of approaching out of the sun;
// counting it as zero claims the observer is blind, which is false. A discount
// is the honest middle.
export function weightedExposure(dem, ceilings, glares, heightAboveGround, options) {
  const opts = options || {};
  const discount = Math.max(0, Math.min(0.9,
    opts.glareDiscount === undefined ? 0.5 : opts.glareDiscount));

  const cellCount = dem.width * dem.height;
  const weight = new Float32Array(cellCount);

  for (let c = 0; c < ceilings.length; c++) {
    const ceiling = ceilings[c];
    const glare = glares[c];
    for (let i = 0; i < cellCount; i++) {
      if (dem.elev[i] + heightAboveGround > ceiling[i]) {
        // The glare value is read as a 0..1 dazzle factor. A binary grid of
        // 0/1 still behaves exactly as before (1 gives the full discount, 0
        // none); a graded grid discounts in proportion to how dazzled the
        // observer is. The discount can never exceed the clamp, so a weighted
        // count can never drop below zero or exceed the plain count.
        const dazzle = glare ? glare[i] : 0;
        weight[i] = weight[i] + (1 - discount * dazzle);
      }
    }
  }

  return weight;
}

// Share of the exposed ground where at least one watching threat is dazzled.
// Reported so the advantage can be quoted honestly rather than assumed.
export function glareCoverage(dem, ceilings, glares, heightAboveGround) {
  const cellCount = dem.width * dem.height;
  let exposed = 0;
  let helped = 0;

  for (let i = 0; i < cellCount; i++) {
    let seenBy = 0;
    let dazzled = 0;
    for (let c = 0; c < ceilings.length; c++) {
      if (dem.elev[i] + heightAboveGround > ceilings[c][i]) {
        seenBy = seenBy + 1;
        // Any non-zero dazzle counts as a helped cell, so this works for both
        // the binary and the graded glare grids.
        if (glares[c] && glares[c][i] > 0) {
          dazzled = dazzled + 1;
        }
      }
    }
    if (seenBy > 0) {
      exposed = exposed + 1;
      if (dazzled > 0) {
        helped = helped + 1;
      }
    }
  }

  return { exposedCells: exposed, helpedCells: helped, fraction: exposed === 0 ? 0 : helped / exposed };
}

// The bearing to approach from, per threat, so the pitch can say it out loud.
export function approachBearings(threats, sun, options) {
  const opts = options || {};
  const maxSunElevation = opts.maxSunElevationDeg === undefined ? 25 : opts.maxSunElevationDeg;

  const useful = [];
  for (const threat of threats) {
    if (!isOptical(threat)) {
      continue;
    }
    if (sun.elevation <= 0 || sun.elevation > maxSunElevation) {
      continue;
    }
    // Approach from the sun's bearing as seen by the observer, so the observer
    // is looking towards the sun when it looks at you.
    useful.push({ threat: threat, approachFrom: sun.azimuth });
  }
  return useful;
}
