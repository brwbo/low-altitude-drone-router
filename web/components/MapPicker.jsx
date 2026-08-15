"use client";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import { CONFIG } from "../lib/api";

// Modal map: click / drag a pin, returns [lat, lon] via onPick.
export default function MapPicker({ open, value, center, onPick, onClose }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [pos, setPos] = useState(value || null);

  useEffect(() => {
    if (!open) return;
    setPos(value || null);
    let cancelled = false;
    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || mapRef.current || !containerRef.current) return;
      const start = value || center || CONFIG.CENTER;
      const map = L.map(containerRef.current, { zoomControl: true }).setView(start, value ? 12 : 10);
      mapRef.current = map;
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
        { maxZoom: 20, subdomains: "abcd", attribution: "© OpenStreetMap © CARTO" }).addTo(map);

      const icon = L.divIcon({ className: "pin", html: `<div class="pin-dot pin-goal"></div>`, iconSize: [15, 15], iconAnchor: [7, 7] });
      const marker = L.marker(start, { draggable: true, icon }).addTo(map);
      if (!value) marker.setOpacity(0.55);
      marker.on("dragend", () => { const p = marker.getLatLng(); marker.setOpacity(1); setPos([p.lat, p.lng]); });
      map.on("click", (e) => { marker.setLatLng(e.latlng); marker.setOpacity(1); setPos([e.latlng.lat, e.latlng.lng]); });
      setTimeout(() => map.invalidateSize(), 60);
    })();
    return () => { cancelled = true; if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>Pick a location</span>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div ref={containerRef} className="mapbox" />
        <div className="modal-foot">
          <span className="coordreadout">
            {pos ? `${pos[0].toFixed(4)}, ${pos[1].toFixed(4)}` : "Click the map or drag the pin"}
          </span>
          <div className="modal-btns">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn-primary" onClick={() => pos && onPick(pos)} disabled={!pos}>Use location</button>
          </div>
        </div>
      </div>
    </div>
  );
}
