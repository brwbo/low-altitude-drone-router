// Positive controls for last-mile reachability and the pathfinder.

import { loadDemSync } from "../src/demNode.js";
import { VEHICLES, computeSlope, computeTrafficable } from "../src/vehicles.js";
import { findPath } from "../src/pathfind.js";
import { roundTrip, sortiesNeeded, assessDelivery } from "../src/logistics.js";

let failures = 0;
function check(label, passed, detail) {
  if (!passed) failures = failures + 1;
  console.log("  [" + (passed ? "PASS" : "FAIL") + "] " + label + (detail ? "  " + detail : ""));
}

const dem = loadDemSync();
const slope = computeSlope(dem);
const cellCount = dem.width * dem.height;

// ------------------------------------------------------------- pathfinding
console.log("\nPATHFINDING  Dijkstra must find routes sampling cannot");

const hub = { x: 260, y: 976 };
const target = { x: 470, y: 780 };

const tracked = VEHICLES.ugvTracked;
const passable = computeTrafficable(dem, tracked, slope);
const grids = { passable: passable, exposure: new Uint8Array(cellCount), elev: dem.elev };

const path = findPath(dem, hub, target, grids, { vehicle: tracked });
check("a route exists between two valley points", path.found === true);

// Every cell on the path must be traversable. If this ever fails the whole
// reachability answer is a lie, so it is checked cell by cell rather than
// trusted because Dijkstra "should" respect the mask.
let allPassable = true;
for (const index of path.trace) {
  if (passable[index] === 0) {
    allPassable = false;
  }
}
check("no cell on the path is impassable", allPassable, path.trace.length + " cells checked");

// The route must be at least the straight-line distance and, in mountains,
// meaningfully longer.
const straight = Math.hypot(target.x - hub.x, target.y - hub.y) * dem.cellSize;
console.log("  straight line " + (straight / 1000).toFixed(1) + " km, route " +
  (path.metres / 1000).toFixed(1) + " km");
check("route is never shorter than the straight line", path.metres >= straight - 1);

// A vehicle that cannot cross steep ground must do at least as badly as one
// that can. Wheeled is limited to 20 degrees, tracked to 30.
const wheeled = VEHICLES.ugvWheeled;
const wheeledPassable = computeTrafficable(dem, wheeled, slope);
const wheeledPath = findPath(
  dem, hub, target,
  { passable: wheeledPassable, exposure: new Uint8Array(cellCount), elev: dem.elev },
  { vehicle: wheeled }
);
check(
  "the more slope-limited vehicle does no better",
  !wheeledPath.found || wheeledPath.metres >= path.metres - 1,
  wheeledPath.found ? (wheeledPath.metres / 1000).toFixed(1) + " km" : "no route at all"
);

// ------------------------------------------------------- aircraft climbing
console.log("\nCLIMB  aircraft must not be charged terrain-following ascent");

// This guards a real bug. Charging a quadcopter a rise and fall for every
// undulation gave 3024 m of climb on a 25 km flight and reported every
// delivery as infeasible. An aircraft climbs once and holds altitude.
const quad = VEHICLES.cargoQuad;
const airGrids = { passable: computeTrafficable(dem, quad, slope), exposure: new Uint8Array(cellCount), elev: dem.elev };
const airPath = findPath(dem, hub, target, airGrids, { vehicle: quad });
console.log("  ground vehicle ascent " + path.ascentMetres.toFixed(0) +
  " m, aircraft ascent " + airPath.ascentMetres.toFixed(0) + " m over similar ground");
check("aircraft ascent is far below terrain-following ascent",
  airPath.ascentMetres < path.ascentMetres * 0.75,
  airPath.ascentMetres.toFixed(0) + " m vs " + path.ascentMetres.toFixed(0) + " m");

// And it must equal the single climb to the highest point crossed.
let highest = -Infinity;
for (const index of airPath.trace) {
  if (dem.elev[index] > highest) highest = dem.elev[index];
}
const singleClimb = Math.max(0, highest - dem.elev[airPath.trace[0]]);
check("aircraft ascent is one climb to the highest point crossed",
  Math.abs(airPath.ascentMetres - singleClimb) < 1,
  airPath.ascentMetres.toFixed(0) + " m vs " + singleClimb.toFixed(0) + " m");

// ------------------------------------------------------------- round trips
console.log("\nROUND TRIP  a delivery vehicle has to come back");

const trip = roundTrip(path);
check("round trip is twice the one-way distance",
  Math.abs(trip.metres - path.metres * 2) < 1);
check("round trip ascent includes the outbound descent",
  Math.abs(trip.ascentMetres - (path.ascentMetres + path.descentMetres)) < 1,
  trip.ascentMetres.toFixed(0) + " m = " + path.ascentMetres.toFixed(0) +
  " up + " + path.descentMetres.toFixed(0) + " back up");
check("round trip is harder than one way", trip.metres > path.metres);

// ----------------------------------------------------------------- sorties
console.log("\nSORTIES  payload must decide the number of trips");

check("300 kg in a 20 kg load takes 15 trips", sortiesNeeded(300, 20) === 15);
check("a part load still costs a whole trip", sortiesNeeded(301, 20) === 16);
check("a bigger payload needs fewer trips", sortiesNeeded(300, 300) < sortiesNeeded(300, 20));
check("no payload means no delivery", sortiesNeeded(100, 0) === Infinity);

// ------------------------------------------------------------ reachability
console.log("\nREACHABILITY  the answer must depend on distance");

const near = { label: "near", x: hub.x + 30, y: hub.y + 30, demandKg: 100 };
const far = { label: "far", x: 1250, y: 120, demandKg: 100 };
const nearResult = assessDelivery(dem, hub, near, tracked, grids, {});
const farResult = assessDelivery(dem, hub, far, tracked, grids, {});
console.log("  1 km away: " + (nearResult.deliverable ? "deliverable" : "not deliverable") +
  ", 45 km away: " + (farResult.deliverable ? "deliverable" : "not deliverable"));
check("a settlement beside the hub is deliverable", nearResult.deliverable === true);
check("a settlement across the whole map is not", farResult.deliverable === false);

console.log("");
if (failures > 0) {
  console.log(failures + " CHECK(S) FAILED - do not build on this");
  process.exit(1);
}
console.log("all checks passed");
