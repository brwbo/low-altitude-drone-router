// Mast height sensitivity.
//
// Usage:  node scripts/mast.js [mission file] [vehicle id]
//   node scripts/mast.js data/threats.json quadLow

import fs from "node:fs";
import { loadDemSync } from "../src/demNode.js";
import { parseThreats, describeThreat, ThreatInputError } from "../src/threats.js";
import { VEHICLES } from "../src/vehicles.js";
import { sweepMastHeight, threatContribution, findMastCliff } from "../src/sensitivity.js";

const missionFile = process.argv[2] || "data/threats.json";
const vehicleId = process.argv[3] || "quadLow";

const dem = loadDemSync();
const mission = JSON.parse(fs.readFileSync(missionFile, "utf8"));
const vehicle = VEHICLES[vehicleId];
if (!vehicle) {
  console.error("unknown vehicle: " + vehicleId + ". Known: " + Object.keys(VEHICLES).join(", "));
  process.exit(1);
}

let threats;
try {
  threats = parseThreats(mission.threats, dem);
} catch (error) {
  if (error instanceof ThreatInputError) {
    console.error("\nBad threat input: " + error.message + "\n");
    process.exit(1);
  }
  throw error;
}

const pct = (f) => (f * 100).toFixed(1) + "%";

console.log("\n=== MAST HEIGHT SENSITIVITY ===");
console.log("vehicle " + vehicle.label + " at " + vehicle.heightAboveGround + " m above ground");
console.log("threats " + threats.length + ", as entered:");
for (const threat of threats) {
  console.log("  " + describeThreat(threat));
}

// --- all threats raised together ------------------------------------------
console.log("\n--- concealment as every mast is raised together ---");
const heights = [0, 2, 5, 10, 15, 20, 30, 40, 60, 80];
const sweep = sweepMastHeight(dem, threats, vehicle, heights);

let previous = null;
for (const row of sweep) {
  const bar = "#".repeat(Math.round(row.concealed * 50));
  let delta = "";
  if (previous !== null) {
    const change = (row.concealed - previous.concealed) * 100;
    delta = change.toFixed(1) + " pts";
  }
  console.log(
    "  " + (row.mastHeight + " m").padStart(5) +
    "  " + pct(row.concealed).padStart(6) +
    "  " + delta.padStart(9) +
    "  " + bar
  );
  previous = row;
}

const atZero = sweep[0].concealed;
const atTop = sweep[sweep.length - 1].concealed;
console.log(
  "\n  raising every mast from 0 m to " + heights[heights.length - 1] +
  " m costs " + ((atZero - atTop) * 100).toFixed(1) + " points of cover" +
  " (" + pct(atZero) + " down to " + pct(atTop) + ")"
);

// --- which threat matters -------------------------------------------------
console.log("\n--- which threat is actually costing you cover ---");
const contribution = threatContribution(dem, threats, vehicle);
console.log("  concealment with all threats: " + pct(contribution.withAll));
for (const row of contribution.contributions) {
  console.log(
    "  " + row.threat.label.padEnd(34) +
    " mast " + (row.threat.mastHeight + " m").padStart(5) +
    "   removing it returns " + ((row.coverCost) * 100).toFixed(1).padStart(5) + " pts" +
    "  (to " + pct(row.concealedWithout) + ")"
  );
}
const worst = contribution.contributions[0];
console.log("\n  the one that matters: " + worst.threat.label);

// --- where the cliff is ---------------------------------------------------
console.log("\n--- the ridgeline each threat is hiding behind ---");
console.log("  the mast height at which cover falls fastest, found by sweeping");
for (const threat of threats) {
  const cliff = findMastCliff(dem, threat, vehicle, 60, 2);
  if (cliff === null) {
    console.log("  " + threat.label.padEnd(34) + " no measurable cliff");
    continue;
  }
  console.log(
    "  " + threat.label.padEnd(34) +
    " steepest between " + cliff.fromHeight + " m and " + cliff.toHeight + " m" +
    "  (" + (cliff.lossPerMetre * 100).toFixed(2) + " pts of cover lost per metre)"
  );
}
console.log("");
