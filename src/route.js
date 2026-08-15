// Route selection by scoring sampled candidate paths.
//
// Deliberately NOT A*. JavaScript has no built-in priority queue, so grid A*
// means writing a binary heap first, and that is time spent producing nothing
// visible. Perturbing the straight line a few hundred times and keeping the
// best-scoring path gives a route that looks the same on screen and takes a
// fraction of the effort.

// Sustained rise, in metres, before it counts as climbing. Below this it is
// elevation-model noise, not a hill.
const ASCENT_THRESHOLD = 8;

// Deterministic generator, so the same seed always yields the same route.
// A route that changes between the rehearsal and the demo is not a route.
function makeRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Walks a polyline cell by cell and totals its cost.
function scorePath(dem, points, grids, options) {
  const width = dem.width;
  const cellSize = dem.cellSize;
  const speed = options.groundSpeedMetresPerSecond;
  const exposurePenalty = options.exposurePenalty;
  const shadowBonus = options.shadowBonus;

  let metres = 0;
  let exposedSeconds = 0;
  let shadowedSeconds = 0;
  let blockedCells = 0;
  let ascentMetres = 0;
  let descentMetres = 0;
  let cost = 0;
  let climbReference = null;
  const trace = [];

  for (let leg = 0; leg < points.length - 1; leg++) {
    const from = points[leg];
    const to = points[leg + 1];
    const legCells = Math.max(
      1,
      Math.ceil(Math.hypot(to.x - from.x, to.y - from.y))
    );

    for (let step = 0; step < legCells; step++) {
      const t = step / legCells;
      const x = Math.round(from.x + (to.x - from.x) * t);
      const y = Math.round(from.y + (to.y - from.y) * t);

      if (x < 0 || y < 0 || x >= dem.width || y >= dem.height) {
        return null;
      }

      const index = y * width + x;
      const segmentMetres = cellSize;
      const segmentSeconds = segmentMetres / speed;

      metres = metres + segmentMetres;
      trace.push(index);

      // Ground that this vehicle physically cannot cross. For a UGV that is a
      // slope it cannot climb; for a rotary aircraft this is always passable.
      if (grids.passable !== undefined && grids.passable[index] === 0) {
        blockedCells = blockedCells + 1;
        cost = cost + options.blockedPenalty;
      } else if (grids.headroom !== undefined && grids.headroom[index] <= 0) {
        blockedCells = blockedCells + 1;
        cost = cost + options.blockedPenalty;
      }

      // Climbing costs energy, and it costs a UGV far more than an aircraft.
      //
      // Ascent uses a hysteresis threshold rather than summing every positive
      // step. Adding up 30 m cell-to-cell deltas over a 50 km route counts
      // every ripple in the elevation model as a hill and inflates total climb
      // several times over - the same effect that makes a coastline's length
      // depend on the ruler. Only a sustained rise past ASCENT_THRESHOLD is
      // real climbing.
      const here = grids.elev[index];
      if (climbReference === null) {
        climbReference = here;
      } else if (here > climbReference + ASCENT_THRESHOLD) {
        const rise = here - climbReference;
        ascentMetres = ascentMetres + rise;
        cost = cost + rise * options.climbPenalty;
        climbReference = here;
      } else if (here < climbReference - ASCENT_THRESHOLD) {
        descentMetres = descentMetres + (climbReference - here);
        climbReference = here;
      }

      const seenBy = grids.exposure[index];
      if (seenBy > 0) {
        exposedSeconds = exposedSeconds + segmentSeconds;
        cost = cost + exposurePenalty * segmentSeconds * seenBy;
      }

      if (grids.shadow !== null && grids.shadow[index] === 1) {
        shadowedSeconds = shadowedSeconds + segmentSeconds;
        cost = cost - shadowBonus * segmentSeconds;
      }

      cost = cost + segmentMetres;
    }
  }

  return {
    points: points,
    trace: trace,
    metres: metres,
    seconds: metres / speed,
    exposedSeconds: exposedSeconds,
    shadowedSeconds: shadowedSeconds,
    blockedCells: blockedCells,
    ascentMetres: ascentMetres,
    descentMetres: descentMetres,
    cost: cost,
  };
}

// Builds a candidate by nudging evenly spaced waypoints sideways off the
// straight line between start and goal.
function makeCandidate(start, goal, waypointCount, spreadCells, random) {
  const points = [start];
  const dx = goal.x - start.x;
  const dy = goal.y - start.y;
  const length = Math.hypot(dx, dy);
  const normalX = -dy / length;
  const normalY = dx / length;

  for (let i = 1; i <= waypointCount; i++) {
    const t = i / (waypointCount + 1);
    const offset = (random() * 2 - 1) * spreadCells;
    points.push({
      x: start.x + dx * t + normalX * offset,
      y: start.y + dy * t + normalY * offset,
    });
  }

  points.push(goal);
  return points;
}

export function planRoute(dem, start, goal, grids, options) {
  const opts = options || {};
  const candidates = opts.candidates === undefined ? 400 : opts.candidates;
  const waypointCount = opts.waypoints === undefined ? 4 : opts.waypoints;
  const spreadCells =
    opts.spreadCells === undefined
      ? Math.hypot(goal.x - start.x, goal.y - start.y) * 0.45
      : opts.spreadCells;

  // Speed and climb cost come from the vehicle profile when one is supplied,
  // because a tracked UGV at 2.5 m/s spends ten times as long exposed crossing
  // the same ground as an FPV quad at 25 m/s.
  const vehicle = opts.vehicle || null;
  const scoreOptions = {
    groundSpeedMetresPerSecond:
      opts.groundSpeedMetresPerSecond !== undefined
        ? opts.groundSpeedMetresPerSecond
        : vehicle
          ? vehicle.speed
          : 12,
    climbPenalty:
      opts.climbPenalty !== undefined ? opts.climbPenalty : vehicle ? vehicle.climbPenalty : 3,
    exposurePenalty: opts.exposurePenalty === undefined ? 3000 : opts.exposurePenalty,
    shadowBonus: opts.shadowBonus === undefined ? 40 : opts.shadowBonus,
    blockedPenalty: opts.blockedPenalty === undefined ? 20000 : opts.blockedPenalty,
  };

  const random = makeRandom(opts.seed === undefined ? 1 : opts.seed);

  // The straight line is always candidate zero, so the demo can always show
  // "direct route versus planned route" with a real number on both.
  const direct = scorePath(dem, [start, goal], grids, scoreOptions);

  let best = direct;
  for (let c = 0; c < candidates; c++) {
    const spread = spreadCells * (0.15 + 0.85 * random());
    const points = makeCandidate(start, goal, waypointCount, spread, random);
    const scored = scorePath(dem, points, grids, scoreOptions);
    if (scored === null) {
      continue;
    }
    if (best === null || scored.cost < best.cost) {
      best = scored;
    }
  }

  return { direct: direct, best: best, options: scoreOptions };
}
