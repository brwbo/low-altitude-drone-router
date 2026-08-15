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
