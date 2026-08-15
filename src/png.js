// Minimal PNG writer, so the spine can render what it computed without any
// dependency and without waiting on the front end. Debug tool, not a product
// surface - Tom's canvas is the real renderer.

import zlib from "node:zlib";

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

// rgb is a Uint8Array of width * height * 3 bytes.
export function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    for (let i = 0; i < stride; i++) {
      raw[y * (stride + 1) + 1 + i] = rgb[y * stride + i];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Hillshade with the contrast pushed hard, because a subtle hillshade projects
// as brown mud and the whole demo is a map.
export function hillshadeRgb(dem, options) {
  const opts = typeof options === "object" && options !== null ? options : {};
  // Keep the base map mid-grey rather than white. Coloured overlays have to
  // read on top of it, and a blown-out hillshade projects as a white blob.
  const floor = opts.floor === undefined ? 0.12 : opts.floor;
  const ceiling = opts.ceiling === undefined ? 0.82 : opts.ceiling;

  const cellCount = dem.width * dem.height;
  const shade = new Float32Array(cellCount);
  const azimuth = (315 * Math.PI) / 180;
  const altitude = (45 * Math.PI) / 180;

  for (let y = 0; y < dem.height; y++) {
    for (let x = 0; x < dem.width; x++) {
      const i = y * dem.width + x;
      const xl = x > 0 ? i - 1 : i;
      const xr = x < dem.width - 1 ? i + 1 : i;
      const yu = y > 0 ? i - dem.width : i;
      const yd = y < dem.height - 1 ? i + dem.width : i;

      const dzdx = (dem.elev[xr] - dem.elev[xl]) / (2 * dem.cellSize);
      const dzdy = (dem.elev[yd] - dem.elev[yu]) / (2 * dem.cellSize);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(-dzdx, dzdy);

      let value =
        Math.sin(altitude) * Math.cos(slope) +
        Math.cos(altitude) * Math.sin(slope) * Math.cos(azimuth - aspect);
      shade[i] = Math.max(0, Math.min(1, value));
    }
  }

  // Stretch between the 2nd and 98th percentile of the values that actually
  // occur. A fixed gain either flattens the terrain or blows it to white,
  // depending on the relief, and this grid has 1.6 km of it.
  const sorted = Float32Array.from(shade).sort();
  const low = sorted[Math.floor(sorted.length * 0.02)];
  const high = sorted[Math.floor(sorted.length * 0.98)];
  const span = high - low > 1e-6 ? high - low : 1;

  const rgb = new Uint8Array(cellCount * 3);
  for (let i = 0; i < cellCount; i++) {
    let t = (shade[i] - low) / span;
    t = Math.max(0, Math.min(1, t));
    const v = Math.round((floor + t * (ceiling - floor)) * 255);
    rgb[i * 3] = v;
    rgb[i * 3 + 1] = v;
    rgb[i * 3 + 2] = v;
  }
  return rgb;
}

export function blend(rgb, index, r, g, b, alpha) {
  rgb[index * 3] = Math.round(rgb[index * 3] * (1 - alpha) + r * alpha);
  rgb[index * 3 + 1] = Math.round(rgb[index * 3 + 1] * (1 - alpha) + g * alpha);
  rgb[index * 3 + 2] = Math.round(rgb[index * 3 + 2] * (1 - alpha) + b * alpha);
}
