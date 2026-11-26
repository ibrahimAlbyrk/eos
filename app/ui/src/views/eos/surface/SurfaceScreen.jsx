import { useEffect, useState } from "react";
import { loadIssue, loadPage, loadVersion, pickIssue, reshape, usePages } from "../../../state/eos/pageStore.js";
import { ensurePinsLoaded } from "../../../state/eos/pinsStore.js";
import { ensureRoutinesLoaded, useRoutines } from "../../../state/eos/routinesStore.js";
import { useDevRunSeen } from "../../../state/eos/transport.js";
import { DevRunNote } from "../capabilities/parts.jsx";
import { Fact, FailedLead } from "../frame.jsx";
import { EosHeader } from "../nav/EosHeader.jsx";
import { buildLocation, openLocation } from "../nav/eosNav.js";
import { PageDataEditor } from "../needs/editors/PageDataEditor.jsx";
import { EarlierIssues } from "./EarlierIssues.jsx";
import { IssueBody } from "./IssueBody.jsx";
import { PinButton } from "./PinButton.jsx";
import { ReshapeMode } from "./ReshapeMode.jsx";
import { ShareMenu } from "./ShareMenu.jsx";
import { PageEnding } from "./PageEnding.jsx";
import { PageFirst, PageGone, PageLoading } from "./PageStates.jsx";
import { AppActions, AppSurface } from "./AppSurface.jsx";
import { olderDesignLine, todayDesignLine } from "./words.js";

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
      <main className="eos-screen eos-screen--wide">
        <EosHeader trail={[{ label: "Eos", location: "eos:/" }, { label: title }]}>
          <AppActions surfaceId={surfaceId} />
        </EosHeader>
        <div className="eos-body eos-page">
          {devRun && <DevRunNote />}
          <AppSurface surfaceId={surfaceId} />
        </div>
      </main>
    );
  }

  // A page reads as one sheet: the default measure, so the header's words
  // and the sheet share their edges. Above the sheet only what the reader
  // must know first (an older layout, a layout that no longer fits); under
  // it, on a hairline, what to do with this issue and with the layout.
  const shown = row ? issues[row.id] : null;
  const designed = surface?.currentVersion != null;
  const toReshape = () => openLocation(buildLocation({ screen: "surface", surfaceId, issue: seq, mode: "reshape" }));
  return (
    <main className="eos-screen">
      <EosHeader trail={[{ label: "Eos", location: "eos:/" }, { label: title }]} mark={reshaping && <span className="eos-chip eos-chip--accent">Changing the page</span>}>
        {reshaping && (
          <button type="button" className="eos-btn" onClick={() => openLocation(buildLocation({ screen: "surface", surfaceId, issue: seq }))}>Done</button>
        )}
        {!reshaping && surface && (
          <>
            {row?.kind === "page" && <ShareMenu surface={surface} row={row} />}
            <PinButton surface={surface} />
            {designed && !surface.needsRedesign && <button type="button" className="eos-btn" onClick={toReshape}>Change the page</button>}
          </>
        )}
      </EosHeader>
      <div className="eos-body eos-page">
        {devRun && <DevRunNote />}
        {page?.failed === "gone" && <PageGone />}
        {page?.failed === "error" && <FailedLead what="this page" retry={() => void loadPage(surfaceId)} back={{ label: "Back to Home", location: "eos:/" }} />}
        {!page && <PageLoading />}
        {surface && reshaping && (
          <div className="eos-page__column eos-reshape">
            <ReshapeMode surface={surface} row={row} />
          </div>
        )}
        {surface && !reshaping && (
          <div className="eos-page__column">
            {surface.needsRedesign && (
              <Fact tone="warn" role="status" className="eos-page__fact" actions={<button type="button" className="eos-btn" onClick={toReshape}>Change the page</button>}>
                <span>Its last issues did not fit the layout, so they came as plain cards. The page needs a new design.</span>
              </Fact>
            )}
            {older && (
              <Fact role="status" className="eos-page__fact" actions={shown?.fitsCurrent === true && (
                <button type="button" className="eos-btn eos-btn--quiet" onClick={() => setTodayDesign((t) => !t)}>
                  {todayDesign ? "Show in its own design" : "Show in today's design"}
                </button>
              )}>
                <span>{todayDesign ? todayDesignLine(row, surface.currentVersion) : olderDesignLine(row)}</span>
              </Fact>
            )}
            {!row && page.issues && <PageFirst maker={maker} />}
            {row && (
              <IssueBody
                key={row.id}
                linked={linked}
                surface={surface}
                row={row}
                shown={shown}
                maker={maker}
                version={todayDesign ? surface.currentVersion : undefined}
                tools={<EarlierIssues page={page} row={row} />}
              />
            )}
            {(row || designed) && (
              <PageEnding
                row={row}
                verdict={row && !row.trial && row.status === "ready"}
                edit={row?.kind === "page" && shown?.body?.data ? { on: editing, toggle: () => setEditing((e) => !e) } : null}
                version={surface.currentVersion}
                note={current?.meta?.note}
                onTell={designed ? tell : null}
                first={!row}
              />
            )}
            {editing && shown?.issue && (
              <section className="eos-page__edit" aria-labelledby="eos-page-words">
                <div className="eos-section__head">
                  <h2 id="eos-page-words" className="eos-label">Its words</h2>
                  <span className="eos-section__aside">Kept as you leave a field</span>
                </div>
                <PageDataEditor key={row.id} surfaceId={surfaceId} issue={shown.issue} data={shown.body.data} />
              </section>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
