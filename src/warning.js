// Observer siting for civilian early warning.
//
// The obvious objective is wrong. Maximising the airspace a spotter network
// can see puts observers where the view is best, which tends to be near the
// thing being protected - and an observer standing in the town sees the drone
// perfectly while giving nobody any time to move.
//
// The objective that matters is WARNING TIME: how long between the first
// observer acquiring the drone and it arriving overhead. That rewards
// observers placed far out along the approach, which is the opposite of what
// coverage maximisation produces.
//
// And the quantity to maximise is the WORST approach bearing, not the average.
// A network that gives six minutes from the north and forty seconds from the
// south protects nobody from the south.

import { computeCeiling } from "./viewshed.js";

// DRONE SPEED IS A PLANNING PLACEHOLDER, NOT A MEASURED FIGURE. It scales
// every number this module produces. State the assumption whenever a warning
// time is quoted.
export const DEFAULT_CRUISE_SPEED = 50; // metres per second

// Sample points along a ray leaving the town on a given bearing.
function approachRay(dem, town, bearingDeg, maxRangeMetres, stepMetres) {
  const radians = (bearingDeg * Math.PI) / 180;
  // Bearing is clockwise from north; y increases south.
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);

  const points = [];
  for (let distance = stepMetres; distance <= maxRangeMetres; distance += stepMetres) {
    const cells = distance / dem.cellSize;
    const x = Math.round(town.x + dx * cells);
    const y = Math.round(town.y + dy * cells);
    if (x < 0 || y < 0 || x >= dem.width || y >= dem.height) {
      break;
    }
    points.push({ x: x, y: y, index: y * dem.width + x, distance: distance });
  }
  return points;
}

export function buildApproaches(dem, town, options) {
  const opts = options || {};
  const bearings = opts.bearings || [0, 45, 90, 135, 180, 225, 270, 315];
  const maxRangeMetres = opts.maxRangeMetres === undefined ? 18000 : opts.maxRangeMetres;
  const stepMetres = opts.stepMetres === undefined ? 150 : opts.stepMetres;

  const approaches = [];
  for (const bearing of bearings) {
    approaches.push({
      bearing: bearing,
      points: approachRay(dem, town, bearing, maxRangeMetres, stepMetres),
    });
  }
  return approaches;
}

// The furthest point on each approach at which this observer would acquire the
// drone. Distance, not visibility, is what converts to warning time.
//
// Drone altitude is treated as height above sea level rather than above
// ground, because an incoming aircraft holds a roughly constant altitude
// rather than following the terrain.
export function detectionRanges(dem, observer, approaches, options) {
  const opts = options || {};
  const observerHeight = opts.observerHeight === undefined ? 1.7 : opts.observerHeight;
  const droneAltitudeMetres = opts.droneAltitudeMetres === undefined ? 1200 : opts.droneAltitudeMetres;
  const sensorRangeMetres = opts.sensorRangeMetres === undefined ? 15000 : opts.sensorRangeMetres;

  const ceiling = computeCeiling(dem, observer, {
    observerHeight: observerHeight,
    maxRangeMetres: sensorRangeMetres,
  });

  const ranges = [];
  for (const approach of approaches) {
    let furthest = 0;
    for (const point of approach.points) {
      // Beyond what the naked eye or a handheld optic can resolve, seeing it
      // geometrically is not the same as detecting it.
      const straightLine = Math.hypot(
        (point.x - observer.x) * dem.cellSize,
        (point.y - observer.y) * dem.cellSize
      );
      if (straightLine > sensorRangeMetres) {
        continue;
      }
      if (droneAltitudeMetres > ceiling[point.index]) {
        if (point.distance > furthest) {
          furthest = point.distance;
        }
      }
    }
    ranges.push(furthest);
  }
  return ranges;
}

// Greedy selection on worst-case warning time.
//
// Warning from a network is the EARLIEST acquisition by any observer, so
// adding one can only help - which means the greedy step is to pick whichever
// candidate most raises the weakest approach.
export function selectObservers(dem, town, candidates, count, options) {
  const opts = options || {};
  const speed = opts.cruiseSpeed === undefined ? DEFAULT_CRUISE_SPEED : opts.cruiseSpeed;
  const approaches = buildApproaches(dem, town, opts);

  const perCandidate = [];
  for (const candidate of candidates) {
    perCandidate.push(detectionRanges(dem, candidate, approaches, opts));
  }

  // Best detection distance achieved on each bearing so far.
  const best = new Array(approaches.length).fill(0);
  const chosen = [];

  for (let round = 0; round < count; round++) {
    let bestIndex = -1;
    let bestWorst = worstOf(best);

    for (let c = 0; c < candidates.length; c++) {
      if (chosen.some((entry) => entry.candidateIndex === c)) {
        continue;
      }
      const merged = mergeBest(best, perCandidate[c]);
      const worst = worstOf(merged);
      if (worst > bestWorst) {
        bestWorst = worst;
        bestIndex = c;
      }
    }

    // Nothing improves the weakest approach. Fall back to whatever most
    // improves the total, so extra observers are not simply discarded.
    if (bestIndex === -1) {
      let bestTotal = sumOf(best);
      for (let c = 0; c < candidates.length; c++) {
        if (chosen.some((entry) => entry.candidateIndex === c)) {
          continue;
        }
        const total = sumOf(mergeBest(best, perCandidate[c]));
        if (total > bestTotal) {
          bestTotal = total;
          bestIndex = c;
        }
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const merged = mergeBest(best, perCandidate[bestIndex]);
    for (let i = 0; i < best.length; i++) {
      best[i] = merged[i];
    }

    chosen.push({
      candidateIndex: bestIndex,
      site: candidates[bestIndex],
      elevation: dem.elev[candidates[bestIndex].y * dem.width + candidates[bestIndex].x],
      worstWarningSeconds: worstOf(best) / speed,
      meanWarningSeconds: (sumOf(best) / best.length) / speed,
      perBearingSeconds: best.map((d) => d / speed),
    });
  }

  return {
    approaches: approaches,
    sites: chosen,
    detectionByBearing: best,
    worstWarningSeconds: worstOf(best) / speed,
    meanWarningSeconds: (sumOf(best) / best.length) / speed,
    cruiseSpeed: speed,
  };
}

function mergeBest(current, incoming) {
  const merged = new Array(current.length);
  for (let i = 0; i < current.length; i++) {
    merged[i] = Math.max(current[i], incoming[i]);
  }
  return merged;
}

function worstOf(values) {
  let worst = Infinity;
  for (const value of values) {
    if (value < worst) {
      worst = value;
    }
  }
  return worst === Infinity ? 0 : worst;
}

function sumOf(values) {
  let total = 0;
  for (const value of values) {
    total = total + value;
  }
  return total;
}

// What one observer standing in the town itself achieves. The baseline the
// whole argument rests on, so it is worth computing rather than asserting.
export function warningFromTownItself(dem, town, options) {
  const opts = options || {};
  const speed = opts.cruiseSpeed === undefined ? DEFAULT_CRUISE_SPEED : opts.cruiseSpeed;
  const approaches = buildApproaches(dem, town, opts);
  const ranges = detectionRanges(dem, town, approaches, opts);
  return {
    perBearingSeconds: ranges.map((d) => d / speed),
    worstWarningSeconds: worstOf(ranges) / speed,
    meanWarningSeconds: (sumOf(ranges) / ranges.length) / speed,
  };
}
