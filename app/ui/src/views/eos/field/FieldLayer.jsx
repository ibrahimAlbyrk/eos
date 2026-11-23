import { useEffect, useMemo, useRef, useState } from "react";
import { useKeybinding } from "../../../keymap/useKeymap.js";
import { setHomePick, useHomeDraft, useHomePick } from "../../../state/eos/homeDraftStore.js";
import { open as openRunSheet } from "../../../state/eos/runSheetStore.js";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { useHomeActs } from "../input/useHomeActs.js";
import { OutcomeLine } from "../input/OutcomeLine.jsx";
import { RoutinesList } from "../routines/RoutinesList.jsx";
import { LoadFailed } from "../capabilities/parts.jsx";
import { refreshRoutines } from "../../../state/eos/routinesStore.js";
import { Disc, PlusDisc } from "./Disc.jsx";
import { discStatus, discsMatching } from "./discWords.js";
import { DROP_START, DROP_STARTS_AT_ONCE, dropForm, droppedItem, droppedValue } from "./dropOnDisc.js";
import { closeField, setFieldView, shownView, useField } from "./fieldStore.js";
import { discOf, placeDiscs, ringRadii } from "./placeDiscs.js";
import { discDelays, dotDelay } from "./transition.js";
import { useWindowLayoutEffect } from "./flight.js";
import { ARC_R, ARC_TOP, ARC_W } from "../home/Horizon.jsx";

// The field's input is this wide (08 §4.6).
export const FIELD_INPUT_WIDTH = 580;
// The caption while there is no routine yet (08 §4.12).
const FIRST_RUN_CAPTION = "Your routines will gather here.";

function useWindowSize() {
  const read = () => (typeof window === "undefined" ? { W: 1440, H: 900 } : { W: window.innerWidth, H: window.innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onResize = () => setSize(read());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

// The circle Home's day arc is the crest of, in window coordinates: the
// rings start there and move to the window's centre.
function arcCircle(W, H) {
  const el = typeof document === "undefined" ? null : document.querySelector(".eos-home .eos-horizon");
  if (!el) return { x: W / 2, y: H + ARC_R, r: ARC_R };
  const rect = el.getBoundingClientRect();
  const k = rect.width / ARC_W;
  return { x: rect.left + rect.width / 2, y: rect.top + (ARC_TOP + ARC_R) * k, r: ARC_R * k };
}

// Each of Home's day dots flies to its routine's disc, or to the centre.
function aimDots(placed, W, H) {
  const dots = [...document.querySelectorAll(".eos-home .eos-horizon__dot")];
  dots.forEach((dot, i) => {
    const rect = dot.getBoundingClientRect();
    const disc = placed.discs.find((d) => d.id === dot.dataset.routine);
    const tx = W / 2 + (disc?.x ?? 0);
    const ty = H / 2 + (disc?.y ?? 0);
    dot.style.setProperty("--fx", `${tx - (rect.left + rect.width / 2)}px`);
    dot.style.setProperty("--fy", `${ty - (rect.top + rect.height / 2)}px`);
    dot.style.setProperty("--dd", `${dotDelay(i, dots.length)}ms`);
  });
}

// Leaving the field drops the input's focus too, so the next click opens it
// again (08 G21).
export function leaveField() {
  closeField();
  if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

const isEscape = (e) => e.key === "Escape" && e.target?.getAttribute?.("aria-expanded") !== "true";
const isCmdB = (e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b";

// The field (HomeField.dc.html): a fixed layer over the whole window while
// the input has focus, with the three rings, each routine's disc on the ring
// of what it needs, the ring labels, the caption above the input, the
// header, the legend, Field or List, and Back to home. Typing dims the
// discs the text is not about; a click picks a routine for the input; a drop
// starts a run. `routines`, `needs` (routine id → open items) and `next`
// (routine id → next run) come from Home's stores; `status` is "loading"
// or "failed" while the routines are not read, "offline" while the core
// does not answer, else null.
export function FieldLayer({ routines, needs, next, caption, handled, status = null, inputRef, now = Date.now() }) {
  const { open, on, phase, view } = useField();
  const { W, H } = useWindowSize();
  const text = useHomeDraft();
  const picked = useHomePick();
  const rows = useMemo(() => new Map(routines.map((r) => [r.id, r])), [routines]);
  const acts = useHomeActs(rows);
  const [notice, setNotice] = useState(null);
  const [focusAt, setFocusAt] = useState(0);
  const refs = useRef([]);

  const discs = useMemo(
    () => routines.map((r) => discOf(r, { needs: needs[r.id] ?? 0, nextAt: next[r.id] ?? null, now })),
    [routines, needs, next, now],
  );
  const placed = useMemo(() => placeDiscs(discs, { W, H, inputWidth: FIELD_INPUT_WIDTH }), [discs, W, H]);
  const order = useMemo(() => [...placed.discs].sort((a, b) => a.ring - b.ring || a.angle - b.angle), [placed]);
  const matching = discsMatching(routines, text);
  const shown = shownView(view, placed.fits);
  const radii = ringRadii(W, H);
  const delays = discDelays(order);
  const [arc, setArc] = useState(null);
  useWindowLayoutEffect(() => {
    if (phase !== "entering") return;
    setArc(arcCircle(W, H));
    aimDots(placed, W, H);
  }, [phase]);

  useKeybinding({ match: (e) => open && (isEscape(e) || isCmdB(e)), priority: 0, run: (ctx, e) => { e.preventDefault(); leaveField(); } }, [open]);
  useEffect(() => { if (!open) setNotice(null); }, [open]);

  if (!open) return null;

  const statusOf = (disc) => discStatus(disc, rows.get(disc.id), now);
  const pick = (id) => {
    setHomePick(picked === id ? null : id);
    inputRef?.current?.focus();
  };
  const openPage = (id) => {
    leaveField();
    openLocation(buildLocation({ screen: "routine", routineId: id }));
  };
  const drop = async (id, e) => {
    const routine = rows.get(id);
    const value = await droppedValue(e.dataTransfer);
    if (!value) return;
    const dropped = droppedItem(routine, value);
    if (dropped.refused) return setNotice({ error: dropped.refused });
    setNotice(null);
    if (!DROP_STARTS_AT_ONCE) return openRunSheet({ routineId: id, anchor: null, input: dropForm(routine, dropped.item) });
    if (!(await acts.run(routine, dropForm(routine, dropped.item), DROP_START))) setNotice("outcome");
  };
  const onKeyDown = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const n = order.length;
    const at = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (focusAt + step + n) % n;
    setFocusAt(at);
    refs.current[at]?.focus();
  };
  const outcome = notice === "outcome" ? acts.outcome : notice;
  const shownCaption = status !== "loading" && status !== "failed" && routines.length === 0 ? FIRST_RUN_CAPTION : caption;

  return (
    <div
      className={`eos-field${on ? " is-on" : ""}${phase === "entering" || phase === "leaving" ? " is-moving" : ""}`}
      role="dialog"
      aria-label="Your routines around the input"
      style={{
        "--cx": `${W / 2}px`, "--cy": `${H / 2}px`,
        "--hx": `${arc?.x ?? W / 2}px`, "--hy": `${arc?.y ?? H + ARC_R}px`, "--hr": `${arc?.r ?? ARC_R}px`,
        "--r1": `${radii[0]}px`, "--r2": `${radii[1]}px`, "--r3": `${radii[2]}px`,
      }}
    >
      <div className="eos-field__backdrop" onClick={leaveField} />
      <svg className="eos-field__rings" aria-hidden="true" width={W} height={H}>
        {radii.map((r, i) => <circle key={i} className={`eos-field__ring eos-field__ring--${i + 1}`} />)}
      </svg>
      {shown === "field" && placed.ringLabels.filter((l) => !l.hidden).map((l) => (
        <span key={l.ring} className="eos-field__ringlabel eos-field__fx" style={{ "--x": `${l.x}px`, "--y": `${l.y}px` }}>{l.text}</span>
      ))}
      <header className="eos-field__head eos-field__fx eos-field__fx--early">
        <span className="eos-input__gap" />
        {status === "offline" ? <span className="eos-field__handled" role="status">Reconnecting…</span> : handled && <span className="eos-field__handled">{handled}</span>}
      </header>
      {shownCaption && <p className="eos-field__caption">{shownCaption}</p>}
      {shown === "field" ? (
        <div className="eos-field__discs" role="group" aria-label="Your routines" onKeyDown={onKeyDown}>
          {order.map((place, i) => (
            <Disc
              key={place.id}
              ref={(el) => { refs.current[i] = el; }}
              place={place}
              delay={delays[i]}
              row={rows.get(place.id)}
              status={statusOf(discs.find((d) => d.id === place.id))}
              picked={picked === place.id}
              dim={picked ? picked !== place.id : matching.size > 0 && !matching.has(place.id)}
              focusable={i === Math.min(focusAt, order.length - 1)}
              onFocus={() => setFocusAt(i)}
              onPick={() => pick(place.id)}
              onOpen={() => openPage(place.id)}
              onDrop={(e) => void drop(place.id, e)}
            />
          ))}
          {placed.plusDiscs.map((p) => <PlusDisc key={`plus-${p.ring}`} place={p} onOpen={() => setFieldView("list")} />)}
        </div>
      ) : (
        <div className="eos-field__list eos-field__fx">
          <RoutinesList discs={discs} rows={rows} statusOf={statusOf} picked={picked} onPick={pick} onOpen={openPage} />
        </div>
      )}
      <div className="eos-field__notice" aria-live="polite">
        {status === "failed" ? <LoadFailed what="routines" retry={() => void refreshRoutines()} /> : outcome && <OutcomeLine outcome={outcome} again={() => void acts.again()} />}
      </div>
      <p className="eos-field__legend eos-field__fx">
        {shown === "field" ? "The closer a routine sits to the centre, the sooner it needs you. Its size shows how much it does." : "Click a routine to give it something. Its arrow opens its page."}
      </p>
      <div className="eos-field__views eos-field__fx" role="group" aria-label="View">
        <button type="button" aria-pressed={shown === "field"} onClick={() => setFieldView("field")}>Field</button>
        <button type="button" aria-pressed={shown === "list"} onClick={() => setFieldView("list")}>List</button>
      </div>
      <button type="button" className="eos-field__back eos-field__fx" onClick={leaveField}>
        Back to home <span className="eos-intent__key">esc</span>
      </button>
    </div>
  );
}
