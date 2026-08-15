# Umbra — Model & Assumptions

A one-page reference for questions about how the numbers are produced.

## What the data is

| Input | Source | Note |
|---|---|---|
| Elevation | Copernicus DEM GLO-30 | Real 30 m global terrain, open licence |
| Buildings & trees | Prepared obstacle surface | Included in the masking surface, not just bare ground |
| Sun position | Computed solar azimuth + elevation | Real astronomy for the given date, time and location |
| Threat positions | Operator input | Nothing is detected or inferred — a human marks them |

## How enemy sight is computed

A **radial-sweep viewshed** from each threat over the elevation grid. For every
cell it returns the **altitude at which a platform there breaks that sensor's
horizon** — below it, terrain hides you; above it, you are exposed.

- The sensor eye sits at ground level **plus its mast height** (demo: 30 m).
- **Buildings and treelines block line of sight exactly like terrain**, because
  the sweep runs over a ground-plus-obstacle surface. On flat ground this is
  the difference between finding a corridor and finding none.
- Each threat has an operator-set **maximum range** (demo: 6 km).
- Storing an altitude rather than a yes/no is what lets the platform selector
  re-cost a route instantly for a different flight height.

## How the route is chosen

Both routes come from the **same pathfinder over the same cost surface**, so the
comparison is like for like:

- **Direct** — shortest passable route, ignoring who can see it.
- **Planned** — the same search with exposure penalised, shadowed ground
  discounted, and a glare term for sensors looking into the sun.

**Exposed seconds** = length of route inside the visible set ÷ platform speed
(cargo quad: 60 m AGL, 14 m/s). Neither route can cross ground the platform
cannot traverse, and endurance is checked against the result.

## Assumptions we make explicit

1. **Exposure means opportunity to be seen, not probability of being seen.**
   We model the geometry of line of sight, not sensor optics, contrast, weather
   or operator attention. A clean, checkable claim.

2. **No earth curvature or atmospheric refraction.** At 6 km, curvature would
   drop the horizon by roughly 3 m — meaning a low target is slightly *more*
   hidden in reality than we report. **The model errs conservative:** it
   over-states exposure rather than under-stating it.

3. **The percentage reduction is the robust result.** Absolute seconds follow
   from the operator's marked threat positions, mast heights and ranges. Move
   the threats and the seconds move; the size of the saving holds.

4. **Sensor type matters and we model it.** Terrain masking works against
   *every* sensor — radio, radar and optical alike, because a shot needs line of
   sight. The **sun layer applies to optical sensors only**; we do not claim
   shadow defeats radar or EW.

5. **The sun changes the route for platforms terrain cannot already hide.** A
   nap-of-the-earth drone is so well concealed by ground that light makes no
   difference to its path. The higher a platform must cruise, the more the sun
   decides its route — which is exactly where the layer earns its place.

## What that leaves us confident saying

- The terrain, the sun and the geometry are **real data and real computation**,
  not illustration.
- The tool **states its own limits** rather than presenting a single number as
  truth.
- The headline claim — *this route offers far less opportunity to be seen than
  the direct one, for a modest detour* — is derived end to end and reproducible.
