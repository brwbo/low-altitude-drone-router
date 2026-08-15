// Last-mile reachability when the roads have gone.
//
// Usage:  node scripts/logistics.js [scenario file]
//   node scripts/logistics.js data/settlements.json

import fs from "node:fs";
import { loadDemSync } from "../src/demNode.js";
import { lonLatToGrid, insideBounds, describeBounds } from "../src/coords.js";
import { VEHICLES, computeSlope } from "../src/vehicles.js";
import { assessFleet, minimumFleet } from "../src/logistics.js";

const scenarioFile = process.argv[2] || "data/settlements.json";
const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
const dem = loadDemSync();

function toCell(spec, name) {
  if (!Number.isFinite(spec.lat) || !Number.isFinite(spec.lon)) {
    console.error(name + " needs lat and lon");
    process.exit(1);
  }
  if (!insideBounds(dem, spec.lat, spec.lon)) {
    console.error(
      name + " at " + spec.lat + "," + spec.lon +
      " is outside the loaded map (" + describeBounds(dem) + ")"
    );
    process.exit(1);
  }
  const cell = lonLatToGrid(dem, spec.lat, spec.lon);
  return {
    ...spec,
    x: Math.min(dem.width - 1, Math.max(0, Math.round(cell.x))),
    y: Math.min(dem.height - 1, Math.max(0, Math.round(cell.y))),
  };
}

const hub = toCell(scenario.hub, "hub");
const settlements = scenario.settlements.map((s) => toCell(s, "settlement " + s.label));
const fleet = scenario.fleet.map((id) => {
  if (!VEHICLES[id]) {
    console.error("unknown vehicle in fleet: " + id);
    process.exit(1);
  }
  return VEHICLES[id];
});

console.log("\n=== LAST-MILE REACHABILITY ===");
console.log("NO ROAD NETWORK IN THIS MODEL. Every route below is cross-country,");
console.log("which is the case where the roads have already failed.\n");
console.log("hub          " + hub.label + " at " + dem.elev[hub.y * dem.width + hub.x] + " m");
console.log("settlements  " + settlements.length);
console.log("fleet        " + fleet.map((v) => v.label).join(", "));

const slope = computeSlope(dem);
const started = Date.now();
const assessment = assessFleet(dem, hub, settlements, fleet, { slope: slope, candidates: 250 });
console.log("solved in    " + ((Date.now() - started) / 1000).toFixed(1) + " s\n");

// --- per settlement -------------------------------------------------------
console.log("--- who can reach what ---");
console.log(
  "settlement".padEnd(15) + "km".padStart(7) + "need".padStart(8) +
  "  best option".padEnd(26) + "sorties".padStart(9) + "hours".padStart(8)
);
for (const row of assessment) {
  const straightKm =
    (Math.hypot(row.settlement.x - hub.x, row.settlement.y - hub.y) * dem.cellSize) / 1000;
  if (row.cutOff) {
    console.log(
      row.settlement.label.padEnd(15) +
      straightKm.toFixed(1).padStart(7) +
      (row.settlement.demandKg + "kg").padStart(8) +
      "  CUT OFF - no vehicle in the fleet can serve it"
    );
    continue;
  }
  const best = row.best;
  console.log(
    row.settlement.label.padEnd(15) +
    straightKm.toFixed(1).padStart(7) +
    (row.settlement.demandKg + "kg").padStart(8) +
    ("  " + best.vehicle.label).padEnd(26) +
    String(best.sorties).padStart(9) +
    best.totalHours.toFixed(1).padStart(8)
  );
}

// --- why the others fail --------------------------------------------------
console.log("\n--- why each vehicle fails where it does ---");
for (const row of assessment) {
  const failures = row.byVehicle.filter((entry) => !entry.deliverable);
  if (failures.length === 0) {
    continue;
  }
  console.log("  " + row.settlement.label + ":");
  for (const entry of failures) {
    let reason;
    if (entry.unreachableReason) {
      reason = entry.unreachableReason;
    } else if (!entry.endurance.feasible) {
      reason =
        "round trip needs " + (entry.endurance.requiredSeconds / 60).toFixed(0) +
        " min of " + (entry.endurance.usableSeconds / 60).toFixed(0) + " usable" +
        " (" + entry.roundTripKm.toFixed(1) + " km, " + entry.roundTripAscent.toFixed(0) + " m climb)";
    } else {
      reason = "no payload capacity";
    }
    console.log("    " + entry.vehicle.label.padEnd(28) + reason);
  }
}

// --- minimum fleet --------------------------------------------------------
const minimum = minimumFleet(assessment);
console.log("\n--- smallest fleet that reaches everything reachable ---");
for (const entry of minimum.fleet) {
  console.log("  " + entry.vehicle.label.padEnd(28) + "covers " + entry.newlyServed + " settlement(s)");
}
if (minimum.unreachable.length > 0) {
  console.log("  still unreachable: " + minimum.unreachable.join(", "));
}

const reachable = assessment.filter((row) => !row.cutOff).length;
const peopleCutOff = assessment
  .filter((row) => row.cutOff)
  .reduce((total, row) => total + (row.settlement.population || 0), 0);

console.log(
  "\n" + reachable + " of " + settlements.length + " settlements reachable. " +
  (peopleCutOff > 0 ? peopleCutOff + " people in cut-off settlements." : "Nobody cut off.")
);
console.log(
  "\nPayload, endurance and speed figures are planning placeholders, not\n" +
  "manufacturer specifications. Populations and demands are illustrative.\n"
);
