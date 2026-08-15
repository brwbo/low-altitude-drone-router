// Terrain shadow from the sun.
//
// The sun is effectively infinitely far away, so its rays are PARALLEL. That
// makes this cheaper than the threat viewshed, not more expensive: instead of
// casting rays outward from a point, the whole grid is swept once in the
// direction the shadows fall.
//
// Walking away from the sun, the ray leaving the last high point descends at
// tan(sunElevation) per metre travelled. Any terrain below that descending ray
// is in shadow; any terrain above it is lit and becomes the new ray origin.
//
// Grid convention: x increases east, y increases SOUTH (rows run north to
// south, matching the DEM). Azimuth is degrees clockwise from north.

const DEG = Math.PI / 180;

// Returns Uint8Array, 1 = in shadow, 0 = lit. Also returns the fraction
// shadowed, which is the number the time-of-day control moves.
export function computeShadow(dem, sun) {
  const width = dem.width;
  const height = dem.height;
  const cellSize = dem.cellSize;
  const elev = dem.elev;
  const shadow = new Uint8Array(width * height);

  // Below the horizon there is no direct sun anywhere.
  if (sun.elevation <= 0) {
    shadow.fill(1);
    return { shadow: shadow, shadowedFraction: 1, night: true };
  }

  // Horizontal unit vector pointing TOWARDS the sun.
  const towardSunX = Math.sin(sun.azimuth * DEG);
  const towardSunY = -Math.cos(sun.azimuth * DEG);

  // Shadows fall away from the sun.
  const dx = -towardSunX;
  const dy = -towardSunY;
  const tanElevation = Math.tan(sun.elevation * DEG);

  // Sweep along whichever axis the shadow direction is dominant in, so every
  // cell is visited exactly once and the sweep stays O(n).
  const rayHeight = new Float32Array(width * height);

  if (Math.abs(dy) >= Math.abs(dx)) {
    const slopeX = dx / Math.abs(dy);
    const stepDistance = cellSize * Math.sqrt(1 + slopeX * slopeX);
    const drop = stepDistance * tanElevation;
    const goingSouth = dy > 0;

    const firstRow = goingSouth ? 0 : height - 1;
    const rowStep = goingSouth ? 1 : -1;

    for (let x = 0; x < width; x++) {
      rayHeight[firstRow * width + x] = elev[firstRow * width + x];
    }

    for (let n = 1; n < height; n++) {
      const y = firstRow + n * rowStep;
      const previousY = y - rowStep;
      for (let x = 0; x < width; x++) {
        const sourceX = x - slopeX;
        const carried = sampleRow(rayHeight, width, previousY, sourceX) - drop;
        const index = y * width + x;
        const ground = elev[index];
        if (ground >= carried) {
          rayHeight[index] = ground;
        } else {
          rayHeight[index] = carried;
          shadow[index] = 1;
        }
      }
    }
  } else {
    const slopeY = dy / Math.abs(dx);
    const stepDistance = cellSize * Math.sqrt(1 + slopeY * slopeY);
    const drop = stepDistance * tanElevation;
    const goingEast = dx > 0;

    const firstCol = goingEast ? 0 : width - 1;
    const colStep = goingEast ? 1 : -1;

    for (let y = 0; y < height; y++) {
      rayHeight[y * width + firstCol] = elev[y * width + firstCol];
    }

    for (let n = 1; n < width; n++) {
      const x = firstCol + n * colStep;
      const previousX = x - colStep;
      for (let y = 0; y < height; y++) {
        const sourceY = y - slopeY;
        const carried = sampleColumn(rayHeight, width, height, previousX, sourceY) - drop;
        const index = y * width + x;
        const ground = elev[index];
        if (ground >= carried) {
          rayHeight[index] = ground;
        } else {
          rayHeight[index] = carried;
          shadow[index] = 1;
        }
      }
    }
  }

  let shadowed = 0;
  for (let i = 0; i < shadow.length; i++) {
    if (shadow[i] === 1) {
      shadowed = shadowed + 1;
    }
  }

  return {
    shadow: shadow,
    shadowedFraction: shadowed / shadow.length,
    night: false,
  };
}

// Linear interpolation along a row, because the sweep direction rarely lands
// on exact cell centres. Clamped at the edges.
function sampleRow(grid, width, y, x) {
  if (x <= 0) {
    return grid[y * width];
  }
  if (x >= width - 1) {
    return grid[y * width + width - 1];
  }
  const left = Math.floor(x);
  const t = x - left;
  const a = grid[y * width + left];
  const b = grid[y * width + left + 1];
  return a + (b - a) * t;
}

function sampleColumn(grid, width, height, x, y) {
  if (y <= 0) {
    return grid[x];
  }
  if (y >= height - 1) {
    return grid[(height - 1) * width + x];
  }
  const top = Math.floor(y);
  const t = y - top;
  const a = grid[top * width + x];
  const b = grid[(top + 1) * width + x];
  return a + (b - a) * t;
}

// How much of the sun's disc an observer at each cell would have to look into.
// A drone approaching from within `toleranceDeg` of the sun's bearing puts a
// ground observer in glare. Returns the bearing to fly FROM, in degrees.
export function glareBearing(sun) {
  return sun.azimuth;
}

// True when the sun is low enough for glare to genuinely degrade an observer.
export function glareIsEffective(sun, maxElevationDeg) {
  const limit = maxElevationDeg === undefined ? 20 : maxElevationDeg;
  return sun.elevation > 0 && sun.elevation <= limit;
}
