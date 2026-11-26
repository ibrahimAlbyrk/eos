import { useEffect, useState } from "react";
import {
  discardDraft, loadDraft, loadVersion, loadVersions, restoreVersion, runTrial, saveBlueprint, startRoutine, useBlueprints,
} from "../../../state/eos/blueprintStore.js";
import { useCapabilities } from "../../../state/eos/capabilitiesStore.js";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { ensureRunsLoaded, useRuns } from "../../../state/eos/runsStore.js";
import { Loading } from "../capabilities/parts.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { ArchitectChat } from "./ArchitectChat.jsx";
import { BlueprintCard } from "./BlueprintCard.jsx";
import { changedSlots, SLOTS } from "./slots/index.js";
import { TrialCards } from "./TrialCards.jsx";
import { VersionCompare } from "./VersionCompare.jsx";
import { VersionMenu } from "./VersionMenu.jsx";
import { costLine, issueLine, versionDate } from "./words.js";

// Which version the card shows, by what the routine is doing:
// - "newest": a routine being made shows its newest version, which a hand
//   edit and Start build on;
// - "draft": an architect's change of a running routine, not in use yet;
// - "head": the version in use, which a hand edit builds on;
// - "old": a version chosen from the version menu, read-only.
export function shownVersion(detail, draft, rows, number) {
  if (number !== undefined) return { kind: "old", versionId: rows?.find((r) => r.number === number)?.id };
  if (detail.routine.state === "draft") {
    const newest = rows?.at(-1);
    return { kind: "newest", versionId: newest?.id ?? draft?.draftVersionId ?? detail.head?.id };
  }
  if (draft?.draftVersionId && draft.status !== "abandoned") return { kind: "draft", versionId: draft.draftVersionId };
  return { kind: "head", versionId: detail.head?.id };
}

// The keys a finding's path may start with to be said under its slot.
const SLOT_KEYS = new Set([...SLOTS.map((s) => s.key), "freedom"]);

// What the last write left to say: changed elsewhere, refused with its
// findings, kept with warnings, or why a start did not happen. A finding on
// a slot is said under that slot; the band names those slots and lists the
// others.
export function Note({ note }) {
  if (!note || note.kind === "crowded" || note.kind === "refusal") return null;
  const tone = note.kind === "warnings" ? "eos-band--warn" : "eos-band--err";
  const issues = note.issues ?? [];
  const slots = [...SLOTS, { key: "freedom", label: "Freedom" }].filter((s) => issues.some((i) => i.path?.[0] === s.key)).map((s) => s.label);
  const rest = issues.filter((i) => !SLOT_KEYS.has(i.path?.[0]));
  const named = slots.length === 0 ? "" : ` ${slots.length === 1 ? `${slots[0]} needs` : `${slots.slice(0, -1).join(", ")} and ${slots.at(-1)} need`} you below.`;
  return (
    <div className={`eos-band ${tone}`} role="alert">
      <span className="eos-band__text">{note.text}{named}</span>
      {rest.length > 0 && <ul className="eos-bp-issues">{rest.map((i) => <li key={issueLine(i)}>{issueLine(i)}</li>)}</ul>}
    </div>
  );
}

// A draft's trial runs; a routine made by hand has no draft, so its trials
// are read from its runs.
function trialRunsOf(draft, page) {
  if (draft) return draft.trialRuns;
  return page?.runs?.filter((run) => run.kind === "trial") ?? [];
}

const COUNT = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const pastItems = (n) => `${COUNT[n] ?? n} past item${n === 1 ? "" : "s"}`;

// What the ending says before its buttons: why the first one is first.
function endLine({ kind, draft, trials }) {
  if (kind === "draft") return "Nothing changes until you use it. The version in use keeps running until then.";
  if (draft?.status === "working" || draft?.status === "trying") return "The architect is still at work. Nothing runs until you start it.";
  if (draft?.status === "asking") return "The architect has one question. Answer it, or start it as it is.";
  const passed = trials.filter((run) => run.state === "done").length;
  if (passed) return `It went well on ${pastItems(passed)}, and nothing was sent. Nothing runs until you start it.`;
  return "Nothing runs until you start it. A trial, if you want one, tries it on real past items and sends nothing.";
}

// The card's ending: one line of where it stands, the one primary step and
// the quiet others, and what it costs under them.
function Actions({ id, kind, trials, routine, blueprint, draft, startsAbove = false }) {
  const tried = trials.length > 0;
  const cost = costLine(routine, blueprint, useCapabilities().list ?? []);
  const trial = <button type="button" className="eos-btn eos-btn--ghost" onClick={() => void runTrial(id)}>{tried ? "Run the trial again" : "Run a trial"}</button>;
  return (
    <div className="eos-bp-end">
      <p className="eos-bp-end__line" role="status">{endLine({ kind, draft, trials })}</p>
      <div className="eos-bp-actions">
        {kind === "newest" && (
          <>
            {/* Started from the lead when the lead offers it: one place per action. */}
            {!startsAbove && <button type="button" className="eos-btn eos-btn--primary" onClick={() => void startRoutine(id)}>Start it</button>}
            {trial}
          </>
        )}
        {kind === "draft" && (
          <>
            <button type="button" className="eos-btn eos-btn--primary" onClick={() => void startRoutine(id)}>Use this version</button>
            <button type="button" className="eos-btn eos-btn--ghost" onClick={() => void discardDraft(id)}>Discard</button>
            {trial}
          </>
        )}
      </div>
      {cost && <p className="eos-bp-end__cost">{cost}</p>}
    </div>
  );
}

// How a version came to be, said after "made".
const MADE = { user: "by you", restore: "by you", once: "by you", architect: "by talking", eos: "from Eos's suggestion", sync: "on another Mac", import: "from a file" };

// Under an old version: what it is, then Restore this version (a new
// version from it), Compare with current, and the way back to the version
// in use.
function OldActions({ id, versionId, row, inUseRow, restorable, comparing, setComparing }) {
  const back = () => openLocation(buildLocation({ screen: "routine", routineId: id, tab: "blueprint" }));
  const made = row ? [MADE[row.author], row.createdAt && `on ${versionDate(row.createdAt)}`].filter(Boolean).join(" ") : "";
  const line = row && `You are reading version ${row.number}${made ? `, made ${made}` : ""}.${inUseRow && inUseRow.id !== row.id ? ` The routine runs version ${inUseRow.number}.` : ""}`;
  return (
    <div className="eos-bp-end">
      {line && <p className="eos-bp-end__line">{line}</p>}
      <div className="eos-bp-actions">
        {restorable && (
          <button type="button" className="eos-btn eos-btn--primary" onClick={async () => { if (await restoreVersion(id, versionId)) back(); }}>
            Restore this version
          </button>
        )}
        {inUseRow && <button type="button" className="eos-btn eos-btn--ghost" aria-pressed={comparing} onClick={() => setComparing(!comparing)}>Compare with current</button>}
        <button type="button" className="eos-btn eos-btn--ghost" onClick={back}>Back to the version in use</button>
      </div>
    </div>
  );
}

// A routine being made says where it stands above its two columns, as a
// screen's lead: what the architect is doing, or what is left to the user.
export function makingLead(draft) {
  if (!draft) return "Set each part, then start it.";
  if (draft.status === "working") return draft.draftVersionId ? "Eos is changing the blueprint." : "Eos is writing the blueprint.";
  if (draft.status === "trying") return "Eos is trying it on real past items.";
  if (draft.status === "asking") return "One question, then it is ready.";
  if (draft.status === "abandoned") return "You left this draft.";
  return "Ready to start.";
}


// The Blueprint tab: the architect conversation beside the blueprint card,
// the draft's trials under it. A routine being made leads with where it
// stands. A hand edit keeps a new version at once from the version shown;
// the editor never keeps an architect's version by itself: Start and Use
// this version are the user's.
export function BlueprintEditor({ detail, versionNumber }) {
  const id = detail.routine.id;
  const { drafts, versions, blueprints, said, notes } = useBlueprints();
  const { list } = useRoutines();
  const { pages } = useRuns();
  const [comparing, setComparing] = useState(false);
  useEffect(() => {
    void loadDraft(id);
    void loadVersions(id);
  }, [id]);

  const draft = drafts[id];
  useEffect(() => { if (draft === null) ensureRunsLoaded(id); }, [id, draft]);
  const trials = trialRunsOf(draft, pages[id]);
  const rows = versions[id];
  const view = shownVersion(detail, draft, rows, versionNumber);
  const inUseId = detail.routine.state === "draft" ? rows?.at(-1)?.id : detail.head?.id;
  useEffect(() => {
    for (const vid of [view.versionId, inUseId]) if (vid && vid !== detail.head?.id) void loadVersion(id, vid);
  }, [id, view.versionId, inUseId, detail.head?.id]);

  const making = detail.routine.state === "draft";
  const bodyOf = (vid) => (vid === detail.head?.id ? detail.head : blueprints[vid]);
  const version = bodyOf(view.versionId);
  const inUse = inUseId && bodyOf(inUseId);
  const row = rows?.find((r) => r.id === view.versionId) ?? version;
  const newer = version?.runnable === false;
  const old = view.kind === "old";
  const editable = view.kind !== "draft" && !old && !newer;
  const onEdit = editable ? (next) => void saveBlueprint(id, view.versionId, next) : undefined;
  const changed = view.kind === "draft" ? draft.changed : old && inUse ? changedSlots(version?.blueprint, inUse.blueprint) : [];
  const writing = !old && draft?.status === "working";
  const suffix = { draft: ", not in use yet", newest: ", not running yet" }[view.kind] ?? "";
  const head = row && (rows
    ? <VersionMenu routineId={id} rows={rows} shown={row} inUseId={inUseId} suffix={suffix} />
    : <span className="eos-bp-card__version">Version {row.number}{suffix}</span>);
  const { name, summary, icon } = detail.routine;
  const ready = making && view.kind === "newest" && makingLead(draft) === "Ready to start.";

  return (
    <div className={making ? "eos-bp eos-bp--making" : "eos-bp"}>
      {making && (
        <header className="eos-bp__lead">
          <h2 className="eos-lead">{makingLead(draft)}</h2>
          {/* Ready, the one step left stands under the lead, above the fold. */}
          {ready && (
            <div className="eos-rlead__acts">
              <button type="button" className="eos-btn eos-btn--primary" onClick={() => void startRoutine(id)}>Start it</button>
            </div>
          )}
        </header>
      )}
      <div className="eos-bp__cols">
        <ArchitectChat routineId={id} draft={draft} said={said[id]} note={notes[id]} making={making} />
        <div className="eos-bp__side">
          <Note note={notes[id]} />
          {newer && <p className="eos-note">A newer version of Eos made this blueprint. It can be read here, not changed or run.</p>}
          {!version && (view.versionId || (old && !rows)) && <Loading blocks={4} />}
          {!view.versionId && writing && <BlueprintCard blueprint={{ name, summary, icon }} writing routines={list} head={<span className="eos-bp-card__version">Version 1, being written</span>} />}
          {!view.versionId && !writing && (!old || rows) && <p className="eos-note">{old ? "This routine has no such version." : "This routine has no blueprint yet."}</p>}
          {version && (
            <BlueprintCard blueprint={version.blueprint} onEdit={onEdit} changed={changed} issues={notes[id]?.issues} writing={writing} routines={list} head={head} routineId={id}>
              {old && (
                <OldActions
                  id={id}
                  versionId={view.versionId}
                  row={rows?.find((r) => r.id === view.versionId)}
                  inUseRow={inUse && (rows?.find((r) => r.id === inUseId) ?? { id: inUseId, number: inUse.number })}
                  restorable={view.versionId !== inUseId && !newer}
                  comparing={comparing}
                  setComparing={setComparing}
                />
              )}
              {!old && !newer && (
                <Actions
                  id={id}
                  kind={view.kind}
                  trials={trials}
                  routine={detail.routine}
                  blueprint={version.blueprint}
                  draft={draft}
                  startsAbove={ready}
                />
              )}
            </BlueprintCard>
          )}
          {old && comparing && version && inUse && <VersionCompare version={version.blueprint} current={inUse.blueprint} routines={list} numbers={[row?.number, rows?.find((r) => r.id === inUseId)?.number ?? inUse.number]} />}
          {!old && <TrialCards runs={trials} now={Date.now()} />}
        </div>
      </div>
    </div>
  );
}
