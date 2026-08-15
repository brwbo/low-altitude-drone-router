// Vehicle profiles.
//
// Fixed-wing aircraft are deliberately absent: they cruise far higher than the
// terrain-masking regime this tool models, so a corridor computed at 30 m AGL
// tells you nothing useful about one. Everything here either crawls on the
// ground or hovers just above it.
//
//   heightAboveGround - where the vehicle (and anything looking at it) sits
//   maxSlopeDeg       - steepest ground it can cross; Infinity for anything airborne
//   speed             - metres per second, used to turn exposure into seconds
//   climbPenalty      - cost per metre of altitude gained, relative to a metre travelled

export const VEHICLES = {
  ugvTracked: {
    id: "ugvTracked",
    label: "Tracked UGV",
    airborne: false,
    heightAboveGround: 1.2,
    maxSlopeDeg: 30,
    speed: 2.5,
    climbPenalty: 6,
  },
  ugvWheeled: {
    id: "ugvWheeled",
    label: "Wheeled UGV",
    airborne: false,
    heightAboveGround: 1.0,
    maxSlopeDeg: 20,
    speed: 5,
    climbPenalty: 8,
  },
  quadNap: {
    id: "quadNap",
    label: "Quadcopter, nap of the earth",
    airborne: true,
    heightAboveGround: 5,
    maxSlopeDeg: Infinity,
    speed: 8,
    climbPenalty: 3,
  },
  quadLow: {
    id: "quadLow",
    label: "Quadcopter, low cruise",
    airborne: true,
    heightAboveGround: 15,
    maxSlopeDeg: Infinity,
    speed: 12,
    climbPenalty: 3,
  },
  quadFpv: {
    id: "quadFpv",
    label: "FPV quadcopter",
    airborne: true,
    heightAboveGround: 30,
    maxSlopeDeg: Infinity,
    speed: 25,
    climbPenalty: 2,
  },
};

// Ground slope in degrees at every cell. Needed for UGV trafficability, and
// reused by the hillshade.
export function computeSlope(dem) {
  const slope = new Float32Array(dem.width * dem.height);
  for (let y = 0; y < dem.height; y++) {
    for (let x = 0; x < dem.width; x++) {
      const i = y * dem.width + x;
      const left = x > 0 ? i - 1 : i;
      const right = x < dem.width - 1 ? i + 1 : i;
      const up = y > 0 ? i - dem.width : i;
      const down = y < dem.height - 1 ? i + dem.width : i;

      const runX = (right - left === 0 ? 1 : (right - left)) * dem.cellSize;
      const runY = (down - up === 0 ? dem.width : (down - up) / dem.width) * dem.cellSize;

      const dzdx = (dem.elev[right] - dem.elev[left]) / runX;
      const dzdy = (dem.elev[down] - dem.elev[up]) / runY;
      slope[i] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }
  return slope;
}

// Where this vehicle can physically be at all, before anything about threats.
// For a UGV that is a slope limit. For a rotary aircraft at low level it is
// everywhere, because it flies over the terrain rather than across it.
export function computeTrafficable(dem, vehicle, slope) {
  const passable = new Uint8Array(dem.width * dem.height);
  if (vehicle.airborne) {
    passable.fill(1);
    return passable;
  }
  for (let i = 0; i < passable.length; i++) {
    passable[i] = slope[i] <= vehicle.maxSlopeDeg ? 1 : 0;
  }
  return passable;
}

// Share of the map this vehicle can physically occupy.
export function trafficableFraction(passable) {
  let count = 0;
  for (let i = 0; i < passable.length; i++) {
    if (passable[i] === 1) {
      count = count + 1;
    }
  }
  return count / passable.length;
}

// Concealment for a specific vehicle: is it below every threat's ceiling when
// sitting at its own operating height above the ground?
export function concealedFraction(dem, ceiling, vehicle) {
  let concealed = 0;
  for (let i = 0; i < ceiling.length; i++) {
    if (dem.elev[i] + vehicle.heightAboveGround <= ceiling[i]) {
      concealed = concealed + 1;
    }
  }
  return concealed / ceiling.length;
}

// Cells that are BOTH reachable by this vehicle and hidden from every threat.
// This is the real corridor for a given platform, and the number that should
// drive the route.
export function computeUsable(dem, ceiling, passable, vehicle) {
  const usable = new Uint8Array(dem.width * dem.height);
  for (let i = 0; i < usable.length; i++) {
    const hidden = dem.elev[i] + vehicle.heightAboveGround <= ceiling[i];
    usable[i] = passable[i] === 1 && hidden ? 1 : 0;
  }
  return usable;
}
