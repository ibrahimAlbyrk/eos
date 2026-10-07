import { useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { noteTransfer, undecided } from "../../state/transfersStore.js";
import { transferMode, transfers } from "../../lib/transferClient.js";
import { formatBytes, fmtTimeAgo } from "../../lib/format.js";
import { openFolder } from "../files/openFolder.js";
import { CheckIcon, CloseIcon, WarnIcon } from "../../components/machines/icons.jsx";
import { IntoIcon, OutIcon, PauseIcon, PlayIcon } from "./icons.jsx";
import { etaLabel, folderName, namesOf, percentOf, rateLabel, routeWord, tildify } from "./text.js";

const act = (p) => p.then(noteTransfer).catch(() => {});

// One transfer as it stands: moving, waiting on a decision, paused, failed or done.
export function TransferCard({ t, label, onDismiss }) {
  const ui = useUi();
  const pct = percentOf(t);
  const pending = undecided(t);
  const into = t.to === "local";
  const other = label(into ? t.from : t.to);
  const names = namesOf(t);
  const moving = t.status === "copying" || t.status === "scanning" || t.status === "queued" || t.status === "committing";
  const stalled = t.status === "paused" || t.status === "interrupted";

  if (t.status === "done") {
    const count = t.placed.length;
    return (
      <div className="tx-card">
        <div className="tx-card__head">
          <span className="tx-tile tx-tile--ok"><CheckIcon /></span>
          <span className="tx-card__text">
            <span className="tx-card__title">{count === 1 ? `${t.placed[0].name} copied` : `${count} items copied`}</span>
            <span className="tx-card__sub mono">{tildify(t.destDir)}</span>
          </span>
          {transferMode() === "local" && t.to === "local" && (
            <button type="button" className="m-btn m-btn--quiet m-btn--sm" onClick={() => openFolder(ui, t.destDir)}>Open in Files</button>
          )}
          {transfers.canReveal(t) && <button type="button" className="m-btn m-btn--sm" onClick={() => void transfers.reveal(t)}>Show in Finder</button>}
          <Dismiss onClick={onDismiss} />
        </div>
      </div>
    );
  }

  if (t.status === "failed") {
    return (
      <div className="tx-card">
        <div className="tx-card__head">
          <span className="tx-tile tx-tile--err"><WarnIcon size={15} /></span>
          <span className="tx-card__text">
            <span className="tx-card__title">Couldn’t copy {names}</span>
            <span className="tx-card__sub is-err">{t.error?.message ?? "Something went wrong."}</span>
          </span>
          <button type="button" className="m-btn m-btn--sm" onClick={() => void act(transfers.resume(t.id))}>Try again</button>
          <Dismiss onClick={onDismiss} />
        </div>
      </div>
    );
  }

  const title = {
    queued: `Waiting to copy ${names}`,
    scanning: `Getting ${names} ready`,
    copying: `Copying ${names}`,
    conflict: `${names} ${t.roots.length > 1 ? "are" : "is"} ready`,
    committing: `Putting ${names} in place`,
    paused: `Paused at ${pct}%`,
    interrupted: `${other} went out of reach`,
  }[t.status] ?? names;
  const sub = t.status === "conflict" ? "Waiting for your choice"
    : t.status === "interrupted" ? `Stopped at ${pct}% — resume when it’s back`
    : `${into ? "from" : "to"} ${other}`;
  const meta = moving && t.status === "copying"
    ? [rateLabel(t.rate), routeWord(t.route), etaLabel(t)].filter(Boolean).join(" · ")
    : null;

  return (
    <div className="tx-card">
      <div className="tx-card__head">
        <span className={"tx-tile" + (stalled ? " tx-tile--warn" : " tx-tile--accent")}>{into ? <IntoIcon size={15} /> : <OutIcon size={15} />}</span>
        <span className="tx-card__text">
          <span className="tx-card__title">{title}</span>
          <span className={"tx-card__sub" + (t.status === "interrupted" ? " is-warn" : "")}>
            {t.origin.kind === "agent" && <span className="tx-by">{t.origin.agentName ?? "Agent"} · </span>}
            {sub}
          </span>
        </span>
        {stalled
          ? <button type="button" className="m-btn m-btn--sm" onClick={() => void act(transfers.resume(t.id))}><PlayIcon />Resume</button>
          : t.status !== "committing" && (
            <button type="button" className="tx-iconbtn" aria-label="Pause" title="Pause" onClick={() => void act(transfers.pause(t.id))}><PauseIcon /></button>
          )}
        {t.status !== "committing" && (
          <button type="button" className="tx-iconbtn" aria-label="Cancel" title="Cancel" onClick={() => void act(transfers.cancel(t.id))}><CloseIcon /></button>
        )}
      </div>
      {t.status !== "queued" && (
        <span className="tx-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Copied">
          <span className={"tx-progress__fill" + (stalled ? " is-stalled" : "")} style={{ width: `${pct}%` }} />
        </span>
      )}
      {(meta || t.totalBytes > 0) && (
        <div className="tx-card__meta mono">
          <span>{meta || `${formatBytes(t.doneBytes)} of ${formatBytes(t.totalBytes)}`}</span>
          {meta && <span className="tx-card__meta-end">{pct}%</span>}
        </div>
      )}
      {pending.length > 0 && <Conflict t={t} pending={pending} destLabel={label(t.to)} />}
    </div>
  );
}

// "web.zip is already in builds" — what's there against what's coming, then the
// choice. Replacing is never final: the old one goes to the Trash.
function Conflict({ t, pending, destLabel }) {
  const [all, setAll] = useState(false);
  const c = pending[0];
  const decide = (d) => {
    const names = all ? pending.map((p) => p.name) : [c.name];
    void act(transfers.decide(t.id, Object.fromEntries(names.map((n) => [n, d]))));
  };
  const newer = c.incoming.mtimeMs > c.existing.mtimeMs;
  const sizeOf = (side) => (side.type === "dir" ? "folder" : side.size != null ? formatBytes(side.size) : "");
  return (
    <div className="tx-conflict">
      <div className="tx-conflict__head">
        <span className="tx-tile tx-tile--warn tx-tile--sm"><WarnIcon size={13} /></span>
        <span className="tx-card__text">
          <span className="tx-card__title"><span className="tx-conflict__name">{c.name}</span> is already in {folderName(t.destDir)}</span>
          <span className="tx-card__sub">Replaced files go to the Trash.</span>
        </span>
      </div>
      <div className="tx-compare">
        <div className="tx-compare__side">
          <span className="tx-compare__k">On {destLabel}</span>
          <span className="tx-compare__v mono">{[sizeOf(c.existing), fmtTimeAgo(c.existing.mtimeMs)].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="tx-compare__side is-incoming">
          <span className="tx-compare__k">Incoming{newer ? " · newer" : ""}</span>
          <span className="tx-compare__v mono">{[sizeOf(c.incoming), fmtTimeAgo(c.incoming.mtimeMs)].filter(Boolean).join(" · ")}</span>
        </div>
      </div>
      <div className="tx-conflict__acts">
        {pending.length > 1 ? (
          <label className="tx-all">
            <input type="checkbox" className="tx-check tx-check--sm" checked={all} onChange={(e) => setAll(e.target.checked)} />
            Same for the other {pending.length - 1}
          </label>
        ) : <span className="tx-all" />}
        <button type="button" className="m-btn m-btn--quiet m-btn--sm" onClick={() => decide("skip")}>Skip</button>
        <button type="button" className="m-btn m-btn--sm" onClick={() => decide("keep")}>Keep both</button>
        <button type="button" className="m-btn m-btn--accent m-btn--sm" onClick={() => decide("replace")}>Replace</button>
      </div>
    </div>
  );
}

// Absent where there's nothing to dismiss from (the chat's tool card).
function Dismiss({ onClick }) {
  if (!onClick) return null;
  return <button type="button" className="tx-iconbtn" aria-label="Dismiss" title="Dismiss" onClick={onClick}><CloseIcon /></button>;
}
