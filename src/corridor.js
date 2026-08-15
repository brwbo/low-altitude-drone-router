// The flyable band at every cell.
//
//   floor    = ground + whatever stands on it + a clearance margin
//   ceiling  = the altitude at which the first threat acquires you
//   headroom = ceiling - floor
//
// Positive headroom means a range of altitudes exists there that is high
// enough to clear obstacles and low enough to stay masked. Zero or negative
// means there is no safe height at that point and the cell is impassable.

export function computeFloor(dem, options) {
  const opts = options || {};
  const clearance = opts.clearance === undefined ? 10 : opts.clearance;
  const obstacleHeight = opts.obstacleHeight || null;

  const floor = new Float32Array(dem.width * dem.height);
  for (let i = 0; i < floor.length; i++) {
    let above = 0;
    if (obstacleHeight !== null) {
      above = obstacleHeight[i];
    }
    floor[i] = dem.elev[i] + above + clearance;
  }
  return floor;
}

export function computeHeadroom(floor, ceiling) {
  const headroom = new Float32Array(floor.length);
  for (let i = 0; i < headroom.length; i++) {
    headroom[i] = ceiling[i] - floor[i];
  }
  return headroom;
}

// Share of the map that has any safe altitude at all.
export function passableFraction(headroom) {
  let passable = 0;
  for (let i = 0; i < headroom.length; i++) {
    if (headroom[i] > 0) {
      passable = passable + 1;
    }
  }
  return passable / headroom.length;
}

// Share of the map where a drone flying at a fixed height above ground is
// hidden from every threat. This is the number the altitude slider moves,
// and it must fall as the height rises.
export function hiddenFraction(dem, ceiling, flightHeightAboveGround) {
  let hidden = 0;
  for (let i = 0; i < ceiling.length; i++) {
    const flightAltitude = dem.elev[i] + flightHeightAboveGround;
    if (flightAltitude <= ceiling[i]) {
      hidden = hidden + 1;
    }
  }
  return hidden / ceiling.length;
}

// Ground within reach of at least one sensor, ignoring terrain entirely.
//
// This exists because "percent of the map concealed" is a misleading headline
// once sensor ranges are realistic. Three sensors with 2-4 km ranges cover
// under 6% of a 40 km box, so 98% of the map is "concealed" for the trivial
// reason that nothing can see that far. The number moves by two points across
// the whole altitude range and tells a planner nothing.
//
// Concealment is only meaningful over ground a sensor could actually reach.
// Measured there, the same terrain gives 66.8% cover at 5 m falling to 33.0%
// at 200 m - the real trade-off, which the whole-map figure hides.
export function computeSensorReach(dem, threats) {
  const reach = new Uint8Array(dem.width * dem.height);
  for (let y = 0; y < dem.height; y++) {
    for (let x = 0; x < dem.width; x++) {
      for (const threat of threats) {
        const dx = (x - threat.x) * dem.cellSize;
        const dy = (y - threat.y) * dem.cellSize;
        if (Math.hypot(dx, dy) <= threat.maxRangeMetres) {
          reach[y * dem.width + x] = 1;
          break;
        }
      }
    }
  }
  return reach;
}

export function reachFraction(reach) {
  let n = 0;
  for (let i = 0; i < reach.length; i++) {
    n = n + reach[i];
  }
  return n / reach.length;
}

// Concealed share of the ground a sensor could reach. The number worth quoting.
export function hiddenWithinReach(dem, ceiling, reach, flightHeightAboveGround) {
  let inReach = 0;
  let hidden = 0;
  for (let i = 0; i < ceiling.length; i++) {
    if (reach[i] !== 1) {
      continue;
    }
    inReach = inReach + 1;
    if (dem.elev[i] + flightHeightAboveGround <= ceiling[i]) {
      hidden = hidden + 1;
    }
  }
  return inReach === 0 ? 0 : hidden / inReach;
}
