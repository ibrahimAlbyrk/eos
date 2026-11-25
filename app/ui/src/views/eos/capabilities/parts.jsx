import { checkCapability, setCapabilityEnabled, useCapabilities } from "../../../state/eos/capabilitiesStore.js";
import { startSignIn } from "../../../state/eos/capabilitySignInStore.js";
import { fixLabel, stateLine, stateTone, stateWord } from "./words.js";

// The core did not answer the last read; what was read stays (08 G35).
export function OfflineNote() {
  const { offline } = useCapabilities();
  return offline ? <p className="eos-cap-offline" role="status">Reconnecting…</p> : null;
}

export const DEV_RUN_TEXT = "This is a dev run: nothing starts or leaves the Mac.";

export function DevRunNote() {
  return <p className="eos-note" role="status">{DEV_RUN_TEXT}</p>;
}

// The state in words with its dot, and why.
export function CapabilityState({ row }) {
  const tone = stateTone(row);
  const line = stateLine(row);
  return (
    <span className="eos-cap-state">
      <span className={tone ? `eos-status eos-status--${tone}` : "eos-status"}>{stateWord(row)}</span>
      {line && <span className="eos-cap-line">{line}</span>}
    </span>
  );
}

const RUN_FIX = {
  "sign-in": (id) => startSignIn(id),
  enable: (id) => setCapabilityEnabled(id, true),
  check: (id) => checkCapability(id),
};

export function FixButton({ row, fix, primary = false }) {
  return (
    <button type="button" className={primary ? "eos-btn eos-btn--primary" : "eos-btn"} onClick={() => void RUN_FIX[fix](row.id)}>
      {fixLabel(row, fix)}
    </button>
  );
}

// The shape of a list still coming: a label, then rows on hairlines, each a
// title and a line. Drawn only once a read has taken 300 ms (eos.css).
export function LoadingRows({ rows = 3 }) {
  return (
    <div className="eos-skeleton eos-skeleton--rows" aria-busy="true" aria-label="Loading">
      <span className="eos-skeleton__label" />
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="eos-skeleton__row"><span /><span /></span>
      ))}
    </div>
  );
}

// Skeleton blocks, drawn only once a read has taken 300 ms (eos.css).
export function Loading({ blocks = 3 }) {
  return (
    <div className="eos-skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: blocks }, (_, i) => <span key={i} className="eos-skeleton__block" />)}
    </div>
  );
}

export function LoadFailed({ what, retry }) {
  return (
    <p className="eos-note" role="alert">
      Couldn&apos;t load {what}. <button type="button" className="eos-link" onClick={retry}>Try again</button>
    </p>
  );
}
