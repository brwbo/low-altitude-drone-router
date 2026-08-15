// Vehicle profiles.
//
// Fixed-wing aircraft are deliberately absent: they cruise far higher than the
// terrain-masking regime this tool models, so a corridor computed at 30 m AGL
// tells you nothing useful about one. Everything here either crawls on the
// ground or hovers just above it.
//
//   heightAboveGround   - where the vehicle (and anything looking at it) sits
//   maxSlopeDeg         - steepest ground it can cross; Infinity for anything airborne
//   speed               - metres per second, used to turn exposure into seconds
//   climbPenalty        - route cost per metre of altitude gained
//   enduranceMinutes    - total operating time on one charge or tank
//   reserveFraction     - share of endurance held back and never planned into
//   climbSecondsPerMetre - endurance consumed per metre of ascent, expressed as
//                          equivalent seconds of level travel
//
// THE NUMBERS BELOW ARE PLANNING PLACEHOLDERS, NOT MANUFACTURER SPECIFICATIONS.
// They are order-of-magnitude estimates chosen so the endurance check does
// something meaningful in a demo. Nobody verified them against a real platform.
// Any real use must replace them with figures from the actual vehicle, and the
// pitch should say so rather than quote them as if they were measured.

export const VEHICLES = {
  ugvTracked: {
    id: "ugvTracked",
    label: "Tracked UGV",
    airborne: false,
    heightAboveGround: 1.2,
    maxSlopeDeg: 30,
    speed: 2.5,
    climbPenalty: 6,
    enduranceMinutes: 240,
    reserveFraction: 0.2,
    payloadKg: 300,
    climbSecondsPerMetre: 2.0,
  },
  ugvWheeled: {
    id: "ugvWheeled",
    label: "Wheeled UGV",
    airborne: false,
    heightAboveGround: 1.0,
    maxSlopeDeg: 20,
    speed: 5,
    climbPenalty: 8,
    enduranceMinutes: 180,
    reserveFraction: 0.2,
    payloadKg: 150,
    climbSecondsPerMetre: 2.5,
  },
  quadNap: {
    id: "quadNap",
    label: "Quadcopter, nap of the earth",
    airborne: true,
    heightAboveGround: 5,
    maxSlopeDeg: Infinity,
    speed: 8,
    climbPenalty: 3,
    enduranceMinutes: 35,
    reserveFraction: 0.25,
    payloadKg: 5,
    climbSecondsPerMetre: 0.6,
  },
  quadLow: {
    id: "quadLow",
    label: "Quadcopter, low cruise",
    airborne: true,
    heightAboveGround: 15,
    maxSlopeDeg: Infinity,
    speed: 12,
    climbPenalty: 3,
    enduranceMinutes: 40,
    reserveFraction: 0.25,
    payloadKg: 5,
    climbSecondsPerMetre: 0.5,
  },
  quadFpv: {
    id: "quadFpv",
    label: "FPV quadcopter",
    airborne: true,
    heightAboveGround: 30,
    maxSlopeDeg: Infinity,
    speed: 25,
    climbPenalty: 2,
    enduranceMinutes: 15,
    reserveFraction: 0.25,
    payloadKg: 2,
    climbSecondsPerMetre: 0.4,
  },
  porter: {
    id: "porter",
    label: "Porter on foot",
    airborne: false,
    heightAboveGround: 1.7,
    maxSlopeDeg: 35,
    speed: 1.1,
    climbPenalty: 10,
    enduranceMinutes: 480,
    reserveFraction: 0.15,
    payloadKg: 20,
    climbSecondsPerMetre: 8.0,
  },
  cargoQuad: {
    id: "cargoQuad",
    label: "Cargo quadcopter",
    airborne: true,
    heightAboveGround: 60,
    maxSlopeDeg: Infinity,
    speed: 14,
    climbPenalty: 4,
    enduranceMinutes: 30,
    reserveFraction: 0.25,
    payloadKg: 25,
    climbSecondsPerMetre: 0.8,
  },
};

// Can this platform actually complete this route?
//
// A route the geometry likes is worthless if the vehicle runs out of battery
// halfway along it. Level distance and total ascent are charged separately,
// because climbing 1400 m of Carpathian ridge costs a tracked UGV far more
// than the same distance on the flat.
export function checkEndurance(route, vehicle) {
  const usableSeconds =
    vehicle.enduranceMinutes * 60 * (1 - vehicle.reserveFraction);
  const levelSeconds = route.metres / vehicle.speed;
  const climbSeconds = route.ascentMetres * vehicle.climbSecondsPerMetre;
  const requiredSeconds = levelSeconds + climbSeconds;

  return {
    usableSeconds: usableSeconds,
    levelSeconds: levelSeconds,
    climbSeconds: climbSeconds,
    requiredSeconds: requiredSeconds,
    feasible: requiredSeconds <= usableSeconds,
    // Positive means spare capacity, negative means short by that fraction.
    marginFraction: (usableSeconds - requiredSeconds) / usableSeconds,
    // How far this platform could go on the level with no climbing at all.
    levelRangeMetres: usableSeconds * vehicle.speed,
  };
}

export function describeEndurance(endurance) {
  const minutes = (s) => (s / 60).toFixed(0) + " min";
  if (endurance.feasible) {
    return (
      "FEASIBLE, needs " + minutes(endurance.requiredSeconds) +
      " of " + minutes(endurance.usableSeconds) + " usable (" +
      (endurance.marginFraction * 100).toFixed(0) + "% spare)"
    );
  }
  return (
    "NOT FEASIBLE, needs " + minutes(endurance.requiredSeconds) +
    " but only " + minutes(endurance.usableSeconds) + " usable (short by " +
    (-endurance.marginFraction * 100).toFixed(0) + "%)"
  );
}

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
export function computeTrafficable(dem, vehicle, slope, obstacleHeight) {
  const passable = new Uint8Array(dem.width * dem.height);
  const clearance = vehicle.obstacleClearance === undefined ? 5 : vehicle.obstacleClearance;

  if (vehicle.airborne) {
    // An aircraft is stopped by an obstacle only when the obstacle reaches its
    // operating height. A 20 m building blocks a quadcopter cruising at 5 m and
    // does not trouble one at 30 m. This is the whole difference between the
    // two classes and it is why the same obstacle grid gives different answers
    // per platform rather than one shared no-go map.
    if (!obstacleHeight) {
      passable.fill(1);
      return passable;
    }
    for (let i = 0; i < passable.length; i++) {
      passable[i] = obstacleHeight[i] + clearance <= vehicle.heightAboveGround ? 1 : 0;
    }
    return passable;
  }

  // A ground vehicle goes around anything standing on the surface, whatever
  // its height, and around ground too steep to climb.
  for (let i = 0; i < passable.length; i++) {
    const slopeOk = slope[i] <= vehicle.maxSlopeDeg;
    const clearGround = !obstacleHeight || obstacleHeight[i] <= 0;
    passable[i] = slopeOk && clearGround ? 1 : 0;
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


// Resolve the mission's vehicle input into the platforms to plan for.
//
// Accepts either a class - "ground" or "air" - or a specific platform id.
// A class is usually what a planner actually knows ("we are sending a UGV"),
// and it returns every platform in that class so the trade-off between them
// stays visible rather than being decided silently.
export class VehicleInputError extends Error {}

export const VEHICLE_CLASSES = {
  ground: ["porter", "ugvTracked", "ugvWheeled"],
  air: ["quadNap", "quadLow", "quadFpv", "cargoQuad"],
  all: ["porter", "ugvTracked", "ugvWheeled", "quadNap", "quadLow", "quadFpv", "cargoQuad"],
};

export function resolveVehicles(input) {
  if (input === undefined || input === null || input === "") {
    throw new VehicleInputError(
      'mission.vehicle is required. Use "ground", "air", "all", or a platform id: ' +
      Object.keys(VEHICLES).join(", ")
    );
  }

  const key = String(input).toLowerCase().trim();

  if (VEHICLE_CLASSES[key]) {
    return {
      label: key === "all" ? "every platform" : key + " vehicles",
      isClass: true,
      vehicles: VEHICLE_CLASSES[key].map((id) => VEHICLES[id]),
    };
  }

  // Case-insensitive match on a specific platform id.
  for (const id of Object.keys(VEHICLES)) {
    if (id.toLowerCase() === key) {
      return { label: VEHICLES[id].label, isClass: false, vehicles: [VEHICLES[id]] };
    }
  }

  throw new VehicleInputError(
    'mission.vehicle "' + input + '" is not recognised.\n' +
    "  Classes: ground, air, all\n" +
    "  Platforms: " + Object.keys(VEHICLES).join(", ")
  );
}
