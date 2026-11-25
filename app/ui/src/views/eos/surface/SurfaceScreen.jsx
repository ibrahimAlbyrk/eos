import { useEffect, useState } from "react";
import { notify } from "../../../lib/notify.js";
import { loadIssue, loadPage, loadVersion, pickIssue, reshape, sendFeedback, usePages } from "../../../state/eos/pageStore.js";
import { ensurePinsLoaded } from "../../../state/eos/pinsStore.js";
import { ensureRoutinesLoaded, useRoutines } from "../../../state/eos/routinesStore.js";
import { useDevRunSeen } from "../../../state/eos/transport.js";
import { DevRunNote, Loading, LoadFailed } from "../capabilities/parts.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { PageDataEditor } from "../needs/editors/PageDataEditor.jsx";
import { EarlierIssues } from "./EarlierIssues.jsx";
import { IssueBody } from "./IssueBody.jsx";
import { PinButton } from "./PinButton.jsx";
import { ReshapeMode } from "./ReshapeMode.jsx";
import { ShareMenu } from "./ShareMenu.jsx";
import { TellBar } from "./TellBar.jsx";
import { AppSurface } from "./AppSurface.jsx";
import { issueLine, olderDesignLine, PAGE_NOTE, todayDesignLine } from "./words.js";

// "Good issue" and "Not today": said once per issue.
function Verdict({ issueId }) {
  const [said, setSaid] = useState(null);
  useEffect(() => setSaid(null), [issueId]);
  const say = async (verdict) => {
    const r = await sendFeedback(issueId, verdict);
    if (r.ok) setSaid(verdict);
    else notify.error(r.error, { title: "Eos did not hear that" });
  };
  if (said) return <span className="eos-page__said" role="status">{said === "good" ? "Noted: a good issue." : "Noted: not today."}</span>;
  return (
    <>
      <button type="button" className="eos-btn eos-btn--pill" onClick={() => void say("good")}>Good issue</button>
      <button type="button" className="eos-btn eos-btn--quiet" onClick={() => void say("not_today")}>Not today</button>
    </>
  );
}

// eos:/surfaces/<id>?issue=<n>&mode=reshape&button=&index= — a routine's Page: the issue in
// Eos's dark frame as a light sheet, earlier issues in the design each was
// made with, pin to Home, mail preview and a file to share, how the issue
// was, and what to change about the page; in reshape mode, changing it by
// saying or pointing.
export function SurfaceScreen({ surfaceId, seq, mode, linked }) {
  const { pages, issues, versions } = usePages();
  const { list: routines } = useRoutines();
  const devRun = useDevRunSeen();
  const [todayDesign, setTodayDesign] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    ensureRoutinesLoaded();
    ensurePinsLoaded();
    void loadPage(surfaceId);
  }, [surfaceId]);

  const page = pages[surfaceId];
  const surface = page?.surface;
  const row = pickIssue(page?.issues, seq);
  useEffect(() => {
    setTodayDesign(false);
    setEditing(false);
    if (row) void loadIssue(surfaceId, row.id);
    // A new revision of the same issue reads it again; nothing else does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceId, row?.id, row?.rev]);
  useEffect(() => {
    if (surface?.currentVersion != null) void loadVersion(surfaceId, surface.currentVersion);
  }, [surfaceId, surface?.currentVersion]);

  const routine = routines?.find((r) => r.id === surface?.routineId);
  const maker = routine?.name ?? surface?.title;
  const title = surface?.title ?? "Page";
  const older = row?.version != null && surface?.currentVersion != null && row.version !== surface.currentVersion;
  const tell = async (instruction) => {
    const r = await reshape(surfaceId, { baseVersion: surface.currentVersion, instruction });
    if (!r.ok) return r;
    openLocation(buildLocation({ screen: "surface", surfaceId, mode: "reshape" }));
    return r;
  };
  const reshaping = mode === "reshape" && surface?.currentVersion != null;
  const current = surface?.currentVersion != null ? versions[`${surfaceId}:${surface.currentVersion}`] : null;

  // An App opened as a tool: the whole window is the App.
  if (surface?.level === "app") {
    return (
      <main className="eos-screen">
        <EosHeader trail={[{ label: "Eos", location: "eos:/" }, { label: title }]} />
        <div className="eos-body eos-page">
          {devRun && <DevRunNote />}
          <AppSurface surfaceId={surfaceId} />
        </div>
      </main>
    );
  }

  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Eos", location: "eos:/" }, { label: title }]} mark={reshaping && <span className="eos-chip eos-chip--accent">Changing the page</span>}>
        {reshaping && (
          <button type="button" className="eos-btn" onClick={() => openLocation(buildLocation({ screen: "surface", surfaceId, issue: seq }))}>Done</button>
        )}
        {!reshaping && row && <span className="eos-page__line">{issueLine(row)}</span>}
        {!reshaping && surface && (
          <>
            <EarlierIssues page={page} row={row} />
            <PinButton surface={surface} />
            {surface.currentVersion != null && (
              <button type="button" className="eos-btn" onClick={() => openLocation(buildLocation({ screen: "surface", surfaceId, issue: seq, mode: "reshape" }))}>
                Change the page
              </button>
            )}
            {row?.kind === "page" && issues[row.id]?.body?.data && (
              <button type="button" className="eos-btn eos-btn--quiet" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>Edit</button>
            )}
            {row?.kind === "page" && <ShareMenu surface={surface} row={row} />}
          </>
        )}
      </EosHeader>
      <div className="eos-body eos-page">
        {devRun && <DevRunNote />}
        {page?.failed === "gone" && <p className="eos-note">This page is no longer here.</p>}
        {page?.failed === "error" && <LoadFailed what="this page" retry={() => void loadPage(surfaceId)} />}
        {!page && <Loading blocks={4} />}
        {surface && reshaping && (
          <div className="eos-page__column eos-reshape">
            <ReshapeMode surface={surface} row={row} />
          </div>
        )}
        {surface && !reshaping && (
          <div className="eos-page__column">
            {surface.needsRedesign && (
              <div className="eos-band eos-band--warn" role="status">
                <span className="eos-band__text">Its last issues did not fit the layout, so they came as plain cards. The page needs a new design.</span>
                <button type="button" className="eos-btn" onClick={() => openLocation(buildLocation({ screen: "surface", surfaceId, mode: "reshape" }))}>Change the page</button>
              </div>
            )}
            {older && (
              <div className="eos-page__older" role="status">
                <span>{todayDesign ? todayDesignLine(row, surface.currentVersion) : olderDesignLine(row)}</span>
                {issues[row.id]?.fitsCurrent === true && (
                  <button type="button" className="eos-btn eos-btn--quiet" onClick={() => setTodayDesign((t) => !t)}>
                    {todayDesign ? "Show in its own design" : "Show in today's design"}
                  </button>
                )}
              </div>
            )}
            {!row && page.issues && (
              <p className="eos-note">No issue yet. The first one comes with the routine's next run.</p>
            )}
            {row && (
              <IssueBody
                key={row.id}
                linked={linked}
                surface={surface}
                row={row}
                shown={issues[row.id]}
                maker={maker}
                version={todayDesign ? surface.currentVersion : undefined}
              />
            )}
            {editing && issues[row.id]?.issue && (
              <section className="eos-card eos-page__edit" aria-label="Edit this issue">
                <PageDataEditor key={row.id} surfaceId={surfaceId} issue={issues[row.id].issue} data={issues[row.id].body.data} />
              </section>
            )}
            {current?.meta?.note && <p className="eos-page__design-note"><span className="eos-label">Design note</span> {current.meta.note}</p>}
            {surface.currentVersion != null && (
              <div className="eos-page__below">
                <TellBar label="Tell Eos what to change about this page" onSend={tell} />
                {row && !row.trial && row.status === "ready" && <Verdict issueId={row.id} />}
              </div>
            )}
            {surface.currentVersion != null && <p className="eos-page__note">{PAGE_NOTE}</p>}
          </div>
        )}
      </div>
    </main>
  );
}
