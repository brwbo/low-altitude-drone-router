// Conversion between real-world coordinates and grid cells.
//
// Everything inside the compute works in grid cells. Everything a human types
// or reads is latitude and longitude. This module is the only place the two
// meet, which keeps the four-coordinate-systems confusion that eats geospatial
// projects contained to one file.

// The DEM is a plain lat/lon grid with known corners, so the mapping is linear.
// Over 40 km the equirectangular error is well under one cell.
export function lonLatToGrid(dem, lat, lon) {
  const x = ((lon - dem.lonLeft) / (dem.lonRight - dem.lonLeft)) * dem.width;
  const y = ((dem.latTop - lat) / (dem.latTop - dem.latBottom)) * dem.height;
  return { x: x, y: y };
}

export function gridToLonLat(dem, x, y) {
  const lon = dem.lonLeft + (x / dem.width) * (dem.lonRight - dem.lonLeft);
  const lat = dem.latTop - (y / dem.height) * (dem.latTop - dem.latBottom);
  return { lat: lat, lon: lon };
}

export function insideBounds(dem, lat, lon) {
  return (
    lat >= dem.latBottom &&
    lat <= dem.latTop &&
    lon >= dem.lonLeft &&
    lon <= dem.lonRight
  );
}

export function describeBounds(dem) {
  return (
    "lat " + dem.latBottom.toFixed(4) + " to " + dem.latTop.toFixed(4) +
    ", lon " + dem.lonLeft.toFixed(4) + " to " + dem.lonRight.toFixed(4)
  );
}

// Accepts the shapes a person actually produces: "48.2103, 24.4412",
// "48.2103 24.4412", or a decimal pair already split out.
export function parseLatLon(text) {
  const cleaned = String(text).replace(/[^0-9eE+\-., ]/g, " ");
  const parts = cleaned.split(/[ ,]+/).filter((p) => p.length > 0);
  if (parts.length < 2) {
    return null;
  }
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat: lat, lon: lon };
}
