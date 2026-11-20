import { useEffect, useState } from "react";
import {
  discardDraft, loadDraft, loadVersion, loadVersions, restoreVersion, runTrial, saveBlueprint, startRoutine, useBlueprints,
} from "../../../state/eos/blueprintStore.js";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { ensureRunsLoaded, useRuns } from "../../../state/eos/runsStore.js";
import { Loading } from "../capabilities/parts.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { ArchitectChat } from "./ArchitectChat.jsx";
import { BlueprintCard } from "./BlueprintCard.jsx";
import { changedSlots } from "./slots/index.js";
import { TrialCards } from "./TrialCards.jsx";
import { VersionCompare } from "./VersionCompare.jsx";
import { VersionMenu } from "./VersionMenu.jsx";
import { costLine, issueLine } from "./words.js";

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

// What the last write left to say: changed elsewhere, refused with its
// findings, kept with warnings, or why a start did not happen.
function Note({ note }) {
  if (!note || note.kind === "crowded" || note.kind === "refusal") return null;
  const tone = note.kind === "warnings" ? "eos-band--warn" : "eos-band--err";
  return (
    <div className={`eos-band ${tone}`} role="alert">
      <span className="eos-band__text">{note.text}</span>
      {note.issues?.length > 0 && <ul className="eos-bp-issues">{note.issues.map((i) => <li key={issueLine(i)}>{issueLine(i)}</li>)}</ul>}
    </div>
  );
}

// A draft's trial runs; a routine made by hand has no draft, so its trials
// are read from its runs.
function trialRunsOf(draft, page) {
  if (draft) return draft.trialRuns;
  return page?.runs?.filter((run) => run.kind === "trial") ?? [];
}

function Actions({ id, kind, trials, routine, blueprint }) {
  const tried = trials.length > 0;
  const cost = costLine(routine, blueprint);
  const trial = <button type="button" className="eos-btn" onClick={() => void runTrial(id)}>{tried ? "Run the trial again" : "Run a trial"}</button>;
  return (
    <div className="eos-bp-actions">
      {kind === "newest" && (
        <>
          <button type="button" className="eos-btn eos-btn--primary" onClick={() => void startRoutine(id)}>Start it</button>
          <button type="button" className="eos-btn" onClick={() => void startRoutine(id, true)}>Start without a trial</button>
          {trial}
        </>
      )}
      {kind === "draft" && (
        <>
          <button type="button" className="eos-btn eos-btn--primary" onClick={() => void startRoutine(id)}>Use this version</button>
          <button type="button" className="eos-btn" onClick={() => void discardDraft(id)}>Discard</button>
          {trial}
        </>
      )}
      {cost && <span className="eos-bp-actions__cost">{cost}</span>}
    </div>
  );
}

// Under an old version: Restore this version (a new version from it),
// Compare with current, and the way back to the version in use.
function OldActions({ id, versionId, inUse, restorable, comparing, setComparing }) {
  const back = () => openLocation(buildLocation({ screen: "routine", routineId: id, tab: "blueprint" }));
  return (
    <div className="eos-bp-actions">
      {restorable && (
        <button type="button" className="eos-btn eos-btn--primary" onClick={async () => { if (await restoreVersion(id, versionId)) back(); }}>
          Restore this version
        </button>
      )}
      {inUse && <button type="button" className="eos-btn" aria-pressed={comparing} onClick={() => setComparing(!comparing)}>Compare with current</button>}
      <button type="button" className="eos-btn" onClick={back}>Back to the version in use</button>
    </div>
  );
}

// The Blueprint tab: the architect conversation beside the blueprint card,
// the draft's trial cards under it. A hand edit keeps a new version at
// once from the version shown; the editor never keeps an architect's
// version by itself: Start and Use this version are the user's.
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

  const bodyOf = (vid) => (vid === detail.head?.id ? detail.head : blueprints[vid]);
  const version = bodyOf(view.versionId);
  const inUse = inUseId && bodyOf(inUseId);
  const row = rows?.find((r) => r.id === view.versionId) ?? version;
  const newer = version?.runnable === false;
  const old = view.kind === "old";
  const editable = view.kind !== "draft" && !old && !newer;
  const onEdit = editable ? (next) => void saveBlueprint(id, view.versionId, next) : undefined;
  const changed = view.kind === "draft" ? draft.changed : old && inUse ? changedSlots(version?.blueprint, inUse.blueprint) : [];
  const suffix = { draft: ", not in use yet", newest: ", not running yet" }[view.kind] ?? "";
  const head = row && (rows
    ? <VersionMenu routineId={id} rows={rows} shown={row} inUseId={inUseId} suffix={suffix} />
    : <span className="eos-bp-card__version">Version {row.number}{suffix}</span>);

  return (
    <div className="eos-bp">
      <ArchitectChat routineId={id} draft={draft} said={said[id]} note={notes[id]} making={detail.routine.state === "draft"} />
      <div className="eos-bp__side">
        <Note note={notes[id]} />
        {newer && <p className="eos-note">A newer version of Eos made this blueprint. It can be read here, not changed or run.</p>}
        {!version && (view.versionId || (old && !rows)) && <Loading blocks={4} />}
        {!view.versionId && (!old || rows) && <p className="eos-note">{old ? "This routine has no such version." : "This routine has no blueprint yet."}</p>}
        {version && (
          <BlueprintCard blueprint={version.blueprint} onEdit={onEdit} changed={changed} routines={list} head={head} routineId={id}>
            {old && (
              <OldActions
                id={id}
                versionId={view.versionId}
                inUse={Boolean(inUse)}
                restorable={view.versionId !== inUseId && !newer}
                comparing={comparing}
                setComparing={setComparing}
              />
            )}
            {!old && !newer && <Actions id={id} kind={view.kind} trials={trials} routine={detail.routine} blueprint={version.blueprint} />}
          </BlueprintCard>
        )}
        {old && comparing && version && inUse && <VersionCompare version={version.blueprint} current={inUse.blueprint} routines={list} />}
        {!old && <TrialCards runs={trials} now={Date.now()} />}
      </div>
    </div>
  );
}
