// Buildings and trees, as heights that stand on the ground.
//
// Two jobs, both already expected by the rest of the engine:
//   they RAISE THE FLOOR   - corridor.js computeFloor adds obstacleHeight, so
//                            a drone must clear a roofline or a canopy; and
//   they BLOCK LINE OF SIGHT - viewshed.js computeCeiling sweeps over a
//                            surface, so a drone behind them is masked.
//
// The height grid is one Uint8 metre value per cell, same width and height and
// cell order as the DEM. Uint8 caps at 255 m, which is far above any building
// or tree and keeps the file a quarter the size of the elevation grid.
//
// Where the heights come from is a separate, OFFLINE step - see
// scripts/prepObstacles.js, which fetches OpenStreetMap once and writes
// data/obstacles.bin. Nothing here touches the network; the runtime only ever
// reads a local file, which is the whole basis of the safety position. When no
// obstacle file is present the surface is the bare ground and the tool behaves
// exactly as it did before, so this is additive and never breaks a run.

// Build the masking surface: ground elevation plus whatever stands on each
// cell. Returns a Float32Array of absolute altitude in metres above sea level,
// which is what viewshed.js computeCeiling expects as options.surface.
export function buildSurface(dem, obstacleHeight) {
  const surface = new Float32Array(dem.width * dem.height);
  if (!obstacleHeight) {
    // No obstacles: the surface is the bare ground.
    for (let i = 0; i < surface.length; i++) {
      surface[i] = dem.elev[i];
    }
    return surface;
  }
  for (let i = 0; i < surface.length; i++) {
    surface[i] = dem.elev[i] + obstacleHeight[i];
  }
  return surface;
}

// Validate that a height grid matches the DEM before it is trusted. A grid of
// the wrong size silently rasterises obstacles onto the wrong cells, which
// produces a confident, wrong map - the failure mode this whole codebase is
// built to refuse.
export function checkObstacleShape(dem, obstacleHeight) {
  if (!obstacleHeight) {
    return;
  }
  const expected = dem.width * dem.height;
  if (obstacleHeight.length !== expected) {
    throw new Error(
      "obstacle grid holds " + obstacleHeight.length + " cells, the DEM expects " +
        expected + " - the two were prepared for different areas"
    );
  }
}

// Browser loader, mirroring src/dem.js. Returns a Uint8Array of heights, or
// null when there is no obstacle file, which the caller reads as bare terrain.
export async function loadObstacleHeights(dem) {
  let response;
  try {
    response = await fetch("data/obstacles.bin");
  } catch (error) {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const buffer = await response.arrayBuffer();
  const heights = new Uint8Array(buffer);
  checkObstacleShape(dem, heights);
  return heights;
}
