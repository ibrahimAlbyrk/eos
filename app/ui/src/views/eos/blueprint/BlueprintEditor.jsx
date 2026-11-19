import { useEffect } from "react";
import {
  discardDraft, loadDraft, loadVersion, loadVersions, runTrial, saveBlueprint, startRoutine, useBlueprints,
} from "../../../state/eos/blueprintStore.js";
import { useRoutines } from "../../../state/eos/routinesStore.js";
import { Loading } from "../capabilities/parts.jsx";
import { ArchitectChat } from "./ArchitectChat.jsx";
import { BlueprintCard } from "./BlueprintCard.jsx";
import { TrialCards } from "./TrialCards.jsx";
import { costLine, issueLine } from "./words.js";

// Which version the card shows, by what the routine is doing:
// - "newest": a routine being made shows its newest version, which a hand
//   edit and Start build on;
// - "draft": an architect's change of a running routine, not in use yet;
// - "head": the version in use, which a hand edit builds on.
export function shownVersion(detail, draft, rows) {
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
  if (!note || note.kind === "crowded") return null;
  const tone = note.kind === "warnings" ? "eos-band--warn" : "eos-band--err";
  return (
    <div className={`eos-band ${tone}`} role="alert">
      <span className="eos-band__text">{note.text}</span>
      {note.issues?.length > 0 && <ul className="eos-bp-issues">{note.issues.map((i) => <li key={issueLine(i)}>{issueLine(i)}</li>)}</ul>}
    </div>
  );
}

function Actions({ id, kind, draft, routine, blueprint }) {
  const tried = (draft?.trialRuns.length ?? 0) > 0;
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
      <span className="eos-bp-actions__cost">{costLine(routine, blueprint)}</span>
    </div>
  );
}

// The Blueprint tab: the architect conversation beside the blueprint card,
// the draft's trial cards under it. A hand edit keeps a new version at
// once from the version shown; the editor never keeps an architect's
// version by itself: Start and Use this version are the user's.
export function BlueprintEditor({ detail }) {
  const id = detail.routine.id;
  const { drafts, versions, blueprints, said, notes } = useBlueprints();
  const { list } = useRoutines();
  useEffect(() => {
    void loadDraft(id);
    void loadVersions(id);
  }, [id]);

  const draft = drafts[id];
  const rows = versions[id];
  const view = shownVersion(detail, draft, rows);
  const fromHead = view.versionId === detail.head?.id;
  useEffect(() => {
    if (view.versionId && !fromHead) void loadVersion(id, view.versionId);
  }, [id, view.versionId, fromHead]);

  const version = fromHead ? detail.head : blueprints[view.versionId];
  const row = rows?.find((r) => r.id === view.versionId) ?? version;
  const newer = version?.runnable === false;
  const editable = view.kind !== "draft" && !newer;
  const onEdit = editable ? (next) => void saveBlueprint(id, view.versionId, next) : undefined;
  const changed = view.kind === "draft" ? draft.changed : [];
  const head = row && (
    <span className="eos-bp-card__version">
      Version {row.number}
      {view.kind === "draft" && ", not in use yet"}
      {view.kind === "newest" && ", not running yet"}
    </span>
  );

  return (
    <div className="eos-bp">
      <ArchitectChat routineId={id} draft={draft} said={said[id]} note={notes[id]} />
      <div className="eos-bp__side">
        <Note note={notes[id]} />
        {newer && <p className="eos-note">A newer version of Eos made this blueprint. It can be read here, not changed or run.</p>}
        {!version && view.versionId && <Loading blocks={4} />}
        {!view.versionId && <p className="eos-note">This routine has no blueprint yet.</p>}
        {version && (
          <BlueprintCard blueprint={version.blueprint} onEdit={onEdit} changed={changed} routines={list} head={head}>
            {!newer && <Actions id={id} kind={view.kind} draft={draft} routine={detail.routine} blueprint={version.blueprint} />}
          </BlueprintCard>
        )}
        <TrialCards runs={draft?.trialRuns} now={Date.now()} />
      </div>
    </div>
  );
}
