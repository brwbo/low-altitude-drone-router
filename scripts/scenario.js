// End to end run of the whole spine, across every vehicle profile, producing
// the numbers the pitch quotes and a rendered map per platform so the maths
// can be eyeballed before any UI exists.
//
// Usage:  node scripts/scenario.js [ISO timestamp]
//   node scripts/scenario.js 2026-08-15T04:30:00Z

import fs from "node:fs";
import { loadDemSync } from "../src/demNode.js";
import { computeCeiling, combineCeilings, exposureCount } from "../src/viewshed.js";
import { solarPosition, sunTimes } from "../src/sun.js";
import { computeShadow, glareIsEffective } from "../src/shadow.js";
import { planRoute } from "../src/route.js";
import { encodePng, hillshadeRgb, blend } from "../src/png.js";
import { parseThreats, describeThreat, ThreatInputError } from "../src/threats.js";
import { lonLatToGrid, insideBounds, describeBounds } from "../src/coords.js";
import {
  VEHICLES,
  computeSlope,
  computeTrafficable,
  trafficableFraction,
  concealedFraction,
  computeUsable,
  checkEndurance,
  describeEndurance,
} from "../src/vehicles.js";

const missionFile = process.argv[2] || "data/threats.json";
const mission = JSON.parse(fs.readFileSync(missionFile, "utf8"));
const when = new Date(process.argv[3] || mission.mission.timeUtc);

const dem = loadDemSync();
const lat = (dem.latTop + dem.latBottom) / 2;
const lon = (dem.lonLeft + dem.lonRight) / 2;
const cellCount = dem.width * dem.height;

const pct = (f) => (f * 100).toFixed(1) + "%";
const NAMES = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const bearingName = (d) => NAMES[Math.round(d / 22.5) % 16];

// Threats, start and goal all come from the mission file. Parsing throws with
// a message naming the field and the acceptable range rather than coercing,
// because a silently clamped coordinate produces a confidently wrong map.
let threats;
try {
  threats = parseThreats(mission.threats, dem);
} catch (error) {
  if (error instanceof ThreatInputError) {
    console.error("\nBad threat input in " + missionFile + ":\n  " + error.message + "\n");
    process.exit(1);
  }
  throw error;
}

function missionPoint(spec, name) {
  if (!spec || !Number.isFinite(spec.lat) || !Number.isFinite(spec.lon)) {
    console.error("\nmission." + name + " needs lat and lon\n");
    process.exit(1);
  }
  if (!insideBounds(dem, spec.lat, spec.lon)) {
    console.error(
      "\nmission." + name + " at " + spec.lat + "," + spec.lon +
      " is outside the loaded map (" + describeBounds(dem) + ")\n"
    );
    process.exit(1);
  }
  const cell = lonLatToGrid(dem, spec.lat, spec.lon);
  return {
    x: Math.min(dem.width - 1, Math.max(0, Math.round(cell.x))),
    y: Math.min(dem.height - 1, Math.max(0, Math.round(cell.y))),
    label: spec.label || name,
  };
}

const start = missionPoint(mission.mission.start, "start");
const goal = missionPoint(mission.mission.goal, "goal");

console.log("\n=== SCENARIO ===");
console.log("mission " + missionFile);
console.log(
  "grid   " + dem.width + " x " + dem.height + " at " + dem.cellSize + " m  (" +
  ((dem.width * dem.cellSize) / 1000).toFixed(1) + " x " +
  ((dem.height * dem.cellSize) / 1000).toFixed(1) + " km, Carpathians)"
);
console.log("time   " + when.toISOString());

// --- sun, shared across every vehicle -------------------------------------
const sun = solarPosition(when, lat, lon);
const times = sunTimes(when, lat, lon);
const shadowResult = computeShadow(dem, sun);
console.log(
  "sun    " + sun.elevation.toFixed(1) + " deg elevation, " +
  sun.azimuth.toFixed(0) + " deg (" + bearingName(sun.azimuth) + "), " +
  pct(shadowResult.shadowedFraction) + " of terrain in shadow"
);
console.log(
  "glare  " + (glareIsEffective(sun)
    ? "sun low enough to dazzle a ground observer - approach from " + bearingName(sun.azimuth)
    : "sun too high to dazzle")
);

// --- terrain, shared ------------------------------------------------------
const slope = computeSlope(dem);
console.log("\n--- threats (operator input, " + threats.length + ") ---");
const ceilings = [];
for (const threat of threats) {
  ceilings.push(
    computeCeiling(dem, threat, {
      observerHeight: threat.mastHeight,
      maxRangeMetres: threat.maxRangeMetres,
    })
  );
  console.log("  " + describeThreat(threat));
}
const ceiling = combineCeilings(ceilings, cellCount);

console.log("\nroute   " + start.label + " -> " + goal.label +
  "  (" + start.x + "," + start.y + " to " + goal.x + "," + goal.y + ")");

// --- per vehicle ----------------------------------------------------------
const order = ["ugvTracked", "ugvWheeled", "quadNap", "quadLow", "quadFpv"];
let failures = 0;
const infeasible = [];

console.log("\n--- corridor and route by platform ---");
console.log(
  "platform".padEnd(28) + "AGL".padStart(6) + "trafficable".padStart(13) +
  "concealed".padStart(11) + "usable".padStart(9) +
  "direct exp".padStart(12) + "planned exp".padStart(13) + "detour".padStart(8) +
  "endurance".padStart(18)
);

for (const id of order) {
  const vehicle = VEHICLES[id];
  const passable = computeTrafficable(dem, vehicle, slope);
  const usable = computeUsable(dem, ceiling, passable, vehicle);
  const exposure = exposureCount(dem, ceilings, vehicle.heightAboveGround);

  let usableCount = 0;
  for (let i = 0; i < usable.length; i++) {
    if (usable[i] === 1) usableCount = usableCount + 1;
  }

  const grids = {
    passable: passable,
    exposure: exposure,
    shadow: shadowResult.shadow,
    elev: dem.elev,
  };
  const planned = planRoute(dem, start, goal, grids, {
    vehicle: vehicle,
    candidates: 600,
    seed: 7,
  });
  const direct = planned.direct;
  const best = planned.best;
  const detour = ((best.metres / direct.metres - 1) * 100).toFixed(0) + "%";
  const endurance = checkEndurance(best, vehicle);
  if (!endurance.feasible) {
    infeasible.push(vehicle.label + ": " + describeEndurance(endurance) +
      "  (" + (best.metres / 1000).toFixed(1) + " km, " +
      best.ascentMetres.toFixed(0) + " m of climb, level range " +
      (endurance.levelRangeMetres / 1000).toFixed(0) + " km)");
  }

  console.log(
    vehicle.label.padEnd(28) +
    (vehicle.heightAboveGround + " m").padStart(6) +
    pct(trafficableFraction(passable)).padStart(13) +
    pct(concealedFraction(dem, ceiling, vehicle)).padStart(11) +
    pct(usableCount / cellCount).padStart(9) +
    (direct.exposedSeconds.toFixed(0) + " s").padStart(12) +
    (best.exposedSeconds.toFixed(0) + " s").padStart(13) +
    detour.padStart(8) +
    (endurance.feasible
      ? ("OK " + (endurance.marginFraction * 100).toFixed(0) + "% spare")
      : ("OVER by " + (-endurance.marginFraction * 100).toFixed(0) + "%")).padStart(18)
  );

  if (best.exposedSeconds > direct.exposedSeconds) {
    console.log("    FAIL: planned route more exposed than flying straight");
    failures = failures + 1;
  }

  // Render the two most demo-relevant platforms.
  if (id === "ugvTracked" || id === "quadLow") {
    const rgb = hillshadeRgb(dem);
    for (let i = 0; i < cellCount; i++) {
      if (shadowResult.shadow[i] === 1) blend(rgb, i, 40, 60, 110, 0.25);
      if (passable[i] === 0) blend(rgb, i, 15, 15, 15, 0.55);
      if (exposure[i] > 0) blend(rgb, i, 205, 30, 30, exposure[i] === 1 ? 0.34 : 0.55);
    }
    const stamp = (index, r, g, b, radius) => {
      const cx = index % dem.width;
      const cy = Math.floor(index / dem.width);
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= dem.width || y >= dem.height) continue;
          if (dx * dx + dy * dy > radius * radius) continue;
          blend(rgb, y * dem.width + x, r, g, b, 1);
        }
      }
    };
    for (const i of direct.trace) stamp(i, 255, 205, 40, 1);
    for (const i of best.trace) stamp(i, 40, 235, 95, 2);
    for (const t of threats) {
      stamp(t.y * dem.width + t.x, 255, 255, 255, 8);
      stamp(t.y * dem.width + t.x, 215, 0, 0, 5);
    }
    const file = "data/scenario-" + id + ".png";
    fs.writeFileSync(file, encodePng(dem.width, dem.height, rgb));
    console.log("    wrote " + file);
  }
}

if (infeasible.length > 0) {
  console.log("\n--- endurance: these routes cannot be flown ---");
  for (const line of infeasible) {
    console.log("  " + line);
  }
  console.log("  (endurance figures are planning placeholders, not manufacturer specs)");
}

console.log(
  "\nred = seen by a threat at that platform's height, blue = terrain shadow,\n" +
  "black = ground the platform cannot cross, yellow = direct, green = planned"
);
console.log(
  "\nsunrise " + times.sunrise.toISOString().slice(11, 16) +
  " UTC, solar noon " + times.solarNoon.at.toISOString().slice(11, 16) +
  " UTC, sunset " + times.sunset.toISOString().slice(11, 16) + " UTC"
);

if (failures > 0) {
  console.log("\n" + failures + " platform(s) failed the exposure check");
  process.exit(1);
}
