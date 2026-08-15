// Coverage siting: the viewshed with the objective inverted.
//
// Routing a vehicle away from a hostile sensor MINIMISES the ground that can
// see it. Siting a radio repeater, or an observation post, MAXIMISES the
// ground that can see it. Identical sweep, opposite sign.
//
// Two problems this solves:
//
//   Search and rescue - a disaster zone loses communications largely because
//   terrain blocks it. Given a search area and N repeaters, where do they go
//   so that every team keeps a link?
//
//   Civilian protection - given a volunteer spotter network, where do the
//   fewest observers cover the most approach airspace?
//
// Both are maximum coverage over a viewshed, solved greedily.

import { computeCeiling } from "./viewshed.js";

// Cells within line of sight of a site. A receiver sitting `receiverHeight`
// above the ground is in contact when it rises above the site's horizon,
// which is the same test the exposure count uses - only here being seen is
// the goal rather than the hazard.
export function computeCoverage(dem, site, options) {
  const opts = options || {};
  const antennaHeight = opts.antennaHeight === undefined ? 10 : opts.antennaHeight;
  const receiverHeight = opts.receiverHeight === undefined ? 1.5 : opts.receiverHeight;
  const maxRangeMetres = opts.maxRangeMetres === undefined ? 15000 : opts.maxRangeMetres;

  const ceiling = computeCeiling(dem, site, {
    observerHeight: antennaHeight,
    maxRangeMetres: maxRangeMetres,
  });

  const covered = new Uint8Array(dem.width * dem.height);
  for (let i = 0; i < covered.length; i++) {
    if (dem.elev[i] + receiverHeight > ceiling[i]) {
      covered[i] = 1;
    }
  }
  return covered;
}

// Fraction of an area of interest that a coverage grid reaches. When no area
// mask is supplied the whole grid counts.
export function coveredFraction(covered, areaMask) {
  let inArea = 0;
  let reached = 0;
  for (let i = 0; i < covered.length; i++) {
    const counts = areaMask === undefined || areaMask === null || areaMask[i] === 1;
    if (!counts) {
      continue;
    }
    inArea = inArea + 1;
    if (covered[i] === 1) {
      reached = reached + 1;
    }
  }
  return inArea === 0 ? 0 : reached / inArea;
}

// Evenly spaced candidate positions, optionally restricted to ground a team
// could actually reach to place equipment on.
export function candidateSites(dem, spacingCells, passable) {
  const sites = [];
  for (let y = Math.floor(spacingCells / 2); y < dem.height; y += spacingCells) {
    for (let x = Math.floor(spacingCells / 2); x < dem.width; x += spacingCells) {
      const index = y * dem.width + x;
      if (passable && passable[index] === 0) {
        continue;
      }
      sites.push({ x: x, y: y });
    }
  }
  return sites;
}

// Greedy maximum coverage: repeatedly pick the site that adds the most ground
// not already covered.
//
// Greedy is the right choice rather than a shortcut. Maximum coverage is
// NP-hard, and the greedy solution is provably within (1 - 1/e), about 63%,
// of the best possible. No exact method fits in a laptop afternoon and none
// would change where the marker goes on the map.
export function selectSites(dem, candidates, count, options) {
  const opts = options || {};
  const areaMask = opts.areaMask || null;

  const cellCount = dem.width * dem.height;
  const alreadyCovered = new Uint8Array(cellCount);

  // Precompute each candidate's coverage once. This is the expensive part and
  // it is why candidate spacing matters more than the number of sites chosen.
  const coverages = [];
  for (const site of candidates) {
    coverages.push(computeCoverage(dem, site, opts));
  }

  let areaSize = 0;
  for (let i = 0; i < cellCount; i++) {
    if (areaMask === null || areaMask[i] === 1) {
      areaSize = areaSize + 1;
    }
  }

  const chosen = [];
  for (let round = 0; round < count; round++) {
    let bestIndex = -1;
    let bestGain = 0;

    for (let c = 0; c < candidates.length; c++) {
      if (chosen.some((entry) => entry.candidateIndex === c)) {
        continue;
      }
      let gain = 0;
      const coverage = coverages[c];
      for (let i = 0; i < cellCount; i++) {
        if (coverage[i] === 1 && alreadyCovered[i] === 0) {
          if (areaMask === null || areaMask[i] === 1) {
            gain = gain + 1;
          }
        }
      }
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = c;
      }
    }

    if (bestIndex === -1) {
      break;
    }

    const coverage = coverages[bestIndex];
    for (let i = 0; i < cellCount; i++) {
      if (coverage[i] === 1) {
        alreadyCovered[i] = 1;
      }
    }

    let cumulative = 0;
    for (let i = 0; i < cellCount; i++) {
      if (alreadyCovered[i] === 1 && (areaMask === null || areaMask[i] === 1)) {
        cumulative = cumulative + 1;
      }
    }

    chosen.push({
      candidateIndex: bestIndex,
      site: candidates[bestIndex],
      elevation: dem.elev[candidates[bestIndex].y * dem.width + candidates[bestIndex].x],
      newlyCovered: bestGain,
      newlyCoveredFraction: bestGain / areaSize,
      cumulativeFraction: cumulative / areaSize,
    });
  }

  return { sites: chosen, covered: alreadyCovered, areaSize: areaSize };
}

// Ground that no chosen site reaches. In a search and rescue context this is
// the answer that matters: the places a team goes silent.
export function findGaps(covered, areaMask) {
  const gaps = [];
  for (let i = 0; i < covered.length; i++) {
    if (covered[i] === 0 && (areaMask === null || areaMask === undefined || areaMask[i] === 1)) {
      gaps.push(i);
    }
  }
  return gaps;
}
