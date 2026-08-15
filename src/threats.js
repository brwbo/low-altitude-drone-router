// Enemy sensor positions, as input.
//
// These are ALWAYS supplied by whoever is planning. Nothing in this codebase
// detects, identifies or locates anything - it takes a list of coordinates a
// human has decided to enter and computes geometry from them. That boundary is
// deliberate and it is the line the safety position rests on.
//
// A threat is a position, a height, and a range:
//
//   lat, lon      where it is
//   mastHeight    metres above the ground the sensor sits - a radar on a 12 m
//                 mast sees a great deal further than a soldier lying down,
//                 and this single number moves the corridor more than anything
//                 else the planner controls
//   maxRangeKm    beyond this it cannot engage regardless of line of sight
//   type          free text, carried through for display only

import { lonLatToGrid, insideBounds, describeBounds, parseLatLon } from "./coords.js";

const DEFAULT_MAST_HEIGHT = 2;
const DEFAULT_RANGE_KM = 25;

export class ThreatInputError extends Error {}

// Validates and normalises one threat. Throws with a message that names the
// offending field and the acceptable range, because this is a system boundary
// and a silent coercion here produces a confidently wrong map.
export function parseThreat(raw, dem, index) {
  const where = "threat " + (index === undefined ? "" : "#" + (index + 1) + " ") +
    (raw && raw.label ? "(" + raw.label + ")" : "");

  if (raw === null || typeof raw !== "object") {
    throw new ThreatInputError(where + " is not an object");
  }

  let lat = raw.lat;
  let lon = raw.lon;

  if (typeof raw.position === "string") {
    const parsed = parseLatLon(raw.position);
    if (parsed === null) {
      throw new ThreatInputError(
        where + ' position "' + raw.position + '" is not a lat/lon pair'
      );
    }
    lat = parsed.lat;
    lon = parsed.lon;
  }

  // Grid coordinates are accepted so the UI can hand back a clicked cell
  // without a round trip through degrees.
  if (lat === undefined && lon === undefined && raw.x !== undefined && raw.y !== undefined) {
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
      throw new ThreatInputError(where + " has non-numeric grid coordinates");
    }
    if (raw.x < 0 || raw.y < 0 || raw.x >= dem.width || raw.y >= dem.height) {
      throw new ThreatInputError(
        where + " grid position " + raw.x + "," + raw.y +
        " is outside the 0.." + (dem.width - 1) + " by 0.." + (dem.height - 1) + " grid"
      );
    }
    return finish(raw, Math.round(raw.x), Math.round(raw.y), dem);
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new ThreatInputError(
      where + " needs lat and lon numbers, a position string, or x and y grid cells"
    );
  }
  if (lat < -90 || lat > 90) {
    throw new ThreatInputError(where + " latitude " + lat + " is outside -90..90");
  }
  if (lon < -180 || lon > 180) {
    throw new ThreatInputError(where + " longitude " + lon + " is outside -180..180");
  }
  if (!insideBounds(dem, lat, lon)) {
    throw new ThreatInputError(
      where + " at " + lat.toFixed(4) + "," + lon.toFixed(4) +
      " is outside the loaded map (" + describeBounds(dem) + ")"
    );
  }

  const cell = lonLatToGrid(dem, lat, lon);
  const x = Math.min(dem.width - 1, Math.max(0, Math.round(cell.x)));
  const y = Math.min(dem.height - 1, Math.max(0, Math.round(cell.y)));
  return finish(raw, x, y, dem);
}

function finish(raw, x, y, dem) {
  let mastHeight = raw.mastHeight === undefined ? DEFAULT_MAST_HEIGHT : raw.mastHeight;
  if (!Number.isFinite(mastHeight) || mastHeight < 0 || mastHeight > 300) {
    throw new ThreatInputError(
      "threat " + (raw.label || "") + " mastHeight " + raw.mastHeight +
      " is not a number of metres between 0 and 300"
    );
  }

  let maxRangeKm = raw.maxRangeKm === undefined ? DEFAULT_RANGE_KM : raw.maxRangeKm;
  if (!Number.isFinite(maxRangeKm) || maxRangeKm <= 0) {
    throw new ThreatInputError(
      "threat " + (raw.label || "") + " maxRangeKm " + raw.maxRangeKm + " must be a positive number"
    );
  }

  return {
    label: raw.label || "unnamed",
    type: raw.type || "unknown",
    x: x,
    y: y,
    groundElevation: dem.elev[y * dem.width + x],
    mastHeight: mastHeight,
    maxRangeMetres: maxRangeKm * 1000,
    confidence: raw.confidence || "stated",
    source: raw.source || "operator input",
  };
}

export function parseThreats(rawList, dem) {
  if (!Array.isArray(rawList)) {
    throw new ThreatInputError("threats must be an array");
  }
  if (rawList.length === 0) {
    throw new ThreatInputError("no threats supplied - nothing to plan against");
  }
  const parsed = [];
  for (let i = 0; i < rawList.length; i++) {
    parsed.push(parseThreat(rawList[i], dem, i));
  }
  return parsed;
}

export function describeThreat(threat) {
  return (
    threat.label +
    " [" + threat.type + "] at cell " + threat.x + "," + threat.y +
    ", ground " + threat.groundElevation + " m" +
    ", mast " + threat.mastHeight + " m" +
    ", range " + (threat.maxRangeMetres / 1000).toFixed(0) + " km"
  );
}
