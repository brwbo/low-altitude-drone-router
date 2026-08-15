// Where the vehicle can still talk to its operator.
//
// Terrain masking is presented as free. It is not. The same ridge that hides
// you from a threat hides you from your own control station, and a beautifully
// concealed corridor that runs through a communications hole is a lost
// vehicle rather than a clever route.
//
// This is the viewshed run from the operator's antenna instead of a threat's,
// with the sign reversed: in view is GOOD. Reusing computeCeiling means the
// link model is exactly as good as the concealment model and no better, which
// is the honest position - both are line of sight over terrain.
//
// What this is not: a radio propagation model. It has no term for transmit
// power, antenna gain, frequency, Fresnel clearance, diffraction over a knife
// edge, or noise. Real links bend slightly around terrain and real links fail
// well inside line of sight. This answers the geometric question only, which
// is the one that dominates in mountains.

import { computeCeiling } from "./viewshed.js";

export function computeLinkCeiling(dem, station, options) {
  const opts = options || {};
  return computeCeiling(dem, station, {
    observerHeight: opts.antennaHeight === undefined ? 3 : opts.antennaHeight,
    maxRangeMetres: opts.maxRangeMetres === undefined ? 20000 : opts.maxRangeMetres,
    surface: opts.surface,
  });
}

// A vehicle at heightAboveGround is in contact where it rises above the
// station's horizon - the same test as being seen by a threat, wanted rather
// than avoided.
export function inContact(dem, linkCeiling, heightAboveGround) {
  const contact = new Uint8Array(dem.width * dem.height);
  for (let i = 0; i < contact.length; i++) {
    contact[i] = dem.elev[i] + heightAboveGround > linkCeiling[i] ? 1 : 0;
  }
  return contact;
}

// Contact along a route, and specifically the longest stretch without it.
// Total time out of contact matters less than the longest single blackout: a
// vehicle that drops out for two seconds at a time is fine, one that goes dark
// for four minutes over a ridge may not come back.
export function assessLink(dem, trace, contact, speed) {
  let inContactCells = 0;
  let longestBlackoutCells = 0;
  let currentBlackout = 0;
  let blackoutCount = 0;
  const blackouts = [];

  for (let i = 0; i < trace.length; i++) {
    if (contact[trace[i]] === 1) {
      if (currentBlackout > 0) {
        blackouts.push({ endIndex: i - 1, cells: currentBlackout });
        blackoutCount = blackoutCount + 1;
      }
      currentBlackout = 0;
      inContactCells = inContactCells + 1;
    } else {
      currentBlackout = currentBlackout + 1;
      if (currentBlackout > longestBlackoutCells) {
        longestBlackoutCells = currentBlackout;
      }
    }
  }
  if (currentBlackout > 0) {
    blackouts.push({ endIndex: trace.length - 1, cells: currentBlackout });
    blackoutCount = blackoutCount + 1;
  }

  const perCellSeconds = dem.cellSize / speed;
  return {
    contactFraction: trace.length === 0 ? 0 : inContactCells / trace.length,
    longestBlackoutSeconds: longestBlackoutCells * perCellSeconds,
    longestBlackoutMetres: longestBlackoutCells * dem.cellSize,
    blackoutCount: blackoutCount,
    blackouts: blackouts,
  };
}

// Cells that are both hidden from every threat and still in contact. This is
// the corridor a planner can actually use, as opposed to the one that merely
// looks good.
export function usableCorridor(dem, ceiling, contact, heightAboveGround) {
  const usable = new Uint8Array(dem.width * dem.height);
  for (let i = 0; i < usable.length; i++) {
    const hidden = dem.elev[i] + heightAboveGround <= ceiling[i];
    usable[i] = hidden && contact[i] === 1 ? 1 : 0;
  }
  return usable;
}
