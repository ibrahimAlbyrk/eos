// <Map of="places" pin="index" route you/> — pins from a collection on an
// OpenFreeMap dark map (MapLibre GL, every request through the daemon proxy).
//
// The live map exists only while it is on screen and within the app-wide
// WebGL budget (liveMaps.js). Before it loads, after it is put to sleep, and
// when WebGL or MapLibre fail, a static map stands in: a canvas snapshot of
// the last live frame when there is one, else a schematic of the pins. Pins
// are selectable in every state and share the collection's selection with the
// cards, table rows and timeline stops.

import { useEffect, useId, useRef, useState } from "react";
import { useView } from "../../runtime/ViewContext.jsx";
import { attrBool, attrNum } from "../../../../../../contracts/src/genui/attrs.ts";
import { applyLens, numberItems, toneHex } from "../data/util.js";
import { filteredOut } from "../inputs/FilterEmpty.jsx";
import { logoSrcs } from "../content/util.js";
import {
  DEFAULT_ATTRIBUTION,
  attributionText,
  buildPins,
  fitPositions,
  lngLatBounds,
  pendingAddresses,
  pinsKey,
  proxiedUrl,
  wantsLocation,
  youCoord,
} from "./mapGeom.js";
import { isLive, requestLive, releaseLive, setVisible as setLiveVisible } from "./liveMaps.js";
import { loadMapLibre } from "./mapLoader.js";
import { cachedGeocode, geocode, loadStyle, mapBase, userLocation } from "./services.js";

const DORMANT_MS = 30_000;
const PAD = { top: 46, bottom: 30, left: 34, right: 46 };

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// `you` joins the framing only when it is near the pins (a dot 400 km away
// would shrink every pin to a speck).
export function framingCoords(pins, you) {
  const coords = pins.filter((p) => p.coord).map((p) => p.coord);
  if (you && (!coords.length || coords.some((c) => haversineKm(c, you) < 25))) coords.push(you);
  return coords;
}

const ZoomGlyph = ({ plus = false }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d={plus ? "M5 12h14M12 5v14" : "M5 12h14"} />
  </svg>
);

function pinClass(pin, mode) {
  return `gv-pin gv-pin--${mode}${pin.selected ? " is-selected" : ""}`;
}

function monogram(name) {
  const words = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

function PinFace({ pin, mode, iconUrl }) {
  if (mode === "dot") return null;
  if (mode === "logo") {
    return iconUrl ? <img src={iconUrl} alt="" draggable="false" onError={(e) => e.currentTarget.remove()} /> : <span>{monogram(pin.name)}</span>;
  }
  return <span>{pin.n}</span>;
}

// A live marker: MapLibre positions the wrapper, the button inside is the
// same pin the static map draws.
function markerElement(pin, mode, iconUrl, onPick) {
  const wrap = document.createElement("div");
  wrap.className = "gv-pinwrap";
  const btn = document.createElement("button");
  btn.type = "button";
  wrap.appendChild(btn);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onPick(pin.id);
  });
  updateMarkerElement(wrap, pin, mode, iconUrl);
  return wrap;
}

function updateMarkerElement(wrap, pin, mode, iconUrl) {
  const btn = wrap.firstChild;
  btn.className = pinClass(pin, mode);
  btn.setAttribute("aria-label", pin.name ? `${pin.n}. ${pin.name}` : String(pin.n));
  btn.setAttribute("aria-pressed", String(pin.selected));
  wrap.style.zIndex = pin.selected ? "3" : "1";
  const face = mode === "dot" ? "" : mode === "logo" ? `logo:${iconUrl ?? monogram(pin.name)}` : `n:${pin.n}`;
  if (btn.dataset.face === face) return;
  btn.dataset.face = face;
  btn.textContent = "";
  if (mode === "index") btn.textContent = String(pin.n);
  else if (mode === "logo") {
    if (iconUrl) {
      const img = document.createElement("img");
      img.src = iconUrl;
      img.alt = "";
      img.draggable = false;
      img.addEventListener("error", () => {
        img.remove();
        btn.textContent = monogram(pin.name);
      });
      btn.appendChild(img);
    } else btn.textContent = monogram(pin.name);
  }
}

function youElement() {
  const el = document.createElement("div");
  el.className = "gv-you";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "You are here");
  return el;
}

function scrollParent(el) {
  for (let p = el?.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "overlay") return p;
  }
  return null;
}

function useBoxSize(ref, fallback) {
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function GeoMap({ attrs = {} }) {
  const view = useView();
  const instanceId = useId();
  const of = typeof attrs.of === "string" ? attrs.of : null;
  const height = Math.max(160, Math.min(600, attrNum(attrs.height) ?? 240));
  const mode = ["index", "dot", "logo"].includes(attrs.pin) ? attrs.pin : "index";
  const route = attrBool(attrs.route);
  const zoom = attrNum(attrs.zoom);
  const tone = toneHex(view.tone);

  const [resolved, setResolved] = useState(() => new Map());
  const [youLoc, setYouLoc] = useState(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState("static"); // static | loading | live | failed
  const [snapshot, setSnapshot] = useState(null);
  const [parked, setParked] = useState(false); // evicted while on screen: wait for a click or a scroll back
  const [attribution, setAttribution] = useState(DEFAULT_ATTRIBUTION);

  const boxRef = useRef(null);
  const liveRef = useRef(null);
  const mapRef = useRef(null);
  const libRef = useRef(null);
  const loadedRef = useRef(false);
  const markersRef = useRef(new Map());
  const youMarkerRef = useRef(null);
  const fitKeyRef = useRef("");
  const dormantRef = useRef(null);
  const aliveRef = useRef(true);
  const latest = useRef({});
  const size = useBoxSize(boxRef, { w: 640, h: height });

  const items = of ? applyLens(view.collection(of), attrs, view.state) : [];
  const number = of ? numberItems(view.allItems(of), attrs, view.state) : null;
  const sel = of ? view.selected(of) : null;
  const lookup = {
    get: (a) => resolved.get(a) ?? cachedGeocode(a) ?? null,
    has: (a) => resolved.has(a) || cachedGeocode(a) !== undefined,
  };
  const pins = buildPins(items, { number, resolved: lookup, selected: sel });
  const you = youCoord(attrs.you) ?? youLoc;
  const key = pinsKey(pins);
  const pick = (id) => {
    if (of) view.select(of, id);
  };
  const iconFor = (pin) => (mode === "logo" && pin.site ? logoSrcs(view, pin.site)[0] ?? null : null);
  latest.current = { pins, you, route, mode, tone, zoom, key, pick, iconFor };

  // ── live map lifecycle ──────────────────────────────────────────────────

  const sleep = (snap = true) => {
    const map = mapRef.current;
    if (!map) return;
    let shot = null;
    if (snap && loadedRef.current) {
      try {
        const canvas = map.getCanvas();
        const w = canvas.clientWidth || 1;
        const h = canvas.clientHeight || 1;
        const at = (c) => {
          const p = map.project([c[1], c[0]]);
          return { x: (p.x / w) * 100, y: (p.y / h) * 100 };
        };
        const pos = {};
        for (const p of latest.current.pins) if (p.coord) pos[p.id] = at(p.coord);
        shot = {
          url: canvas.toDataURL("image/jpeg", 0.82),
          pos,
          you: latest.current.you ? at(latest.current.you) : null,
          key: latest.current.key,
        };
      } catch {
        shot = null;
      }
    }
    try {
      map.remove();
    } catch {
      /* already gone */
    }
    mapRef.current = null;
    loadedRef.current = false;
    markersRef.current.clear();
    youMarkerRef.current = null;
    fitKeyRef.current = "";
    releaseLive(instanceId);
    if (!aliveRef.current) return;
    setSnapshot(shot);
    setPhase((p) => (p === "failed" ? p : "static"));
  };

  const syncMap = () => {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const cur = latest.current;
    const ml = libRef.current;
    // Pins.
    const seen = new Set();
    for (const pin of cur.pins) {
      if (!pin.coord) continue;
      seen.add(pin.id);
      const icon = cur.iconFor(pin);
      const existing = markersRef.current.get(pin.id);
      if (existing) {
        existing.setLngLat([pin.coord[1], pin.coord[0]]);
        updateMarkerElement(existing.getElement(), pin, cur.mode, icon);
      } else {
        const m = new ml.Marker({ element: markerElement(pin, cur.mode, icon, (id) => latest.current.pick(id)), anchor: "center" })
          .setLngLat([pin.coord[1], pin.coord[0]])
          .addTo(map);
        markersRef.current.set(pin.id, m);
      }
    }
    for (const [id, m] of markersRef.current) {
      if (!seen.has(id)) {
        m.remove();
        markersRef.current.delete(id);
      }
    }
    // You.
    if (cur.you) {
      if (!youMarkerRef.current) youMarkerRef.current = new ml.Marker({ element: youElement(), anchor: "center" }).setLngLat([cur.you[1], cur.you[0]]).addTo(map);
      else youMarkerRef.current.setLngLat([cur.you[1], cur.you[0]]);
    } else if (youMarkerRef.current) {
      youMarkerRef.current.remove();
      youMarkerRef.current = null;
    }
    // Route.
    const line = cur.route ? cur.pins.filter((p) => p.coord).map((p) => [p.coord[1], p.coord[0]]) : [];
    const data = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line.length >= 2 ? line : [] } };
    try {
      const src = map.getSource("gv-route");
      if (src) src.setData(data);
      else {
        map.addSource("gv-route", { type: "geojson", data });
        map.addLayer({
          id: "gv-route",
          type: "line",
          source: "gv-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": cur.tone, "line-width": 2.2, "line-dasharray": [2.5, 2.5] },
        });
      }
      map.setPaintProperty("gv-route", "line-color", cur.tone);
    } catch {
      /* a style still settling; the next sync draws it */
    }
    // Framing: refit when the set of pins changes.
    if (fitKeyRef.current !== cur.key) {
      const first = fitKeyRef.current === "";
      fitKeyRef.current = cur.key;
      const coords = framingCoords(cur.pins, cur.you);
      if (coords.length === 1) map.jumpTo({ center: [coords[0][1], coords[0][0]], zoom: cur.zoom ?? 14 });
      else if (coords.length > 1) map.fitBounds(lngLatBounds(coords), { padding: PAD, maxZoom: cur.zoom ?? 15, duration: first ? 0 : 450 });
    }
  };

  const wake = async () => {
    if (mapRef.current || !liveRef.current) return;
    const base = mapBase();
    if (!base) {
      setPhase("failed");
      return;
    }
    setParked(false);
    setPhase("loading");
    requestLive(instanceId, () => {
      const onScreen = latest.current.visible;
      if (mapRef.current) sleep(true);
      else if (aliveRef.current) setPhase((p) => (p === "failed" ? p : "static"));
      if (onScreen && aliveRef.current) setParked(true);
    });
    try {
      const [ml, style] = await Promise.all([loadMapLibre(), loadStyle(base)]);
      if (!aliveRef.current || mapRef.current || !liveRef.current) return;
      // Evicted while MapLibre and the style were loading: stay static.
      if (!isLive(instanceId)) return;
      const coords = framingCoords(latest.current.pins, latest.current.you);
      const bounds = coords.length > 1 ? lngLatBounds(coords) : null;
      const map = new ml.Map({
        container: liveRef.current,
        style,
        transformRequest: (url) => ({ url: proxiedUrl(url, base) }),
        attributionControl: false,
        cooperativeGestures: true,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        fadeDuration: 0,
        canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
        ...(bounds
          ? { bounds, fitBoundsOptions: { padding: PAD, maxZoom: latest.current.zoom ?? 15 } }
          : { center: coords[0] ? [coords[0][1], coords[0][0]] : [0, 20], zoom: coords[0] ? latest.current.zoom ?? 14 : 1 }),
      });
      libRef.current = ml;
      mapRef.current = map;
      fitKeyRef.current = latest.current.key;
      map.on("load", () => {
        if (mapRef.current !== map) return;
        loadedRef.current = true;
        try {
          const sources = Object.values(map.getStyle()?.sources ?? {}).map((s) => s?.attribution);
          setAttribution(attributionText(sources) || DEFAULT_ATTRIBUTION);
        } catch {
          /* keep the default */
        }
        syncMap();
        setSnapshot(null);
        setPhase("live");
      });
      // A tile or glyph that fails to load is not fatal (the map keeps
      // trying); losing the GL context or the style is.
      map.on("error", (e) => {
        const msg = String(e?.error?.message ?? "");
        if (mapRef.current === map && !loadedRef.current && /webgl|context|style/i.test(msg)) {
          sleep(false);
          setPhase("failed");
        }
      });
      map.getCanvas().addEventListener("webglcontextlost", () => {
        if (mapRef.current === map) {
          sleep(false);
          setParked(true);
        }
      });
    } catch {
      releaseLive(instanceId);
      if (aliveRef.current) setPhase("failed");
    }
  };

  latest.current.visible = visible;
  latest.current.wake = wake;
  latest.current.sleep = sleep;
  latest.current.sync = syncMap;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimeout(dormantRef.current);
      latest.current.sleep?.(false);
      releaseLive(instanceId);
    };
  }, [instanceId]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return undefined;
    // Several entries can arrive in one callback; the last is the current one.
    // Rooted at the transcript's scroller, no margin: only maps actually on
    // screen compete for the live budget (a map about to scroll in would push
    // out one being looked at); the static map covers the load.
    const io = new IntersectionObserver((entries) => setVisible(Boolean(entries[entries.length - 1]?.isIntersecting)), { root: scrollParent(el) });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    setLiveVisible(instanceId, visible);
    clearTimeout(dormantRef.current);
    if (visible) {
      if (!mapRef.current && phase !== "failed" && phase !== "loading" && !parked && of) latest.current.wake?.();
    } else {
      setParked(false);
      if (mapRef.current) dormantRef.current = setTimeout(() => latest.current.sleep?.(true), DORMANT_MS);
    }
  }, [visible, phase, parked, of, instanceId]);

  // Addresses → pins, one geocode at a time, only once the map is near the screen.
  const pending = pendingAddresses(pins, lookup).join("\u0000");
  useEffect(() => {
    if (!visible || !pending) return undefined;
    let alive = true;
    for (const address of pending.split("\u0000")) {
      geocode(address).then((coord) => {
        if (alive) setResolved((prev) => (prev.has(address) ? prev : new Map(prev).set(address, coord)));
      });
    }
    return () => {
      alive = false;
    };
  }, [visible, pending]);

  const wantYou = wantsLocation(attrs.you) && !youCoord(attrs.you);
  useEffect(() => {
    if (!visible || !wantYou) return undefined;
    let alive = true;
    userLocation().then((c) => {
      if (alive && c) setYouLoc(c);
    });
    return () => {
      alive = false;
    };
  }, [visible, wantYou]);

  // Keep the live map in step with pins, selection, tone and `you`.
  const youKey = you ? you.join(",") : "";
  useEffect(() => {
    if (phase === "live") latest.current.sync?.();
  }, [phase, key, sel, mode, route, tone, youKey]);

  // A selection made elsewhere (a card, a row) brings its pin into view.
  useEffect(() => {
    const map = mapRef.current;
    if (phase !== "live" || !map || sel == null) return;
    const pin = latest.current.pins.find((p) => p.selected && p.coord);
    if (!pin) return;
    try {
      const pt = map.project([pin.coord[1], pin.coord[0]]);
      const c = map.getContainer();
      if (pt.x < 24 || pt.y < 24 || pt.x > c.clientWidth - 24 || pt.y > c.clientHeight - 24) {
        map.easeTo({ center: [pin.coord[1], pin.coord[0]], duration: 400 });
      }
    } catch {
      /* not projectable yet */
    }
  }, [sel, phase]);

  if (!of) return null;

  // ── static map ──────────────────────────────────────────────────────────

  const shot = snapshot && snapshot.key === key ? snapshot : null;
  let pos = {};
  let youPos = null;
  if (shot) {
    pos = shot.pos;
    youPos = shot.you;
  } else {
    const placed = pins.filter((p) => p.coord);
    const framing = framingCoords(placed, you);
    const youIn = you && framing.length > placed.length;
    const pts = fitPositions(framing, size.w, size.h, 40);
    placed.forEach((p, i) => {
      pos[p.id] = { x: (pts[i].x / size.w) * 100, y: (pts[i].y / size.h) * 100 };
    });
    if (youIn) youPos = { x: (pts[pts.length - 1].x / size.w) * 100, y: (pts[pts.length - 1].y / size.h) * 100 };
  }
  const placed = pins.filter((p) => pos[p.id]);
  const routePts = route ? placed.map((p) => `${pos[p.id].x.toFixed(2)},${pos[p.id].y.toFixed(2)}`).join(" ") : "";
  const locating = pins.some((p) => !p.coord && p.address && !lookup.has(p.address));
  const live = phase === "live";
  const label = `Map of ${pins.length} ${of}`;

  const zoomBy = (d) => {
    const map = mapRef.current;
    if (map) d > 0 ? map.zoomIn({ duration: 250 }) : map.zoomOut({ duration: 250 });
  };

  return (
    <div className={`gv-map${live ? " is-live" : ""}`} style={{ height }} ref={boxRef} role="region" aria-label={label}>
      <div className={`gv-map__static${shot ? " has-shot" : ""}`} aria-hidden={live ? "true" : undefined}>
        {shot ? <img className="gv-map__shot" src={shot.url} alt="" draggable="false" /> : <div className="gv-map__grid" />}
        {routePts ? (
          <svg className="gv-map__route" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={routePts} style={{ stroke: "var(--gv-accent, #6ea4e8)" }} />
          </svg>
        ) : null}
        {youPos ? <div className="gv-you gv-you--static" style={{ left: `${youPos.x}%`, top: `${youPos.y}%` }} role="img" aria-label="You are here" /> : null}
        {placed.map((p) => (
          <div className="gv-pinwrap gv-pinwrap--static" key={p.id} style={{ left: `${pos[p.id].x}%`, top: `${pos[p.id].y}%`, zIndex: p.selected ? 3 : 1 }}>
            <button
              type="button"
              className={pinClass(p, mode)}
              aria-label={p.name ? `${p.n}. ${p.name}` : String(p.n)}
              aria-pressed={p.selected}
              tabIndex={live ? -1 : 0}
              onClick={() => pick(p.id)}
            >
              <PinFace pin={p} mode={mode} iconUrl={iconFor(p)} />
            </button>
          </div>
        ))}
      </div>
      <div className="gv-map__livebox">
        <div className="gv-map__live" ref={liveRef} />
      </div>
      {phase === "failed" ? (
        <span className="gv-map__chip">Map unavailable · pins only</span>
      ) : parked && !live ? (
        <button type="button" className="gv-map__chip gv-map__chip--btn" onClick={() => latest.current.wake?.()}>
          Show live map
        </button>
      ) : locating ? (
        <span className="gv-map__chip">Locating addresses…</span>
      ) : !pins.some((p) => p.coord) && !shot && !filteredOut(view, of) ? (
        <span className="gv-map__chip">No locations to show</span>
      ) : null}
      {live ? (
        <div className="gv-map__zoom">
          <button type="button" className="gv-map__zbtn" aria-label="Zoom in" onClick={() => zoomBy(1)}>
            <ZoomGlyph plus />
          </button>
          <button type="button" className="gv-map__zbtn" aria-label="Zoom out" onClick={() => zoomBy(-1)}>
            <ZoomGlyph />
          </button>
        </div>
      ) : null}
      {phase === "failed" && !shot ? null : (
        <span className="gv-map__attr">
          <AttributionText text={attribution} />
        </span>
      )}
    </div>
  );
}

// The map credit, with OpenStreetMap linked to its copyright page as OSM's
// attribution guidelines ask.
const OSM = "OpenStreetMap";
function AttributionText({ text }) {
  const i = typeof text === "string" ? text.indexOf(OSM) : -1;
  if (i < 0) return text ?? null;
  return (
    <>
      {text.slice(0, i)}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">{OSM}</a>
      {text.slice(i + OSM.length)}
    </>
  );
}
