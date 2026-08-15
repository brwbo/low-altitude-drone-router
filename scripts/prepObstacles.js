// Prepare data/obstacles.bin from OpenStreetMap - an OFFLINE, run-once step.
//
// This is the ONLY script in the repository that touches the network, and it
// is deliberately not part of the runtime. It fetches building and woodland
// footprints from the OSM Overpass API for the area the loaded DEM covers,
// rasterises their heights onto the DEM grid, and writes a Uint8 height per
// cell to data/obstacles.bin. After that the planner reads only that local
// file, so the safety position - nothing leaves the machine at run time -
// still holds. Run it again only when the map area changes.
//
//   node scripts/prepObstacles.js
//
// Heights are estimates where OSM carries no measured value: a class default,
// or building:levels times three metres. They are planning inputs, not
// survey data, and the pitch should say so.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDemSync } from "../src/demNode.js";
import { lonLatToGrid } from "../src/coords.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", "data");
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Class defaults in metres, used only where a feature carries no usable tag.
const DEFAULT_HEIGHTS = { wood: 20, building: 8, powerLine: 25, mast: 40 };
const METRES_PER_LEVEL = 3;
const MAX_HEIGHT = 255; // Uint8 ceiling; nothing here is taller

function classifyAndHeight(tags) {
  if (!tags) {
    return 0;
  }
  const explicit = parseFloat(String(tags.height || "").replace("m", "").trim());
  const levels = parseFloat(tags["building:levels"]);

  if (tags.landuse === "forest" || tags.natural === "wood") {
    return Number.isFinite(explicit) ? explicit : DEFAULT_HEIGHTS.wood;
  }
  if (tags.man_made === "mast") {
    return Number.isFinite(explicit) ? explicit : DEFAULT_HEIGHTS.mast;
  }
  if (tags.power === "line" || tags.power === "minor_line" || tags.power === "tower") {
    return DEFAULT_HEIGHTS.powerLine;
  }
  if (tags.building !== undefined) {
    if (Number.isFinite(explicit)) return explicit;
    if (Number.isFinite(levels)) return levels * METRES_PER_LEVEL;
    return DEFAULT_HEIGHTS.building;
  }
  return 0;
}

// Fill a closed polygon on the grid with a height, tallest-wins, using an
// even-odd scanline. Ways come back from Overpass as lists of lon/lat nodes.
function rasteriseWay(heights, dem, nodes, height) {
  if (nodes.length < 3) {
    // A bare line (power line, open way): stamp its cells so it still blocks.
    for (const node of nodes) {
      const cell = lonLatToGrid(dem, node.lat, node.lon);
      const x = Math.round(cell.x);
      const y = Math.round(cell.y);
      if (x >= 0 && y >= 0 && x < dem.width && y < dem.height) {
        const i = y * dem.width + x;
        if (height > heights[i]) heights[i] = Math.min(MAX_HEIGHT, Math.round(height));
      }
    }
    return;
  }

  const pts = nodes.map((n) => {
    const cell = lonLatToGrid(dem, n.lat, n.lon);
    return { x: cell.x, y: cell.y };
  });

  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(dem.height - 1, Math.ceil(maxY));

  for (let y = minY; y <= maxY; y++) {
    const crossings = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ay = a.y;
      const by = b.y;
      if ((ay <= y && by > y) || (by <= y && ay > y)) {
        const t = (y - ay) / (by - ay);
        crossings.push(a.x + t * (b.x - a.x));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let c = 0; c + 1 < crossings.length; c += 2) {
      const xStart = Math.max(0, Math.ceil(crossings[c]));
      const xEnd = Math.min(dem.width - 1, Math.floor(crossings[c + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        const idx = y * dem.width + x;
        const h = Math.min(MAX_HEIGHT, Math.round(height));
        if (h > heights[idx]) heights[idx] = h;
      }
    }
  }
}

async function main() {
  const dem = loadDemSync();
  const south = dem.latBottom;
  const north = dem.latTop;
  const west = dem.lonLeft;
  const east = dem.lonRight;
  const bbox = south + "," + west + "," + north + "," + east;

  const query =
    "[out:json][timeout:120];(" +
    'way["building"](' + bbox + ");" +
    'way["landuse"="forest"](' + bbox + ");" +
    'way["natural"="wood"](' + bbox + ");" +
    'way["power"="line"](' + bbox + ");" +
    'way["man_made"="mast"](' + bbox + ");" +
    ");out geom;";

  console.log("fetching OSM obstacles for " + bbox + " ...");
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Overpass rejects Node's default fetch User-Agent with HTTP 406.
      // The identical request from curl succeeds, because curl sends one of
      // its own. Any non-empty value is accepted; a descriptive one is polite
      // to a free public service.
      "User-Agent": "umbra-terrain-corridor-planner/0.1 (hackathon prototype)",
    },
    body: "data=" + encodeURIComponent(query),
  });
  if (!response.ok) {
    throw new Error("Overpass returned HTTP " + response.status);
  }
  const payload = await response.json();

  const heights = new Uint8Array(dem.width * dem.height);
  let features = 0;
  for (const element of payload.elements || []) {
    if (element.type !== "way" || !element.geometry) {
      continue;
    }
    const height = classifyAndHeight(element.tags);
    if (height <= 0) {
      continue;
    }
    rasteriseWay(heights, dem, element.geometry, height);
    features = features + 1;
  }

  let obstructed = 0;
  let tallest = 0;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] > 0) obstructed = obstructed + 1;
    if (heights[i] > tallest) tallest = heights[i];
  }

  const outPath = path.join(dataDir, "obstacles.bin");
  fs.writeFileSync(outPath, Buffer.from(heights.buffer));
  console.log(
    "wrote " + outPath + ": " + features + " features, " +
    ((obstructed / heights.length) * 100).toFixed(1) + "% of cells obstructed, tallest " +
    tallest + " m"
  );
}

main().catch((error) => {
  console.error("prepObstacles failed: " + error.message);
  process.exit(1);
});
