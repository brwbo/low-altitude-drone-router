// Being heard.
//
// The safety position admits the tool ignores acoustic detection while noting
// that a low quadcopter is loud. For the platforms this plans for, sound is
// often the sensor that actually works: it needs no line of sight to the
// airframe, it is unaffected by darkness, and a rotor is a loud, distinctive,
// low-frequency source.
//
// The model is deliberately crude and its terms are named so nobody mistakes
// it for acoustics:
//
//   spreading   sound falls 6 dB per doubling of distance, so 20*log10(r)
//   barrier     terrain between source and listener attenuates further; the
//               same viewshed that decides whether you are SEEN decides
//               whether the sound path is blocked
//   threshold   a listener detects the vehicle when what arrives exceeds the
//               ambient background
//
// Missing: atmospheric absorption by frequency, wind gradient and temperature
// inversion effects (which can carry sound many kilometres or kill it at a few
// hundred metres), ground reflection, and any real barrier diffraction model.
//
// AND MOST IMPORTANTLY, THIS MODELS A BARE LISTENER, NOT A SENSOR. It asks
// whether the sound arriving beats the background at a single point. A real
// acoustic detection system is a microphone array doing correlation against a
// known rotor signature, which pulls a target out of noise the threshold test
// here would call inaudible - fielded systems detect at kilometre ranges where
// this model says a few hundred metres.
//
// So the ranges it produces are LOWER BOUNDS and should never be quoted as
// detection ranges. Treat the output as an ordering between platforms and
// between positions, not as a distance.

// SOURCE LEVELS ARE PLANNING PLACEHOLDERS, NOT MEASUREMENTS. Decibels at one
// metre. Nobody put a meter next to any of these airframes.
export const SOURCE_LEVELS = {
  quadNap: 88,
  quadLow: 88,
  quadFpv: 92,
  cargoQuad: 95,
  ugvTracked: 78,
  ugvWheeled: 72,
  porter: 40,
};

export const DEFAULT_AMBIENT_DB = 38;
export const BARRIER_LOSS_DB = 15;

export function sourceLevelFor(vehicle) {
  if (Number.isFinite(vehicle.sourceLevelDb)) {
    return vehicle.sourceLevelDb;
  }
  return SOURCE_LEVELS[vehicle.id] === undefined ? 85 : SOURCE_LEVELS[vehicle.id];
}

// What arrives at a listener at the given range, with or without terrain in
// the way.
export function receivedLevel(sourceDb, rangeMetres, blocked) {
  const range = Math.max(1, rangeMetres);
  let level = sourceDb - 20 * Math.log10(range);
  if (blocked) {
    level = level - BARRIER_LOSS_DB;
  }
  return level;
}

// The range at which a vehicle becomes inaudible over the background.
export function audibleRange(sourceDb, ambientDb, blocked) {
  const budget = sourceDb - ambientDb - (blocked ? BARRIER_LOSS_DB : 0);
  if (budget <= 0) {
    return 0;
  }
  return Math.pow(10, budget / 20);
}

// Per-cell audibility from one listener. Terrain blocking is taken from a
// ceiling grid: where the vehicle is below the ceiling it is out of sight, and
// the sound path is treated as obstructed.
export function computeAudibility(dem, listener, ceiling, vehicle, options) {
  const opts = options || {};
  const ambient = opts.ambientDb === undefined ? DEFAULT_AMBIENT_DB : opts.ambientDb;
  const heightAboveGround = opts.heightAboveGround === undefined
    ? vehicle.heightAboveGround
    : opts.heightAboveGround;
  const source = sourceLevelFor(vehicle);

  const audible = new Uint8Array(dem.width * dem.height);
  const margin = new Float32Array(dem.width * dem.height);

  for (let y = 0; y < dem.height; y++) {
    for (let x = 0; x < dem.width; x++) {
      const i = y * dem.width + x;
      const dx = (x - listener.x) * dem.cellSize;
      const dy = (y - listener.y) * dem.cellSize;
      const range = Math.hypot(dx, dy);
      const blocked = dem.elev[i] + heightAboveGround <= ceiling[i];
      const level = receivedLevel(source, range, blocked);
      margin[i] = level - ambient;
      audible[i] = level > ambient ? 1 : 0;
    }
  }

  return { audible: audible, marginDb: margin, sourceDb: source, ambientDb: ambient };
}

// Time spent audible along a route, which is the acoustic analogue of time in
// view and is often much longer.
export function assessAcoustic(dem, trace, audibleGrids, speed) {
  let audibleCells = 0;
  let longestRun = 0;
  let currentRun = 0;

  for (const index of trace) {
    let heard = false;
    for (const grid of audibleGrids) {
      if (grid[index] === 1) heard = true;
    }
    if (heard) {
      audibleCells = audibleCells + 1;
      currentRun = currentRun + 1;
      if (currentRun > longestRun) longestRun = currentRun;
    } else {
      currentRun = 0;
    }
  }

  const perCell = dem.cellSize / speed;
  return {
    audibleSeconds: audibleCells * perCell,
    longestAudibleRun: longestRun * perCell,
    audibleFraction: trace.length === 0 ? 0 : audibleCells / trace.length,
  };
}
