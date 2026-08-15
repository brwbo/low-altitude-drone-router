// Loads the prepped elevation grid.
//
// dem.bin is Int16 metres above sea level, one value per cell, row-major,
// rows running north to south. dem.json carries the dimensions and bounds.
// Cells are 30 m square - the prep step resampled them so they are square,
// because the raw Copernicus grid is 20.6 m east-west and 30.9 m north-south
// at this latitude and that asymmetry corrupts every distance calculation.

export async function loadDem() {
  const meta = await fetch("data/dem.json").then((r) => r.json());
  const buffer = await fetch("data/dem.bin").then((r) => r.arrayBuffer());
  const elev = new Int16Array(buffer);

  const expected = meta.width * meta.height;
  if (elev.length !== expected) {
    throw new Error(
      "dem.bin has " + elev.length + " cells, dem.json expects " + expected
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

// Ground height in metres at a grid cell. No bounds check - callers stay inside.
export function heightAt(dem, x, y) {
  return dem.elev[y * dem.width + x];
}

export function insideGrid(dem, x, y) {
  return x >= 0 && y >= 0 && x < dem.width && y < dem.height;
}

// A fake grid of hills, so the front end is never blocked waiting on the loader.
export function fakeDem(width, height, cellSize) {
  const elev = new Int16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = Math.sin(x / 40) * Math.cos(y / 55) * 600;
      const b = Math.sin((x + y) / 90) * 300;
      elev[y * width + x] = Math.round(900 + a + b);
    }
  }
  let min = elev[0];
  let max = elev[0];
  for (let i = 1; i < elev.length; i++) {
    if (elev[i] < min) min = elev[i];
    if (elev[i] > max) max = elev[i];
  }
  return {
    width: width,
    height: height,
    cellSize: cellSize,
    minElevation: min,
    maxElevation: max,
    elev: elev,
  };
}
