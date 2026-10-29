import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../state/ui.jsx";
import { ensureUpdateLoaded, updateActions, useUpdate } from "../../state/updateStore.js";
import { beaconOf, downloadProgressText, noticeText, progressOf, readyDetail, workingAgents } from "../../lib/updates.js";
import { formatBytes } from "../../lib/format.js";
import { nameOf } from "../../lib/agentName.js";
import { isRemoteView } from "../../lib/host.js";
import { UpdateMark } from "./UpdateMark.jsx";
import { useOpenReleaseNotes } from "./useOpenReleaseNotes.js";

const POP = "update";

// The header's update button: a quiet pill that shows a download's progress
// ring, then "Update" with a lit dot once a new version is staged. Opens a glass
// popover — what is ready, how little it cost, and Restart now / Later (or, with
// agents working, "When they finish"). Hidden while there's nothing to say.
export function UpdateBeacon({ live }) {
  const ui = useUi();
  const state = useUpdate();
  const btnRef = useRef(null);
  useEffect(() => { if (!isRemoteView()) ensureUpdateLoaded(); }, []);

  const open = ui.openPopover === POP;
  const beacon = beaconOf(state);
  if (!beacon && !open) return null;

  const toggle = (e) => {
    e.stopPropagation();
    if (open) ui.closeAllPops();
    else ui.openPop(POP);
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`up-beacon is-${beacon?.kind ?? "ready"}` + (open ? " is-open" : "")}
        data-popover-trigger={POP}
        aria-expanded={open}
        aria-label={beacon?.kind === "downloading" ? `Downloading Eos ${beacon.label}` : "Eos update"}
        onClick={toggle}
      >
        <BeaconGlyph beacon={beacon} />
        {beacon && <span>{beacon.label}</span>}
      </button>
      {open && state && <UpdatePopover anchor={btnRef} state={state} workers={live?.workers} />}
    </>
  );
}

function BeaconGlyph({ beacon }) {
  switch (beacon?.kind) {
    case "downloading": return <ProgressRing progress={beacon.progress} />;
    case "waiting": return <ClockGlyph />;
    case "applying": return <span className="up-spin" aria-hidden="true" />;
    case "updated": return <CheckGlyph />;
    case "error": return <span className="up-dot is-error" aria-hidden="true" />;
    default: return <span className="up-dot" aria-hidden="true" />;
  }
}

function UpdatePopover({ anchor, state, workers }) {
  const ui = useUi();
  const openNotes = useOpenReleaseNotes();
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, [anchor]);
  if (!pos) return null;

  const close = () => ui.closeAllPops();
  const run = (action) => { close(); void action(); };
  return createPortal(
    <div className="up-pop glass-pop" data-popover={POP} role="dialog" aria-label="Eos update" style={{ top: pos.top, right: pos.right }}>
      <UpdatePopoverBody state={state} agents={workingAgents(workers)} close={close} run={run} openNotes={openNotes} />
    </div>,
    document.body,
  );
}

// What the popover says and offers for the update state at hand.
export function UpdatePopoverBody({ state, agents, close, run, openNotes }) {
  const { status, notice } = state;
  const v = status.version;
  switch (status.phase) {
    case "downloading":
    case "staging":
      return (
        <>
          <Head title={status.phase === "staging" ? `Preparing Eos ${v}` : `Downloading Eos ${v}`}
            detail={status.phase === "staging" ? "Building the new version beside this one" : downloadProgressText(status)} />
          <Meter value={progressOf(status)} />
        </>
      );
    case "available":
      return (
        <>
          <Head title={`Eos ${v} is available`} detail="Only what changed is downloaded" />
          <Actions>
            <button type="button" className="up-btn" onClick={close}>Later</button>
            <button type="button" className="up-btn up-btn--primary" onClick={() => run(updateActions.download)}>Download</button>
          </Actions>
        </>
      );
    case "waiting":
      return (
        <>
          <Head title="Restarts when these finish" detail={`Eos ${v} is ready`} />
          <AgentList agents={agents} />
          <Actions>
            <button type="button" className="up-btn" onClick={() => run(updateActions.later)}>Don't wait</button>
            <button type="button" className="up-btn up-btn--primary" onClick={() => run(() => updateActions.restart("now"))}>Restart now</button>
          </Actions>
        </>
      );
    case "applying":
      return <Head title={`Restarting into Eos ${v}…`} detail="Eos closes and opens the new version" />;
    case "error":
      if (!v) break;
      return (
        <>
          <Head title={`Couldn't update to ${v}`} detail={status.error} />
          <Actions>
            <button type="button" className="up-btn" onClick={close}>Close</button>
            <button type="button" className="up-btn up-btn--primary" onClick={() => run(updateActions.check)}>Try again</button>
          </Actions>
        </>
      );
    case "ready":
    case "checking":
      if (!v) break;
      return (
        <>
          <Head title={`Eos ${v} is ready`} detail="Downloaded in the background" />
          <SizeCompare status={status} />
          <div className="up-sep" />
          <button type="button" className="up-row-link" onClick={() => openNotes(v)}>
            <NotesGlyph />
            What’s new in {v}
            <ChevronGlyph />
          </button>
          {agents.length > 0 && <AgentList agents={agents} />}
          <Actions>
            {agents.length > 0 ? (
              <>
                <button type="button" className="up-btn" onClick={() => run(() => updateActions.restart("now"))}>Restart now</button>
                <button type="button" className="up-btn up-btn--primary" onClick={() => run(() => updateActions.restart("idle"))}>When they finish</button>
              </>
            ) : (
              <>
                <button type="button" className="up-btn" onClick={close}>Later</button>
                <button type="button" className="up-btn up-btn--primary" onClick={() => run(() => updateActions.restart("now"))}>Restart now</button>
              </>
            )}
          </Actions>
        </>
      );
    default:
      break;
  }
  const text = noticeText(notice);
  if (!text) return <Head title="Eos is up to date" detail={state.current} />;
  return (
    <>
      <Head title={text.title} detail={text.detail} />
      <Actions>
        {notice.kind === "updated" && <button type="button" className="up-btn" onClick={() => { void updateActions.dismissNotice(); openNotes(notice.version); }}>What’s new</button>}
        <button type="button" className="up-btn up-btn--primary" onClick={() => run(updateActions.dismissNotice)}>OK</button>
      </Actions>
    </>
  );
}

function Head({ title, detail }) {
  return (
    <div className="up-head">
      <UpdateMark />
      <div className="up-head__text">
        <span className="up-head__title">{title}</span>
        {detail && <span className="up-head__detail">{detail}</span>}
      </div>
    </div>
  );
}

// "14.2 MB of 236 MB" — what came down next to what a full download would be.
function SizeCompare({ status }) {
  if (status.bytes == null || !status.full) return <span className="up-note">{readyDetail(status)}</span>;
  return (
    <div className="up-size">
      <div className="up-size__row">
        <span>Downloaded</span>
        <span className="up-size__n">{formatBytes(status.bytes)} <span className="up-size__of">of {formatBytes(status.full)}</span></span>
      </div>
      <Meter value={status.bytes / status.full} />
      <span className="up-note">Only the files that changed</span>
    </div>
  );
}

function AgentList({ agents }) {
  if (!agents.length) return null;
  return (
    <div className="up-agents">
      <span className="up-agents__title">{agents.length === 1 ? "1 agent is working" : `${agents.length} agents are working`}</span>
      {agents.slice(0, 4).map((w) => <span key={w.id} className="up-agent">{nameOf(w)}</span>)}
    </div>
  );
}

function Actions({ children }) {
  return <div className="up-actions">{children}</div>;
}

function Meter({ value }) {
  return (
    <div className="up-meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className="up-meter__fill" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

function ProgressRing({ progress }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg className="up-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="up-ring__track" cx="8" cy="8" r={r} fill="none" strokeWidth="2" />
      <circle className="up-ring__fill" cx="8" cy="8" r={r} fill="none" strokeWidth="2" strokeLinecap="round"
        strokeDasharray={`${c * Math.max(0.04, progress)} ${c}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}

function ClockGlyph() {
  return (
    <svg className="up-glyph is-wait" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg className="up-glyph is-ok" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

function NotesGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4h9l3 3v13H6z" /><path d="M9 11h6M9 15h4" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
