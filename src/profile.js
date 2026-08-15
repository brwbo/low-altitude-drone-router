// The vertical half of a route.
//
// A ground track says where to fly. It does not say how high, and height is
// the whole subject: the ceiling computed per cell IS the altitude at which
// each threat acquires you, so the information needed to fly a concealed
// profile is already there and was being thrown away.
//
// The rule is not "fly as low as possible". Low costs energy, brings you into
// obstacles and gives no margin for error. The rule is fly as HIGH as
// concealment allows, which is a different answer at every cell:
//
//   floor    surface (ground plus anything standing on it) plus clearance
//   ceiling  the altitude at which the first threat acquires you
//   target   just under the ceiling, or a comfortable cruise, whichever is lower
//
// Where the ceiling drops below the floor there is no concealed altitude at
// all. That segment is flown at the floor and reported as exposed, because
// pretending otherwise would be a lie in the one place it matters.
//
// Finally the profile is rate-limited. An aircraft cannot step its altitude
// between adjacent 30 m cells, and a profile that assumes it can is not
// flyable.

export function planAltitudeProfile(dem, trace, ceiling, options) {
  const opts = options || {};
  const surface = opts.surface || dem.elev;
  const clearance = opts.clearance === undefined ? 10 : opts.clearance;
  // Stay this far below the ceiling so a small navigation error does not put
  // you over it.
  const ceilingMargin = opts.ceilingMargin === undefined ? 5 : opts.ceilingMargin;
  // Preferred height above the surface when concealment is not the binding
  // constraint. Higher is cheaper and safer; the ceiling pulls it down.
  const cruiseAgl = opts.cruiseAgl === undefined ? 60 : opts.cruiseAgl;
  // Metres of altitude change per metre travelled. 0.2 is a gentle 11 degrees.
  const maxGradient = opts.maxGradient === undefined ? 0.2 : opts.maxGradient;

  const width = dem.width;
  const points = [];

  for (let i = 0; i < trace.length; i++) {
    const index = trace[i];
    const floor = surface[index] + clearance;
    const ceilingHere = ceiling[index];
    const concealedAvailable = ceilingHere - ceilingMargin >= floor;

    let target;
    if (!Number.isFinite(ceilingHere)) {
      // No threat constrains this cell at all.
      target = surface[index] + cruiseAgl;
    } else if (concealedAvailable) {
      target = Math.min(surface[index] + cruiseAgl, ceilingHere - ceilingMargin);
    } else {
      // Nothing here is concealed. Sit on the floor and say so.
      target = floor;
    }

    points.push({
      index: index,
      groundElevation: dem.elev[index],
      surfaceElevation: surface[index],
      floor: floor,
      ceiling: ceilingHere,
      target: Math.max(target, floor),
      concealed: concealedAvailable,
    });
  }

  // A climb-feasible floor envelope, built before anything else.
  //
  // The naive approach clamps each point up to its own floor, which silently
  // assumes the aircraft can match any rate the terrain rises at. It cannot.
  // If the ground ahead climbs faster than the vehicle does, the vehicle has
  // to START CLIMBING EARLIER - so the floor constraint has to propagate
  // backwards along the route, not just apply pointwise.
  //
  // Forward pass limits how fast the envelope may descend; backward pass lifts
  // earlier cells so every later floor is reachable. The result is the lowest
  // line that clears everything AND is flyable, and because it is built under
  // the gradient limit, anything clamped to it stays flyable too.
  const stepMetres = dem.cellSize;
  const maxStep = maxGradient * stepMetres;
  const envelope = points.map((p) => p.floor);

  for (let i = 1; i < envelope.length; i++) {
    if (envelope[i] < envelope[i - 1] - maxStep) {
      envelope[i] = envelope[i - 1] - maxStep;
    }
  }
  for (let i = envelope.length - 2; i >= 0; i--) {
    if (envelope[i] < envelope[i + 1] - maxStep) {
      envelope[i] = envelope[i + 1] - maxStep;
    }
  }

  for (let i = 0; i < points.length; i++) {
    points[i].envelope = envelope[i];
    if (points[i].target < envelope[i]) {
      points[i].target = envelope[i];
    }
  }

  // Now bring the target down towards the envelope wherever it climbs faster
  // than the vehicle can. Clamping at the envelope cannot reintroduce a
  // violation, because the envelope itself respects the limit.
  for (let i = 1; i < points.length; i++) {
    const most = points[i - 1].target + maxStep;
    if (points[i].target > most) {
      points[i].target = Math.max(most, envelope[i]);
    }
  }
  for (let i = points.length - 2; i >= 0; i--) {
    const most = points[i + 1].target + maxStep;
    if (points[i].target > most) {
      points[i].target = Math.max(most, envelope[i]);
    }
  }

  // The envelope can sit above the ceiling: a climb the terrain forces on you
  // may not finish before the next masked stretch begins. Those cells are
  // genuinely exposed and are marked as such, not quietly clamped out of sight.
  let exposedByProfile = 0;
  let peakAgl = 0;
  let minAgl = Infinity;
  let climbMetres = 0;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    p.agl = p.target - p.surfaceElevation;
    if (Number.isFinite(p.ceiling) && p.target > p.ceiling) {
      p.exposedHere = true;
      exposedByProfile = exposedByProfile + 1;
    } else {
      p.exposedHere = false;
    }
    if (p.agl > peakAgl) peakAgl = p.agl;
    if (p.agl < minAgl) minAgl = p.agl;
    if (i > 0) {
      const rise = points[i].target - points[i - 1].target;
      if (rise > 0) climbMetres = climbMetres + rise;
    }
  }

  return {
    points: points,
    exposedCells: exposedByProfile,
    peakAgl: peakAgl,
    minAgl: minAgl === Infinity ? 0 : minAgl,
    climbMetres: climbMetres,
    concealedFraction: points.length === 0
      ? 0
      : points.filter((p) => !p.exposedHere).length / points.length,
  };
}

// A readable flight card: the profile collapsed into legs where the altitude
// band is roughly constant, so it can be flown rather than merely plotted.
export function summariseProfile(dem, profile, options) {
  const opts = options || {};
  const bandMetres = opts.bandMetres === undefined ? 20 : opts.bandMetres;

  const legs = [];
  let current = null;

  for (const point of profile.points) {
    const band = Math.round(point.agl / bandMetres) * bandMetres;
    if (current === null || current.band !== band || current.exposed !== point.exposedHere) {
      if (current !== null) legs.push(current);
      current = { band: band, cells: 0, exposed: point.exposedHere, minAgl: point.agl, maxAgl: point.agl };
    }
    current.cells = current.cells + 1;
    if (point.agl < current.minAgl) current.minAgl = point.agl;
    if (point.agl > current.maxAgl) current.maxAgl = point.agl;
  }
  if (current !== null) legs.push(current);

  for (const leg of legs) {
    leg.metres = leg.cells * dem.cellSize;
  }
  return legs;
}
