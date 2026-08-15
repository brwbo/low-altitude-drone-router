// Node-side loader. Produces exactly the same object shape as the browser
// loader in src/dem.js, so every compute module can be tested in a terminal
// long before any UI exists.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", "data");

export function loadDemSync() {
  // The two data files are the one thing with no fallback, so a missing or
  // unreadable one says exactly what is wrong rather than surfacing a stack
  // trace with no context.
  const metaPath = path.join(dataDir, "dem.json");
  const binPath = path.join(dataDir, "dem.bin");
  for (const required of [metaPath, binPath]) {
    if (!fs.existsSync(required)) {
      throw new Error(
        "Elevation data missing: " + required + " not found.\n" +
        "Both data/dem.json and data/dem.bin are required. Restore them from the\n" +
        "repository, or regenerate from the Copernicus tile named in dem.json."
      );
    }
  }

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (error) {
    throw new Error("Elevation metadata " + metaPath + " is not valid JSON: " + error.message);
  }
  const buf = fs.readFileSync(binPath);

  // The byteOffset and length matter. `new Int16Array(buf)` treats the Buffer
  // as an array of numbers and silently produces garbage; this view reads the
  // underlying bytes as the Int16 values they actually are.
  const elev = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);

  const expected = meta.width * meta.height;
  if (elev.length !== expected) {
    throw new Error(
      "dem.bin holds " + elev.length + " cells, dem.json expects " + expected
    );
  }

  return {
    width: meta.width,
    height: meta.height,
    cellSize: meta.cellSizeMetres,
    minElevation: meta.minElevation,
    maxElevation: meta.maxElevation,
    latTop: meta.latTop,
    latBottom: meta.latBottom,
    lonLeft: meta.lonLeft,
    lonRight: meta.lonRight,
    elev: elev,
  };
}

// Finds the highest and lowest cells in the grid. Used to pick the summit and
// valley positions for the viewshed positive control, so the test does not
// depend on hardcoded coordinates that could drift if the crop changes.
export function findExtremes(dem) {
  let highIndex = 0;
  let lowIndex = 0;
  for (let i = 1; i < dem.elev.length; i++) {
    if (dem.elev[i] > dem.elev[highIndex]) {
      highIndex = i;
    }
    if (dem.elev[i] < dem.elev[lowIndex]) {
      lowIndex = i;
    }
  }
  return {
    summit: { x: highIndex % dem.width, y: Math.floor(highIndex / dem.width) },
    valley: { x: lowIndex % dem.width, y: Math.floor(lowIndex / dem.width) },
  };
}
