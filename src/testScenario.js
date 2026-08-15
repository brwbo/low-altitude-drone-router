// A FIXED scenario for the test suites, deliberately separate from the demo.
//
// Every suite used to read data/threats.json. That made the whole test estate
// track the demo: move the launch point, retune a threat, correct a sensor
// range, and unrelated suites went red - not because the router broke, but
// because the scenario they happened to be measuring had changed underneath
// them. "It keeps going all red when I move launch" was exactly that.
//
// A control has to be a fixed yardstick. The demo scenario is meant to be
// retuned freely - it is a presentation - so nothing that verifies behaviour
// may depend on it.
//
// These values are chosen so there is always something to measure: a route
// with real exposure on the direct line, a genuinely less-exposed alternative
// that costs distance, and at least one optical sensor for the sun to act on.

export const TEST_START = { x: 568, y: 669 };
export const TEST_GOAL = { x: 482, y: 276 };
export const TEST_TIME = "2026-08-15T04:30:00Z";

// Positioned on ground that overwatches the corridor between START and GOAL,
// with the sourced small-drone sensor ranges.
export const TEST_THREATS = [
  { label: "east ridge OP", type: "optical", lat: 48.1723, lon: 24.4793, mastHeight: 6, maxRangeKm: 2 },
  { label: "west ridge EW", type: "ew", lat: 48.1820, lon: 24.4259, mastHeight: 18, maxRangeKm: 4 },
  { label: "south radar", type: "radar", lat: 48.1520, lon: 24.4520, mastHeight: 12, maxRangeKm: 4 },
];
