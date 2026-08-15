// Detection strength as a function of range.
//
// The exposure model treats every cell inside a sensor's range identically: a
// vehicle 20 km away counts exactly as much as one 200 m away. Being
// geometrically VISIBLE at 20 km is not the same as being DETECTABLE at 20 km,
// and the difference is most of what a planner cares about.
//
// The model here is angular size. A vehicle of fixed size subtends an angle
// proportional to 1/r, and the energy reaching a sensor from it falls as 1/r^2.
// So detection strength is taken as (confidentRange / r)^2, capped at 1 inside
// the range where detection is a given and falling away beyond it.
//
// This is a first-order model, not a sensor performance curve. It has no term
// for target size, contrast, atmospheric clarity, operator attention or sensor
// aperture. What it gets right is the SHAPE: detection degrades sharply with
// distance rather than stopping at a cliff edge. Treating that as flat, which
// is what the code did before, is a bigger error than any of the terms missing
// from it.

// Range inside which detection is treated as certain, when a threat does not
// state one. A quarter of the stated maximum is a deliberately cautious
// default - it makes the near field wide rather than flattering the planner.
const DEFAULT_CONFIDENT_FRACTION = 0.25;

export function confidentRangeFor(threat) {
  if (Number.isFinite(threat.confidentRangeMetres) && threat.confidentRangeMetres > 0) {
    return threat.confidentRangeMetres;
  }
  return threat.maxRangeMetres * DEFAULT_CONFIDENT_FRACTION;
}

// Detection strength from 0 to 1 at a given range.
export function detectionStrength(rangeMetres, confidentRange, maxRange) {
  if (rangeMetres > maxRange) {
    return 0;
  }
  if (rangeMetres <= confidentRange) {
    return 1;
  }
  const ratio = confidentRange / rangeMetres;
  return ratio * ratio;
}

// Per-cell detection strength for one threat, ignoring line of sight. Combined
// with a ceiling elsewhere: a cell is only detectable if it is both in view and
// close enough to matter.
export function computeDetectionField(dem, threat) {
  const confident = confidentRangeFor(threat);
  const field = new Float32Array(dem.width * dem.height);

  for (let y = 0; y < dem.height; y++) {
    for (let x = 0; x < dem.width; x++) {
      const dx = (x - threat.x) * dem.cellSize;
      const dy = (y - threat.y) * dem.cellSize;
      const range = Math.hypot(dx, dy);
      field[y * dem.width + x] = detectionStrength(range, confident, threat.maxRangeMetres);
    }
  }
  return field;
}

// Exposure weighted by how well each threat can actually see you there.
//
// Replaces a count of watchers with a sum of detection strengths. A vehicle
// sitting at the far edge of three sensors' ranges is no longer scored the
// same as one sitting on top of one.
export function rangeWeightedExposure(dem, threats, ceilings, heightAboveGround, options) {
  const opts = options || {};
  const glares = opts.glares || null;
  const glareDiscount = Math.max(0, Math.min(0.9,
    opts.glareDiscount === undefined ? 0 : opts.glareDiscount));

  const cellCount = dem.width * dem.height;
  const weight = new Float32Array(cellCount);

  for (let c = 0; c < threats.length; c++) {
    const field = computeDetectionField(dem, threats[c]);
    const ceiling = ceilings[c];
    const glare = glares ? glares[c] : null;

    for (let i = 0; i < cellCount; i++) {
      if (dem.elev[i] + heightAboveGround > ceiling[i]) {
        let strength = field[i];
        if (glare && glare[i] > 0) {
          strength = strength * (1 - glareDiscount * glare[i]);
        }
        weight[i] = weight[i] + strength;
      }
    }
  }

  return weight;
}
