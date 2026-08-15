// Last-mile reachability when the roads have gone.
//
// SCOPE, STATED UP FRONT: there is no road network in this model. Every route
// here is cross-country. That makes it wrong for normal logistics and right
// for the case it is built for - roads cut, bridges down, a hub that can no
// longer reach the settlements it serves by the usual means.
//
// The question is not "what is the fastest route". It is "which of these
// places can still be reached at all, by what, and how many trips does it
// take to deliver what they need".
//
// Three things decide it:
//   trafficability - can this vehicle physically cross the ground
//   round trip     - it has to come back, which doubles distance and makes
//                    every metre descended on the way out a metre climbed on
//                    the way home
//   payload        - one delivery is rarely one trip

import { computeSlope, computeTrafficable, checkEndurance } from "./vehicles.js";
import { findPath } from "./pathfind.js";

// A delivery vehicle must return, so endurance is charged against the whole
// there-and-back journey. Total ascent for the round trip is the outbound
// ascent plus the outbound descent, because every drop on the way out is a
// climb on the way back.
export function roundTrip(route) {
  return {
    metres: route.metres * 2,
    ascentMetres: route.ascentMetres + route.descentMetres,
  };
}

export function sortiesNeeded(demandKg, payloadKg) {
  if (payloadKg <= 0) {
    return Infinity;
  }
  return Math.ceil(demandKg / payloadKg);
}

// Can this vehicle serve this settlement, and at what cost?
export function assessDelivery(dem, hub, settlement, vehicle, grids, options) {
  const opts = options || {};

  // Dijkstra, not candidate sampling. Sampling perturbs a straight line, which
  // cannot find a valley thirty degrees off the bearing and reported every
  // settlement here as unreachable when good routes existed.
  const route = findPath(dem, hub, settlement, grids, { vehicle: vehicle });
  if (!route.found) {
    return {
      vehicle: vehicle,
      settlement: settlement,
      route: null,
      unreachableReason: route.reason,
      deliverable: false,
      blockedCells: Infinity,
      sorties: sortiesNeeded(settlement.demandKg || 0, vehicle.payloadKg || 0),
      oneWayKm: Infinity,
      roundTripKm: Infinity,
      roundTripAscent: Infinity,
      endurance: null,
      totalHours: Infinity,
    };
  }

  const trip = roundTrip(route);
  const endurance = checkEndurance(trip, vehicle);
  const sorties = sortiesNeeded(settlement.demandKg || 0, vehicle.payloadKg || 0);

  // Dijkstra never returns a path over impassable ground, so a route that
  // exists is always traversable. What can still fail is endurance.
  const blocked = false;

  return {
    vehicle: vehicle,
    settlement: settlement,
    route: route,
    oneWayKm: route.metres / 1000,
    roundTripKm: trip.metres / 1000,
    roundTripAscent: trip.ascentMetres,
    endurance: endurance,
    blockedCells: route.blockedCells,
    sorties: sorties,
    // Total time to satisfy the settlement's demand, ignoring turnaround.
    totalHours: (endurance.requiredSeconds * sorties) / 3600,
    deliverable: !blocked && endurance.feasible && Number.isFinite(sorties),
  };
}

// For each settlement, which vehicles in the fleet can actually serve it, and
// which is the cheapest that can.
export function assessFleet(dem, hub, settlements, fleet, options) {
  const opts = options || {};
  const slope = opts.slope || computeSlope(dem);

  const results = [];
  for (const settlement of settlements) {
    const byVehicle = [];
    for (const vehicle of fleet) {
      const passable = computeTrafficable(dem, vehicle, slope);
      const grids = {
        passable: passable,
        exposure: new Uint8Array(dem.width * dem.height),
        shadow: null,
        elev: dem.elev,
      };
      byVehicle.push(assessDelivery(dem, hub, settlement, vehicle, grids, opts));
    }

    const capable = byVehicle.filter((entry) => entry.deliverable);
    capable.sort((a, b) => a.totalHours - b.totalHours);

    results.push({
      settlement: settlement,
      byVehicle: byVehicle,
      capable: capable,
      best: capable.length > 0 ? capable[0] : null,
      cutOff: capable.length === 0,
    });
  }

  return results;
}

// The smallest set of vehicle types that between them reach everything
// reachable. Greedy, same reasoning as coverage siting: an exact answer would
// not move a single decision.
export function minimumFleet(assessment) {
  const servedBy = new Map();
  for (const row of assessment) {
    if (row.cutOff) {
      continue;
    }
    for (const entry of row.capable) {
      if (!servedBy.has(entry.vehicle.id)) {
        servedBy.set(entry.vehicle.id, { vehicle: entry.vehicle, settlements: new Set() });
      }
      servedBy.get(entry.vehicle.id).settlements.add(row.settlement.label);
    }
  }

  const outstanding = new Set(
    assessment.filter((row) => !row.cutOff).map((row) => row.settlement.label)
  );
  const chosen = [];

  while (outstanding.size > 0) {
    let bestId = null;
    let bestGain = 0;
    for (const [id, record] of servedBy) {
      if (chosen.some((entry) => entry.vehicle.id === id)) {
        continue;
      }
      let gain = 0;
      for (const label of record.settlements) {
        if (outstanding.has(label)) {
          gain = gain + 1;
        }
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestId = id;
      }
    }
    if (bestId === null) {
      break;
    }
    const record = servedBy.get(bestId);
    for (const label of record.settlements) {
      outstanding.delete(label);
    }
    chosen.push({ vehicle: record.vehicle, newlyServed: bestGain });
  }

  return { fleet: chosen, unreachable: Array.from(outstanding) };
}
