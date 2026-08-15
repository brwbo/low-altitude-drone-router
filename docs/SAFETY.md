# Safety, legality and responsible use

Written 2026-08-15 for this build specifically. Every claim below describes
what the code in this repository actually does, verifiable by reading it.

## The one paragraph version

This tool computes where terrain blocks line of sight. It takes enemy sensor
positions as input from a human planner, and it produces a map of ground that
is hidden from them and a route through it. It does not detect anything, does
not identify anything, does not observe anything, and holds no data about any
person. Everything it knows about the world is a public elevation model and a
list of coordinates somebody typed in.

## What it does, precisely

- Reads a public elevation grid (Copernicus DEM GLO-30, free for general
  public use, credit ESA / Copernicus).
- Takes a list of threat positions as latitude, longitude, mast height and
  sensor range, supplied by the operator, validated on entry and rejected if
  outside the loaded map.
- Computes, per cell, the altitude at which a vehicle breaks each threat's
  horizon. This is trigonometry over a height grid. It is the same computation
  a game engine performs to decide where a shadow falls.
- Computes terrain shadow from solar geometry for a given timestamp.
- Scores candidate routes and returns the one with least exposure.

## What it does not do

- **No detection.** Nothing is sensed, listened to, or watched.
- **No identification.** No imagery of people, vehicles or places is processed.
- **No inference of enemy positions.** See the section below, which is the
  most important decision in this document.
- **No targeting.** It produces no firing solution and nothing about weapons.
- **No personal data of any kind** is read, stored or transmitted.
- **Nothing leaves the machine.** The only requests the application makes are
  same-origin fetches of two local files, `data/dem.bin` and `data/dem.json`,
  from a server running on the same laptop. No third-party host is contacted,
  there are no API keys, and `package.json` has zero dependencies. The
  elevation data was downloaded once, ahead of time, and is committed to the
  repository.
- **No machine learning.** Every output is deterministic arithmetic, so the
  same inputs always produce the same map. There is no model to be confidently
  wrong.

## The decision not to infer threat positions

A drone that stops reporting was, plausibly, visible to something. Run the
line-of-sight computation backwards from several such points and the candidate
region for the sensor collapses quickly. It works, it is not difficult, and it
would be the most impressive feature in this tool.

**It is deliberately not built, and it will not be.**

Taking positions as input keeps this a tool that answers "given what you
already know, where is it safe to move". Producing positions would make it a
tool that locates enemy equipment from operational data, which is a different
product with a different risk profile and would need a different document from
this one. The line is not technical difficulty. It is the difference between
computing over what a planner knows and generating new intelligence about
where people are.

If someone asks whether it could be done: yes, and we chose not to.

## The dual-use position, stated plainly

A map of where a vehicle is hidden from a sensor is, read the other way, a map
of what that sensor covers. The same geometry that routes a resupply drone
away from an observation post would route anything else towards it. That is
true and no framing removes it.

Three things constrain it in practice, and none of them is the algorithm:

1. **The threats are an input.** The tool contributes no knowledge about where
   anything is. Someone who already knows those positions has the hard part.
2. **The output is coarse.** A 30 m elevation grid over a 40 km box supports
   route planning. It supports nothing precise.
3. **The intended use is survivability** for resupply, casualty evacuation and
   reconnaissance, which are the missions that fly low specifically because
   they cannot defend themselves.

Access control, data granularity and stated purpose are what separate a
protective tool from a targeting one. Not the maths.

## What the output is not good enough for

Said before a judge asks:

- **It is bare geometry.** It says nothing about radar range against a given
  radar cross-section, about acoustic detection (a low quadcopter is loud), or
  about RF detection of the control link. Terrain masking is a necessary
  condition for concealment, not a sufficient one.
- **It assumes ground-based sensors.** An airborne sensor looks over the
  terrain and the corridor collapses. The mast height control shows this
  happening; raise it and watch the cover disappear.
- **The elevation model is a surface model at 30 m.** It carries tree and
  building height unevenly and it does not contain power lines, cables or
  individual masts, which are the obstacles that actually kill low-flying
  aircraft. Do not fly anything on this.
- **Shadow helps against eyes and cameras only.** Thermal imaging does not
  care, and sun-warmed ground can make a cool airframe more visible in shadow
  rather than less. Radar does not care at all.
- **No endurance check.** A route the tool considers good may be longer than
  the platform can travel. Nothing currently validates this.
- **Never validated by anyone who has planned a real flight.** This is a
  one-day prototype built by two people with no operational background. The
  premise is untested.

## Who is affected

- **Operators of the vehicle.** The direct users. The risk is over-trust: a
  route marked green is only as good as the threat list entered, and a threat
  nobody knew about does not appear on the map. Absence of red is not safety.
- **Anyone under the route.** A tool that optimises for concealment does not
  optimise for avoiding populated areas. That is not currently modelled and
  should be, before this went anywhere real.
- **People near a position entered as a threat.** The tool treats a coordinate
  as a sensor and computes geometry. It makes no claim that anything is there,
  and it should never be read as evidence that something is.

## Lines held

1. Threat positions are input, never output.
2. No detection, no identification, no targeting.
3. Deterministic geometry only, no model to be confidently wrong.
4. No personal data, no network access at runtime, no imagery of anywhere.
5. Every limitation above is stated in the pitch, not discovered by a judge.
6. No claimed property this build does not actually have.

## If this went further

No responsible deployment happens without a stated user, a legal review of the
dual-use question, and validation by someone who has actually planned
operations in contested airspace. A hackathon prototype is the beginning of
that conversation, not evidence that it was had.
