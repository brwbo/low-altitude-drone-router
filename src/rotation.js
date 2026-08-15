// Not flying the same corridor every day.
//
// A route optimiser is deterministic by design, which is a virtue right up
// until it becomes the problem. Give it the same terrain and the same threats
// and it returns the same corridor every time - so a unit that follows its
// advice flies the same line daily, and the line gets watched. The best route
// by geometry becomes the worst route by pattern.
//
// This is a real and well-understood failure: the optimal path is predictable
// precisely because it is optimal, and predictability is itself a threat that
// none of the geometry can see.
//
// The fix is to generate several genuinely different routes and rotate. Each
// pass penalises the cells the previous routes used, so the router is pushed
// into a different valley rather than nudged a few cells sideways. The output
// is a set with a stated cost spread, so a planner can see what variety costs.

import { findPath } from "./pathfind.js";

export function planRotation(dem, start, goal, grids, options) {
  const opts = options || {};
  const count = opts.count === undefined ? 3 : opts.count;
  // Cost added to a cell already used by a previous route, expressed in the
  // same units as distance. High enough to push into another valley rather
  // than shift by a few cells.
  const reusePenalty = opts.reusePenalty === undefined ? 4000 : opts.reusePenalty;
  // Cells within this radius of a used cell are also penalised, so two routes
  // running parallel a few cells apart do not count as different.
  const corridorRadius = opts.corridorRadius === undefined ? 12 : opts.corridorRadius;

  const cellCount = dem.width * dem.height;
  const used = new Float32Array(cellCount);
  const routes = [];

  for (let attempt = 0; attempt < count; attempt++) {
    // The penalty rides on the exposure channel, which the pathfinder already
    // weights, so no new cost term is needed inside it.
    const exposure = new Float32Array(cellCount);
    const base = grids.exposure;
    for (let i = 0; i < cellCount; i++) {
      exposure[i] = (base ? base[i] : 0) + used[i];
    }

    const route = findPath(dem, start, goal,
      { ...grids, exposure: exposure },
      { ...opts, exposurePenalty: opts.exposurePenalty === undefined ? 50 : opts.exposurePenalty });

    if (!route.found) {
      break;
    }

    routes.push(route);

    // Paint this route, and a corridor around it, as used.
    for (const index of route.trace) {
      const cx = index % dem.width;
      const cy = (index - cx) / dem.width;
      for (let dy = -corridorRadius; dy <= corridorRadius; dy++) {
        for (let dx = -corridorRadius; dx <= corridorRadius; dx++) {
          if (dx * dx + dy * dy > corridorRadius * corridorRadius) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= dem.width || y >= dem.height) continue;
          used[y * dem.width + x] = reusePenalty / 1000;
        }
      }
    }
  }

  return { routes: routes, overlap: overlapMatrix(routes) };
}

// How much any two routes share. A rotation whose members overlap heavily is
// not a rotation, and this is the number that says so.
export function overlapMatrix(routes) {
  const matrix = [];
  for (let a = 0; a < routes.length; a++) {
    const row = [];
    const setA = new Set(routes[a].trace);
    for (let b = 0; b < routes.length; b++) {
      if (a === b) {
        row.push(1);
        continue;
      }
      let shared = 0;
      for (const index of routes[b].trace) {
        if (setA.has(index)) shared = shared + 1;
      }
      row.push(shared / Math.min(setA.size, routes[b].trace.length));
    }
    matrix.push(row);
  }
  return matrix;
}

// The worst pairwise overlap in the set, which is the number worth quoting.
export function worstOverlap(matrix) {
  let worst = 0;
  for (let a = 0; a < matrix.length; a++) {
    for (let b = 0; b < matrix.length; b++) {
      if (a !== b && matrix[a][b] > worst) worst = matrix[a][b];
    }
  }
  return worst;
}

// What variety costs: the spread in exposure across the set. A planner rotating
// through these accepts the worst one sometimes, so the worst one is the number
// that matters, not the average.
export function rotationCost(routes) {
  if (routes.length === 0) {
    return null;
  }
  const exposures = routes.map((r) => r.exposedSeconds);
  const distances = routes.map((r) => r.metres);
  return {
    bestExposedSeconds: Math.min(...exposures),
    worstExposedSeconds: Math.max(...exposures),
    meanExposedSeconds: exposures.reduce((a, b) => a + b, 0) / exposures.length,
    shortestMetres: Math.min(...distances),
    longestMetres: Math.max(...distances),
  };
}
