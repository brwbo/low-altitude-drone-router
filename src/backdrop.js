// What is behind the vehicle, from the observer's point of view.
//
// Optical detection is contrast against a background, and a low-flying vehicle
// has two very different backgrounds. Seen against SKY it is a dark shape on a
// bright field and stands out at long range. Seen against TERRAIN it competes
// with a cluttered, similarly-lit backdrop and is far harder to pick out.
//
// This is a larger effect than terrain shadow, and it is the physically
// correct version of the argument shadow was being used to make: shadow only
// helps when the vehicle is seen against ground in the first place, because
// against a bright sky it is backlit either way.
//
// The computation is the viewshed sweep run a second time, backwards. Walking
// each ray from the far end inwards and tracking the steepest slope seen so
// far gives, for every cell, the slope a sight line must exceed to clear all
// terrain BEYOND that cell. A vehicle whose sight line is steeper than that
// escapes over the horizon and is silhouetted; one below it has terrain
// behind.

const NEVER = -Infinity;

// Returns Uint8Array: 1 = silhouetted against sky, 0 = seen against terrain.
// Cells the threat cannot see at all are 0 and should be ignored by callers.
export function computeBackdrop(dem, threat, heightAboveGround, options) {
  const opts = options || {};
  const observerHeight = opts.observerHeight === undefined ? 2 : opts.observerHeight;
  const maxRangeMetres = opts.maxRangeMetres === undefined ? Infinity : opts.maxRangeMetres;
  const surface = opts.surface || dem.elev;

  const width = dem.width;
  const height = dem.height;
  const cellSize = dem.cellSize;
  const againstSky = new Uint8Array(width * height);

  const tx = threat.x;
  const ty = threat.y;
  const threatAltitude = surface[ty * width + tx] + observerHeight;

  const maxReach = Math.hypot(
    Math.max(tx, width - 1 - tx),
    Math.max(ty, height - 1 - ty)
  );
  const rayCount = Math.max(360, Math.ceil(2 * Math.PI * maxReach));
  const maxSteps = Math.ceil(maxReach) + 1;

  // Reused across rays so the sweep does not allocate per ray.
  const cellIndex = new Int32Array(maxSteps + 1);
  const cellDistance = new Float64Array(maxSteps + 1);

  for (let r = 0; r < rayCount; r++) {
    const angle = (r / rayCount) * 2 * Math.PI;
    const stepX = Math.cos(angle);
    const stepY = Math.sin(angle);

    let length = 0;
    for (let step = 1; step <= maxSteps; step++) {
      const x = Math.round(tx + stepX * step);
      const y = Math.round(ty + stepY * step);
      if (x < 0 || y < 0 || x >= width || y >= height) break;
      const distance = step * cellSize;
      if (distance > maxRangeMetres) break;
      cellIndex[length] = y * width + x;
      cellDistance[length] = distance;
      length = length + 1;
    }

    // Backward pass: the steepest slope demanded by anything further out.
    let slopeBeyond = NEVER;
    for (let i = length - 1; i >= 0; i--) {
      const index = cellIndex[i];
      const droneSlope =
        (surface[index] + heightAboveGround - threatAltitude) / cellDistance[i];

      // Steeper than everything beyond means the sight line clears the far
      // terrain and carries on into open sky.
      if (droneSlope > slopeBeyond) {
        againstSky[index] = 1;
      }

      const groundSlope = (surface[index] - threatAltitude) / cellDistance[i];
      if (groundSlope > slopeBeyond) {
        slopeBeyond = groundSlope;
      }
    }
  }

  return againstSky;
}

// Detection weighting: a silhouetted vehicle is easier to see than one against
// clutter. Applied as a multiplier on exposure rather than a hard rule,
// because a well-lit vehicle against dark terrain is still visible.
export function backdropWeight(againstSky, index, options) {
  const opts = options || {};
  const skyPenalty = opts.skyPenalty === undefined ? 1.0 : opts.skyPenalty;
  const terrainDiscount = Math.max(0, Math.min(0.9,
    opts.terrainDiscount === undefined ? 0.45 : opts.terrainDiscount));
  return againstSky[index] === 1 ? skyPenalty : skyPenalty * (1 - terrainDiscount);
}

// Share of the ground a threat can see where the vehicle would be silhouetted.
export function skylinedFraction(dem, ceiling, againstSky, heightAboveGround) {
  let seen = 0;
  let sky = 0;
  for (let i = 0; i < againstSky.length; i++) {
    if (dem.elev[i] + heightAboveGround > ceiling[i]) {
      seen = seen + 1;
      if (againstSky[i] === 1) sky = sky + 1;
    }
  }
  return { seenCells: seen, skylinedCells: sky, fraction: seen === 0 ? 0 : sky / seen };
}
