import { CONFIG } from "./api";

// The demo scenario — used as the default and the "reset" target.
export const DEFAULT_MISSION = {
  name: "CARPATHIAN CORRIDOR 01",
  area: "Hoverla · Carpathians",
  center: CONFIG.CENTER,
  bbox: CONFIG.BBOX,
  start: CONFIG.PRESETS.start,
  goal: CONFIG.PRESETS.goal,
  enemies: CONFIG.PRESETS.enemies,
  date: CONFIG.DEMO_DATE,
  time: "07:30",
};

export function timeToHour(t) {
  const [h, m] = (t || "07:30").split(":").map(Number);
  return (h || 0) + (m || 0) / 60;
}

// v7: urban mission with open-ground start/goal.
const KEY = "umbra.mission.v8";

export function saveMission(m) {
  try { localStorage.setItem(KEY, JSON.stringify(m)); } catch (e) {}
}

export function loadMission() {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return { ...DEFAULT_MISSION, ...JSON.parse(s) };
  } catch (e) {}
  return DEFAULT_MISSION;
}
