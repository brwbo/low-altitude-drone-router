// How much does each input actually matter?
//
// Mast height is the parameter a planner has least control over and the one
// that moves the corridor most: a sensor lifted onto a mast sees over the
// terrain that was hiding you, and the cover does not degrade gracefully - it
// falls off a cliff once the mast clears the local ridgeline.
//
// Two questions this answers:
//   1. If they raise the mast, how much cover do I lose?
//   2. Which of these threats is the one that matters?

import { computeCeiling, combineCeilings } from "./viewshed.js";
import { concealedFraction } from "./vehicles.js";

// Concealment across a range of mast heights, with every threat raised
// together. This is the worst case and the one worth planning against.
export function sweepMastHeight(dem, threats, vehicle, heights) {
  const cellCount = dem.width * dem.height;
  const results = [];

  for (const height of heights) {
    const ceilings = [];
    for (const threat of threats) {
      ceilings.push(
        computeCeiling(dem, threat, {
          observerHeight: height,
          maxRangeMetres: threat.maxRangeMetres,
        })
      );
    }
    const ceiling = combineCeilings(ceilings, cellCount);
    results.push({
      mastHeight: height,
      concealed: concealedFraction(dem, ceiling, vehicle),
    });
  }

  return results;
}

// Which single threat costs the most cover? Computed by removing each one in
// turn and seeing how much concealment comes back. A threat whose removal
// changes nothing is a threat sitting somewhere it cannot see.
export function threatContribution(dem, threats, vehicle) {
  const cellCount = dem.width * dem.height;

  const allCeilings = threats.map((threat) =>
    computeCeiling(dem, threat, {
      observerHeight: threat.mastHeight,
      maxRangeMetres: threat.maxRangeMetres,
    })
  );
  const withAll = concealedFraction(
    dem,
    combineCeilings(allCeilings, cellCount),
    vehicle
  );

  const contributions = [];
  for (let skip = 0; skip < threats.length; skip++) {
    const remaining = [];
    for (let i = 0; i < allCeilings.length; i++) {
      if (i !== skip) {
        remaining.push(allCeilings[i]);
      }
    }
    const without =
      remaining.length === 0
        ? 1
        : concealedFraction(dem, combineCeilings(remaining, cellCount), vehicle);

    contributions.push({
      threat: threats[skip],
      concealedWithout: without,
      coverCost: without - withAll,
    });
  }

  contributions.sort((a, b) => b.coverCost - a.coverCost);
  return { withAll: withAll, contributions: contributions };
}

// The height at which raising a single threat's mast costs the most cover per
// extra metre. This is the ridgeline it is hiding behind, found empirically
// rather than assumed.
export function findMastCliff(dem, threat, vehicle, maxHeight, step) {
  const top = maxHeight === undefined ? 50 : maxHeight;
  const increment = step === undefined ? 2 : step;
  const cellCount = dem.width * dem.height;

  let previous = null;
  let steepest = null;

  for (let height = 0; height <= top; height += increment) {
    const ceiling = combineCeilings(
      [
        computeCeiling(dem, threat, {
          observerHeight: height,
          maxRangeMetres: threat.maxRangeMetres,
        }),
      ],
      cellCount
    );
    const concealed = concealedFraction(dem, ceiling, vehicle);

    if (previous !== null) {
      const lossPerMetre = (previous.concealed - concealed) / increment;
      if (steepest === null || lossPerMetre > steepest.lossPerMetre) {
        steepest = {
          fromHeight: previous.height,
          toHeight: height,
          lossPerMetre: lossPerMetre,
        };
      }
    }
    previous = { height: height, concealed: concealed };
  }

  return steepest;
}
