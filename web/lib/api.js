export const CONFIG = {
  // Set NEXT_PUBLIC_ROUTE_API in web/.env.local to Ben's endpoint to go live.
  // Unset = pure mock (no network calls, no console errors).
  API_URL: process.env.NEXT_PUBLIC_ROUTE_API || "",
  DEMO_DATE: "2026-08-15",
  // Carpathians around Hoverla — matches the routing engine's DEM bounds.
  BBOX: [48.000139, 24.230417, 48.339861, 24.769306], // [minLat,minLon,maxLat,maxLon]
  // A short, urban drone/UGV mission in a built-up area, so buildings do the
  // concealing. Start and goal are open ground either side of the town; the
  // buildings sharply limit how far the threats can actually see.
  CENTER: [48.2534, 24.4478],
  PRESETS: {
    start: [48.2515, 24.4482],   // open ground, south
    goal: [48.2553, 24.4473],    // objective ~430 m N, through the streets
    enemies: [[48.2537, 24.4506], [48.2537, 24.4457]],  // flanking the corridor
  },
  buildDatetime(date, hour) {
    const h = Math.floor(hour), m = Math.round((hour - h) * 60);
    return `${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+03:00`;
  },
};

// Calls Ben's API; if it isn't running yet, returns a mock so the UI still works.
export async function fetchRoute(body, hour) {
  if (!CONFIG.API_URL) return { live: false, ...mockRoute(body, hour) };
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    return { live: true, ...data };
  } catch (e) {
    return { live: false, ...mockRoute(body, hour) };
  }
}

// --- Mock so the frontend is buildable before the backend exists ---
export function mockRoute(body, hour) {
  const [aLat, aLon] = body.start, [bLat, bLon] = body.goal;
  const enemies = body.enemies || [];
  const morning = hour < 13;
  const bow = morning ? 1 : -1;

  const route = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const lat = aLat + (bLat - aLat) * t;
    const lon = aLon + (bLon - aLon) * t;
    const off = Math.sin(t * Math.PI) * 0.05 * bow;
    route.push([lat + off * 0.4, lon + off]);
  }

  // exposure = soft danger-zones centred ON each threat, leaning slightly
  // toward the sun. Computed over a PADDED area so a zone never hits a hard
  // rectangular edge, and returned with those padded bounds.
  const rows = 80, cols = 80, grid = [];
  const pad = 0.2;
  const [b0, b1, b2, b3] = CONFIG.BBOX;
  const eb = [b0 - pad, b1 - pad, b2 + pad, b3 + pad];
  const [minLat, minLon, maxLat, maxLon] = eb;
  const sunDir = morning ? 1 : -1;
  const R = 0.1;
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) {
      const lon = minLon + (c / (cols - 1)) * (maxLon - minLon);
      const lat = maxLat - (r / (rows - 1)) * (maxLat - minLat);
      let e = 0;
      for (const [elat, elon] of enemies) {
        const dLat = lat - elat;
        const dLon = (lon - elon) * 0.7;
        const d = Math.hypot(dLat, dLon);
        const onSun = Math.sign(lon - elon) === sunDir;
        const Reff = R * (onSun ? 1.35 : 0.85);   // peak on the threat, tail toward the sun
        const f = 1 - d / Reff;
        if (f > 0) e += f * f;
      }
      grid[r][c] = Math.min(1, e);
    }
  }

  return {
    route,
    sun: { azimuth_deg: morning ? 95 : 265, altitude_deg: 12 },
    exposure: { rows, cols, grid, bbox: eb },
  };
}
