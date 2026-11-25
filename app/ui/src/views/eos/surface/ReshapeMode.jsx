import { useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { notify } from "../../../lib/notify.js";
import { arrange, discardVersion, keepVersion, loadVersion, reshape, stopReshape, usePages, versionKey } from "../../../state/eos/pageStore.js";
import { PageRenderer } from "./PageRenderer.jsx";
import { PointPopover, popoverPlace } from "./PointPopover.jsx";
import { ReshapeBar } from "./ReshapeBar.jsx";
import { TellBar } from "./TellBar.jsx";

// Reshape mode (SurfaceReshape.dc.html): the issue drawn in point mode, the
// part clicked ringed and its popover beside it, the whole-page line below;
// once a new version is there, Before and After with the same issue, Keep
// or Go back.
export function ReshapeMode({ surface, row }) {
  const { versions, design, working } = usePages();
  const [pointed, setPointed] = useState(null);
  const [showing, setShowing] = useState("after");
  const [kept, setKept] = useState(null);
  const [busy, setBusy] = useState(false);
  const holder = useRef(null);
  const id = surface.id;
  const candidateN = surface.candidateVersion;
  const shownDesign = design[id];
  const failedN = shownDesign?.phase === "failed" ? shownDesign.version : null;
  useEffect(() => { void loadVersion(id, candidateN); }, [id, candidateN]);
  useEffect(() => { void loadVersion(id, failedN); }, [id, failedN]);
  useEffect(() => setShowing("after"), [candidateN]);

  const candidate = candidateN != null ? versions[versionKey(id, candidateN)] : null;
  const failed = failedN != null ? versions[versionKey(id, failedN)] : null;
  const open = candidate?.meta.status === "candidate";
  // A change starts from the version on screen: the open candidate, else
  // the one kept.
  const base = open ? candidateN : surface.currentVersion;
  const drawn = open && showing === "after" ? candidateN : surface.currentVersion;

  const done = (r) => {
    setBusy(false);
    if (!r.ok) notify.error(r.error, { title: "The page did not change" });
    else setPointed(null);
  };
  const say = async (instruction, at) => {
    setBusy(true);
    done(await reshape(id, { baseVersion: base, instruction, ...(at ? { part: at.part, index: at.index } : {}) }));
  };
  const move = async (op) => {
    setBusy(true);
    done(await arrange(id, { baseVersion: base, part: pointed.part, op }));
  };
  const keep = async () => {
    const r = await keepVersion(id, candidateN);
    if (r.ok) setKept(candidateN);
    else notify.error(r.error, { title: "Keeping it did not work" });
  };
  const revert = async () => {
    const r = await discardVersion(id, candidateN);
    if (!r.ok) notify.error(r.error, { title: "Going back did not work" });
  };

  const box = holder.current?.getBoundingClientRect();
  const place = pointed ? popoverPlace(pointed.rect, box?.width ?? 1000, box?.height ?? 2000) : null;
  return (
    <>
      <ReshapeBar
        surface={surface}
        candidate={candidate}
        failed={failed}
        design={shownDesign}
        working={working[id]}
        kept={kept}
        showing={showing}
        onShow={setShowing}
        onKeep={() => void keep()}
        onRevert={() => void revert()}
        onStop={() => void stopReshape(id)}
      />
      {row ? (
        <div className="eos-reshape__page" ref={holder}>
          <PageRenderer
            src={api.surfacePageUrl(id, row.id, drawn)}
            title={`${surface.title}, version ${drawn}`}
            mode={showing === "before" && open ? "read" : "point"}
            onPart={(m) => setPointed({ part: m.part, index: m.index ?? null, rect: m.rect })}
            onModeEnd={() => setPointed(null)}
          />
          {pointed && (
            <PointPopover
              pointed={pointed}
              place={place}
              busy={busy}
              onSay={(text) => void say(text, pointed)}
              onArrange={(op) => void move(op)}
              onClose={() => setPointed(null)}
            />
          )}
        </div>
      ) : (
        <div className="eos-page-ghost">
          <span className="eos-page-ghost__mast" aria-hidden="true" />
          <span className="eos-page-ghost__word">No issue to point at yet. Say below what to change; the next issue follows it.</span>
          <span className="eos-page-ghost__cols" aria-hidden="true"><span /><span /><span /></span>
        </div>
      )}
      <div className="eos-reshape__tell">
        <TellBar label="Or say what to change about the whole page" onSend={async (text) => {
          const r = await reshape(id, { baseVersion: base, instruction: text });
          if (!r.ok) return r;
          setPointed(null);
          return r;
        }} />
      </div>
    </>
  );
}
