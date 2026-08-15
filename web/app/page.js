"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_MISSION, saveMission } from "../lib/mission";
import MapPicker from "../components/MapPicker";

const clone = (o) => JSON.parse(JSON.stringify(o));

const PinIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z" />
    <circle cx="12" cy="9" r="2.5" />
  </svg>
);

export default function PlanPage() {
  const router = useRouter();
  const [m, setM] = useState(() => clone(DEFAULT_MISSION));
  const [picker, setPicker] = useState(null); // { kind, index? }

  function go() {
    const center = [(m.start[0] + m.goal[0]) / 2, (m.start[1] + m.goal[1]) / 2];
    saveMission({ ...m, center });
    router.push("/map");
  }
  function reset() { setM(clone(DEFAULT_MISSION)); }

  const f = (v) => (parseFloat(v) || 0);
  const r4 = (v) => Math.round(v * 10000) / 10000;
  function updThreat(i, j, v) {
    const e = m.enemies.map((a) => [...a]); e[i][j] = f(v); setM({ ...m, enemies: e });
  }
  function addThreat() { setM({ ...m, enemies: [...m.enemies, [m.center[0], m.center[1]]] }); }
  function removeThreat(i) { setM({ ...m, enemies: m.enemies.filter((_, k) => k !== i) }); }

  function pickerValue() {
    if (!picker) return null;
    if (picker.kind === "start") return m.start;
    if (picker.kind === "goal") return m.goal;
    return m.enemies[picker.index];
  }
  function applyPick(coords) {
    const c = [r4(coords[0]), r4(coords[1])];
    if (picker.kind === "start") setM({ ...m, start: c });
    else if (picker.kind === "goal") setM({ ...m, goal: c });
    else { const e = m.enemies.map((a) => [...a]); e[picker.index] = c; setM({ ...m, enemies: e }); }
    setPicker(null);
  }

  return (
    <div className="plan">
      <div className="plan-card">
        <div className="brand">Umbra</div>
        <h1>Plan a concealed ingress</h1>
        <p className="lead">Set the mission — or run the demo scenario as-is; the fields are pre-filled. Type coordinates, or use the map picker. Every point stays draggable on the map afterward.</p>

        <div className="plan-sec">
          <span className="glabel">Operation</span>
          <input type="text" value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} />
        </div>
        <div className="plan-sec">
          <span className="glabel">Area of operations</span>
          <div className="areafixed">{m.area} <em>— fixed to the loaded elevation map; place points inside it</em></div>
        </div>

        <div className="plan-two">
          <div className="plan-sec">
            <span className="glabel">Launch — lat / lon</span>
            <div className="coord">
              <input type="number" step="0.0001" value={m.start[0]} onChange={(e) => setM({ ...m, start: [f(e.target.value), m.start[1]] })} />
              <input type="number" step="0.0001" value={m.start[1]} onChange={(e) => setM({ ...m, start: [m.start[0], f(e.target.value)] })} />
              <button className="iconbtn" onClick={() => setPicker({ kind: "start" })} aria-label="Pick launch on map"><PinIcon /></button>
            </div>
          </div>
          <div className="plan-sec">
            <span className="glabel">Objective — lat / lon</span>
            <div className="coord">
              <input type="number" step="0.0001" value={m.goal[0]} onChange={(e) => setM({ ...m, goal: [f(e.target.value), m.goal[1]] })} />
              <input type="number" step="0.0001" value={m.goal[1]} onChange={(e) => setM({ ...m, goal: [m.goal[0], f(e.target.value)] })} />
              <button className="iconbtn" onClick={() => setPicker({ kind: "goal" })} aria-label="Pick objective on map"><PinIcon /></button>
            </div>
          </div>
        </div>

        <div className="plan-sec">
          <span className="glabel">Threats — enemy jammers / observation posts</span>
          <div className="threats">
            {m.enemies.map((t, i) => (
              <div className="threat-row" key={i}>
                <input type="number" step="0.0001" value={t[0]} onChange={(e) => updThreat(i, 0, e.target.value)} />
                <input type="number" step="0.0001" value={t[1]} onChange={(e) => updThreat(i, 1, e.target.value)} />
                <button className="iconbtn" onClick={() => setPicker({ kind: "enemy", index: i })} aria-label="Pick threat on map"><PinIcon /></button>
                <button className="iconbtn danger" onClick={() => removeThreat(i)} aria-label="Remove threat">×</button>
              </div>
            ))}
          </div>
          <button className="addbtn" onClick={addThreat}>+ Add threat</button>
        </div>

        <div className="plan-two">
          <div className="plan-sec">
            <span className="glabel">Date · season</span>
            <input type="date" value={m.date} onChange={(e) => setM({ ...m, date: e.target.value })} />
          </div>
          <div className="plan-sec">
            <span className="glabel">Time of day</span>
            <input type="time" value={m.time} onChange={(e) => setM({ ...m, time: e.target.value })} />
          </div>
        </div>

        <div className="plan-actions">
          <button className="btn-primary" onClick={go}>Plan ingress →</button>
          <button className="btn-ghost" onClick={reset}>Reset to demo defaults</button>
        </div>
        <div className="plan-foot">◐ UMBRA · concealed ingress routing · positions are draggable on the map</div>
      </div>

      <MapPicker
        open={!!picker}
        value={pickerValue()}
        center={m.center}
        onPick={applyPick}
        onClose={() => setPicker(null)}
      />
    </div>
  );
}
