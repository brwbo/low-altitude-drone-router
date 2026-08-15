// Node-side obstacle loader, mirroring src/demNode.js.
//
// Returns a Uint8Array of per-cell heights in metres, or null when no
// data/obstacles.bin is present - in which case the caller works over bare
// terrain, exactly as the tool did before obstacles existed. A missing file is
// therefore not an error; a WRONG-SIZED file is, because it would rasterise
// buildings onto the wrong ground.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkObstacleShape } from "./obstacles.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", "data");

export function loadObstacleHeightsSync(dem) {
  const binPath = path.join(dataDir, "obstacles.bin");
  if (!fs.existsSync(binPath)) {
    return null;
  }

  const buf = fs.readFileSync(binPath);
  const heights = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  checkObstacleShape(dem, heights);
  return heights;
}
