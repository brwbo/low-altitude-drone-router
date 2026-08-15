// Line-of-sight from a threat position over the elevation grid.
//
// The important design decision: this does NOT return visible/not-visible.
// It returns, for every cell, the ALTITUDE at which a drone there would
// break that threat's horizon. Below that height the terrain hides you,
// above it you are exposed. A boolean would have to be thrown away and
// recomputed the moment a flight-altitude control exists.
//
// Method is a radial sweep: cast rays outward from the threat and track the
// steepest slope seen so far along each ray. Per-cell ray casting over 1.7
// million cells is roughly a hundred times more work and freezes the page.
//
// WHAT BLOCKS THE LINE OF SIGHT is `options.surface`, not the bare ground.
// Pass a surface of ground + building and tree heights and a drone hidden
// behind a treeline or a building row is masked, exactly as it is behind a
// ridge. This matters most where it is least intuitive: on flat ground the
// terrain hides nothing, so buildings and treelines are the ONLY cover, and a
// sweep over bare `dem.elev` finds no corridor at all where one plainly exists.
// The default surface is the bare ground, so callers that pass nothing keep
// the terrain-only behaviour. The threat's own eye still sits at ground level
// plus its mast height, because the mast height already says how far above the
// ground the sensor is - the surface only decides what stands BETWEEN the
// sensor and the target.

const NEVER_HIDDEN = -Infinity;

// Returns Float32Array, one absolute altitude in metres above sea level per cell.
// Infinity means this threat imposes no limit there (out of range, or never reached).
export function computeCeiling(dem, threat, options) {
  const opts = options || {};
  const observerHeight = opts.observerHeight === undefined ? 2 : opts.observerHeight;
  const maxRangeMetres = opts.maxRangeMetres === undefined ? Infinity : opts.maxRangeMetres;

  const width = dem.width;
  const height = dem.height;
  const cellSize = dem.cellSize;
  const elev = dem.elev;
  // What stands between the sensor and the target. Buildings and trees block a
  // sightline the same way terrain does; with no surface supplied this is the
  // bare ground and the result is a terrain-only viewshed.
  const surface = opts.surface || dem.elev;

  const ceiling = new Float32Array(width * height);
  ceiling.fill(Infinity);

  const tx = threat.x;
  const ty = threat.y;
  // The eye sits on the ground plus the mast, not on top of whatever obstacle
  // happens to occupy the threat cell - the mast height is the operator's
  // statement of how high the sensor is.
  const threatAltitude = elev[ty * width + tx] + observerHeight;

  // The threat's own cell: it sees itself at any height.
  ceiling[ty * width + tx] = NEVER_HIDDEN;

  // Enough rays that neighbouring rays stay under one cell apart at the far
  // corner, otherwise the sweep leaves unsampled wedges at long range.
  const maxReach = Math.hypot(
    Math.max(tx, width - 1 - tx),
    Math.max(ty, height - 1 - ty)
  );
  const rayCount = Math.max(360, Math.ceil(2 * Math.PI * maxReach));
  const maxSteps = Math.ceil(maxReach) + 1;

  for (let r = 0; r < rayCount; r++) {
    const angle = (r / rayCount) * 2 * Math.PI;
    const stepX = Math.cos(angle);
    const stepY = Math.sin(angle);

    let maxSlope = NEVER_HIDDEN;
    let blocked = false;

    for (let step = 1; step <= maxSteps; step++) {
      const fx = tx + stepX * step;
      const fy = ty + stepY * step;
      const x = Math.round(fx);
      const y = Math.round(fy);

      if (x < 0 || y < 0 || x >= width || y >= height) {
        break;
      }

      const distance = step * cellSize;
      if (distance > maxRangeMetres) {
        break;
      }

      const index = y * width + x;
      // The blocking height is the surface - ground plus anything standing on
      // it - so a building or treeline casts a line-of-sight shadow behind it.
      const groundAltitude = surface[index];

      // Ceiling here depends only on what blocks BETWEEN the threat and this
      // cell, so it is computed before this cell updates the running maximum.
      let ceilingHere;
      if (blocked) {
        ceilingHere = threatAltitude + maxSlope * distance;
      } else {
        ceilingHere = NEVER_HIDDEN;
      }
      if (ceilingHere < ceiling[index]) {
        ceiling[index] = ceilingHere;
      }

      // This cell's own terrain may now block everything further along the ray.
      const slopeOfThisCell = (groundAltitude - threatAltitude) / distance;
      if (!blocked || slopeOfThisCell > maxSlope) {
        maxSlope = slopeOfThisCell;
        blocked = true;
      }
    }
  }

  return ceiling;
}

// Lowest ceiling across every threat: the altitude at which the FIRST of them
// acquires you. Mutates nothing; returns a fresh grid.
export function combineCeilings(ceilings, cellCount) {
  const combined = new Float32Array(cellCount);
  combined.fill(Infinity);
  for (let c = 0; c < ceilings.length; c++) {
    const ceiling = ceilings[c];
    for (let i = 0; i < cellCount; i++) {
      if (ceiling[i] < combined[i]) {
        combined[i] = ceiling[i];
      }
    }
  }
  return combined;
}

// How many threats can see a drone flying at a given height above ground.
// Used for the exposure count, which is what the route cost is built on.
export function exposureCount(dem, ceilings, flightHeightAboveGround) {
  const cellCount = dem.width * dem.height;
  const counts = new Uint8Array(cellCount);
  for (let c = 0; c < ceilings.length; c++) {
    const ceiling = ceilings[c];
    for (let i = 0; i < cellCount; i++) {
      const flightAltitude = dem.elev[i] + flightHeightAboveGround;
      if (flightAltitude > ceiling[i]) {
        counts[i] = counts[i] + 1;
      }
    }
  }
  return counts;
}
