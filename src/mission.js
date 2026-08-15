// Missions with more than two points.
//
// Real tasks are rarely a single hop. A resupply run visits two villages and
// returns. A reconnaissance sortie has a loiter box in the middle. A casualty
// pickup goes out empty and comes back heavy. Planning each leg separately and
// adding the numbers up gets the geometry right and the ARITHMETIC wrong,
// because endurance is consumed across the whole sortie, not per leg.
//
// So this plans every leg with the same pathfinder and then accounts for the
// mission as one journey.

import { findPath } from "./pathfind.js";
import { checkEndurance } from "./vehicles.js";

export class MissionError extends Error {}

// waypoints: [{x, y, label, dwellSeconds}], at least two.
export function planMission(dem, waypoints, grids, options) {
  const opts = options || {};
  const vehicle = opts.vehicle;

  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    throw new MissionError("a mission needs at least a start and a goal");
  }

  const legs = [];
  for (let i = 0; i + 1 < waypoints.length; i++) {
    const from = waypoints[i];
    const to = waypoints[i + 1];
    const leg = findPath(dem, from, to, grids, opts);

    if (!leg.found) {
      return {
        complete: false,
        failedLeg: i,
        reason: "leg " + (i + 1) + " (" + (from.label || i) + " to " +
          (to.label || (i + 1)) + "): " + leg.reason,
        legs: legs,
      };
    }

    legs.push({
      from: from,
      to: to,
      route: leg,
      dwellSeconds: Number.isFinite(to.dwellSeconds) ? to.dwellSeconds : 0,
    });
  }

  // Totals across the whole sortie. Dwell counts against endurance - a vehicle
  // holding over a drop point is still burning - and counts as exposure if the
  // point it holds over is in view, which is the case worth flagging.
  let metres = 0;
  let seconds = 0;
  let exposedSeconds = 0;
  let ascentMetres = 0;
  let descentMetres = 0;
  let dwellSeconds = 0;
  let exposedDwellSeconds = 0;
  const trace = [];

  for (const leg of legs) {
    metres = metres + leg.route.metres;
    seconds = seconds + leg.route.seconds;
    exposedSeconds = exposedSeconds + leg.route.exposedSeconds;
    ascentMetres = ascentMetres + leg.route.ascentMetres;
    descentMetres = descentMetres + leg.route.descentMetres;
    dwellSeconds = dwellSeconds + leg.dwellSeconds;

    const holdIndex = leg.to.y * dem.width + leg.to.x;
    if (leg.dwellSeconds > 0 && grids.exposure && grids.exposure[holdIndex] > 0) {
      exposedDwellSeconds = exposedDwellSeconds + leg.dwellSeconds;
    }

    for (let i = trace.length === 0 ? 0 : 1; i < leg.route.trace.length; i++) {
      trace.push(leg.route.trace[i]);
    }
  }

  const totals = {
    metres: metres,
    seconds: seconds + dwellSeconds,
    movingSeconds: seconds,
    dwellSeconds: dwellSeconds,
    exposedSeconds: exposedSeconds + exposedDwellSeconds,
    exposedDwellSeconds: exposedDwellSeconds,
    ascentMetres: ascentMetres,
    descentMetres: descentMetres,
  };

  // Endurance is charged against the whole sortie including dwell, which is
  // the point of planning it as one mission rather than a set of hops.
  const endurance = vehicle
    ? checkEndurance(
        { metres: metres, ascentMetres: ascentMetres },
        vehicle
      )
    : null;
  if (endurance) {
    endurance.requiredSeconds = endurance.requiredSeconds + dwellSeconds;
    endurance.feasible = endurance.requiredSeconds <= endurance.usableSeconds;
    endurance.marginFraction =
      (endurance.usableSeconds - endurance.requiredSeconds) / endurance.usableSeconds;
  }

  return {
    complete: true,
    legs: legs,
    trace: trace,
    totals: totals,
    endurance: endurance,
  };
}

// A there-and-back sortie from the same base, which is the common case.
export function outAndBack(base, stops) {
  const waypoints = [base];
  for (const stop of stops) {
    waypoints.push(stop);
  }
  waypoints.push({ ...base, label: (base.label || "base") + " (return)" });
  return waypoints;
}
