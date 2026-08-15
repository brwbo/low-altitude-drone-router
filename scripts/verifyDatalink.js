import fs from "node:fs";
import { TEST_START, TEST_GOAL, TEST_THREATS } from "../src/testScenario.js";
import { loadDemSync, findExtremes } from "../src/demNode.js";
import { computeCeiling, combineCeilings } from "../src/viewshed.js";
import { computeLinkCeiling, inContact, assessLink, usableCorridor } from "../src/datalink.js";
import { findPath } from "../src/pathfind.js";
import { parseThreats } from "../src/threats.js";
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}
const pct = (f) => (f * 100).toFixed(1) + "%";

const dem = loadDemSync();
const cellCount = dem.width * dem.height;
const vehicle = VEHICLES.quadLow;

console.log("\nDATALINK");

// A station on a summit must reach far more than one in a valley - the same
// asymmetry as a threat viewshed, which is the point: it is the same geometry.
// The genuine extremes of the grid. An earlier version picked the mission
// start as "the valley" - at 1613 m it is a valley only relative to the peaks
// around it, and comparing against it understated the contrast.
const extremes = findExtremes(dem);
const summit = extremes.summit;
const deepValley = extremes.valley;
const valley = { x: 568, y: 669 };
const summitContact = inContact(dem, computeLinkCeiling(dem, summit, { antennaHeight: 3 }), 15);
const valleyContact = inContact(dem, computeLinkCeiling(dem, deepValley, { antennaHeight: 3 }), 15);
const share = (c) => { let n = 0; for (const v of c) n += v; return n / c.length; };
console.log("  station on the summit (" + dem.elev[summit.y * dem.width + summit.x] +
  " m) reaches " + pct(share(summitContact)) + ", on the valley floor (" +
  dem.elev[deepValley.y * dem.width + deepValley.x] + " m) " + pct(share(valleyContact)));
check("a summit station reaches far more than a valley-floor one",
  share(summitContact) > share(valleyContact) * 5);

// A taller antenna can only help.
const tall = inContact(dem, computeLinkCeiling(dem, deepValley, { antennaHeight: 30 }), 15);
check("a taller antenna never reduces coverage", share(tall) >= share(valleyContact) - 1e-9,
  pct(share(tall)) + " at 30 m vs " + pct(share(valleyContact)) + " at 3 m");

// Flying higher can only help the link, exactly as it hurts concealment.
const linkCeiling = computeLinkCeiling(dem, valley, { antennaHeight: 3 });
check("flying higher improves contact",
  share(inContact(dem, linkCeiling, 200)) > share(inContact(dem, linkCeiling, 5)));

// Blackout accounting along a real route.
const passable = computeTrafficable(dem, vehicle, computeSlope(dem));
const route = findPath(dem, valley, { x: 482, y: 276 },
  { passable: passable, exposure: new Uint8Array(cellCount), elev: dem.elev }, { vehicle });
const link = assessLink(dem, route.trace, inContact(dem, linkCeiling, 15), vehicle.speed);
console.log("  route: " + pct(link.contactFraction) + " in contact, " +
  link.blackoutCount + " blackouts, longest " + link.longestBlackoutSeconds.toFixed(0) + "s");
check("contact fraction is a valid proportion",
  link.contactFraction >= 0 && link.contactFraction <= 1);
check("the longest blackout never exceeds the whole journey",
  link.longestBlackoutSeconds <= route.seconds + 0.001);
check("blackouts are counted consistently",
  link.blackoutCount === link.blackouts.length);

// Degenerate ends of the scale must behave.
const always = new Uint8Array(cellCount).fill(1);
const never = new Uint8Array(cellCount);
const perfect = assessLink(dem, route.trace, always, vehicle.speed);
const none = assessLink(dem, route.trace, never, vehicle.speed);
check("perfect contact gives no blackouts",
  perfect.contactFraction === 1 && perfect.blackoutCount === 0);
check("no contact at all is one continuous blackout",
  none.contactFraction === 0 && none.blackoutCount === 1);
check("a total blackout lasts the whole route",
  Math.abs(none.longestBlackoutMetres - (route.trace.length * dem.cellSize)) < dem.cellSize + 1);

// The corridor that matters is the intersection, and it can only be smaller.
const mission = JSON.parse(fs.readFileSync("data/threats.json", "utf8"));
const threats = parseThreats(TEST_THREATS, dem);
const ceiling = combineCeilings(threats.map((t) =>
  computeCeiling(dem, t, { observerHeight: t.mastHeight, maxRangeMetres: t.maxRangeMetres })), cellCount);
const contact = inContact(dem, linkCeiling, 15);
const usable = usableCorridor(dem, ceiling, contact, 15);

let hiddenOnly = 0;
let both = 0;
for (let i = 0; i < cellCount; i++) {
  if (dem.elev[i] + 15 <= ceiling[i]) hiddenOnly = hiddenOnly + 1;
  if (usable[i] === 1) both = both + 1;
}
console.log("  " + pct(hiddenOnly / cellCount) + " hidden, but only " +
  pct(both / cellCount) + " hidden AND in contact");
check("requiring contact can only shrink the corridor", both <= hiddenOnly);
check("the intersection is strictly smaller here", both < hiddenOnly,
  both + " of " + hiddenOnly + " concealed cells keep their link");

console.log("");
if (failures > 0) { console.log(failures + " CHECK(S) FAILED"); process.exit(1); }
console.log("all checks passed");
