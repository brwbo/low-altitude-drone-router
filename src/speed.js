// Sprint where you are seen, cruise where you are not.
//
// Exposure is measured in seconds, not metres, which means speed is a lever
// the planner has and was not using. Crossing an exposed saddle at maximum
// speed and settling back to an efficient cruise once masked cuts time in view
// without changing the route at all.
//
// It is not free. Sprinting burns endurance faster than cruising - a rotary
// aircraft pushing near its maximum is far off its best-endurance speed - so
// the trade is time-in-view against range. That trade is the output, rather
// than something decided quietly inside the router.

// Speed per cell along a route: sprint where exposed, cruise where not.
export function planSpeedProfile(dem, trace, exposure, vehicle, options) {
  const opts = options || {};
  const cruise = vehicle.speed;
  const sprint = opts.sprintSpeed !== undefined
    ? opts.sprintSpeed
    : (vehicle.sprintSpeed !== undefined ? vehicle.sprintSpeed : cruise * 1.4);
  // Endurance consumed per second at sprint, relative to cruise. Pushing a
  // rotorcraft off its best-endurance speed costs more than the speed gains.
  const burn = opts.sprintBurnMultiplier !== undefined
    ? opts.sprintBurnMultiplier
    : (vehicle.sprintBurnMultiplier !== undefined ? vehicle.sprintBurnMultiplier : 1.8);

  const speeds = [];
  for (const index of trace) {
    speeds.push(exposure && exposure[index] > 0 ? sprint : cruise);
  }
  return { speeds: speeds, cruise: cruise, sprint: sprint, burn: burn };
}

// Journey time, time in view, and endurance drawn, for a given speed profile.
// Called twice - once at constant cruise, once with sprinting - so the trade
// can be reported rather than assumed.
export function evaluateSpeeds(dem, trace, exposure, profile) {
  let seconds = 0;
  let exposedSeconds = 0;
  let enduranceSeconds = 0;
  let sprintingSeconds = 0;

  for (let i = 1; i < trace.length; i++) {
    const previous = trace[i - 1];
    const current = trace[i];
    const px = previous % dem.width;
    const py = (previous - px) / dem.width;
    const cx = current % dem.width;
    const cy = (current - cx) / dem.width;
    const metres = dem.cellSize * (px !== cx && py !== cy ? Math.SQRT2 : 1);

    const speed = profile.speeds[i];
    const segment = metres / speed;
    seconds = seconds + segment;

    const sprinting = speed > profile.cruise + 1e-9;
    if (sprinting) {
      sprintingSeconds = sprintingSeconds + segment;
      enduranceSeconds = enduranceSeconds + segment * profile.burn;
    } else {
      enduranceSeconds = enduranceSeconds + segment;
    }

    if (exposure && exposure[current] > 0) {
      exposedSeconds = exposedSeconds + segment;
    }
  }

  return {
    seconds: seconds,
    exposedSeconds: exposedSeconds,
    enduranceSeconds: enduranceSeconds,
    sprintingSeconds: sprintingSeconds,
  };
}

// The comparison a planner wants: what sprinting through the exposed sections
// buys, and what it costs.
export function sprintTradeoff(dem, trace, exposure, vehicle, options) {
  const constant = planSpeedProfile(dem, trace, null, vehicle, options);
  const varying = planSpeedProfile(dem, trace, exposure, vehicle, options);

  const atCruise = evaluateSpeeds(dem, trace, exposure, constant);
  const withSprint = evaluateSpeeds(dem, trace, exposure, varying);

  return {
    atCruise: atCruise,
    withSprint: withSprint,
    exposureSavedSeconds: atCruise.exposedSeconds - withSprint.exposedSeconds,
    exposureSavedFraction: atCruise.exposedSeconds === 0
      ? 0
      : (atCruise.exposedSeconds - withSprint.exposedSeconds) / atCruise.exposedSeconds,
    enduranceCostSeconds: withSprint.enduranceSeconds - atCruise.enduranceSeconds,
    cruise: constant.cruise,
    sprint: varying.sprint,
  };
}
