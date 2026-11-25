import { useState } from "react";
import { api } from "../../../api/client.js";
import { ROUTES } from "../../../api/routes.js";
import { notify } from "../../../lib/notify.js";
import { refreshInbox } from "../../../state/eos/inboxStore.js";
import { loadIssue } from "../../../state/eos/pageStore.js";
import { pressId, runSurfaceAction } from "../../../state/eos/surfacesStore.js";
import { transport } from "../../../state/eos/transport.js";
import { Loading, LoadFailed } from "../capabilities/parts.jsx";
import { ConfirmBelow, SurfaceCard, ViewAside } from "../needs/SurfaceCard.jsx";
import { EosFrame } from "./EosFrame.jsx";
import { PageRenderer } from "./PageRenderer.jsx";
import { useLiveParts } from "./useLiveParts.js";
import { issueLine } from "./words.js";

// What the core answered a press on the page, said outside the frame.
function settle(press, answer, setAsking) {
  switch (answer.status) {
    case "done": return;
    case "confirm":
      setAsking({ press, token: answer.token, prompt: answer.prompt, typeToConfirm: answer.typeToConfirm });
      return;
    case "held":
      notify.info("It waits in Needs you for you to send.");
      void refreshInbox();
      return;
    default:
      notify.error(answer.reason, { title: "That did not run" });
  }
}

// A button an `eos://issue` link named: it is pressed only once the user
// confirms it here (07 §4.3).
function linkedAsk(linked) {
  if (!linked?.button) return null;
  const press = { button: linked.button, ...(linked.index != null ? { index: linked.index } : {}) };
  return { linked: press, prompt: `A link asks to press “${linked.button}” on this issue. Press it?` };
}

// A button pressed inside the page: the core reads the action and its
// arguments from the issue's own design; Eos asks first below the frame.
function usePagePress(issueId, linked) {
  const [asking, setAsking] = useState(() => linkedAsk(linked));
  const [typed, setTyped] = useState("");
  const ask = (next) => {
    setTyped("");
    setAsking(next);
  };
  const act = async (message) => {
    const press = { issueId, button: message.button, clientId: pressId(), ...(message.index != null ? { index: message.index } : {}) };
    settle(press, await runSurfaceAction(press), ask);
  };
  const confirm = async () => {
    const { press, token, typeToConfirm, linked: pressLinked } = asking;
    ask(null);
    if (pressLinked) return act(pressLinked);
    settle(press, await runSurfaceAction({ ...press, confirm: token, ...(typeToConfirm ? { typed } : {}) }), ask);
  };
  const below = asking && (
    <ConfirmBelow asking={asking} typed={typed} onType={setTyped} onConfirm={() => void confirm()} onCancel={() => ask(null)} />
  );
  return { act, below };
}

// The parts the reader opened, for memory (ids and indexes only).
function reportRead(surfaceId, issueId, message) {
  const strip = (list) => (Array.isArray(list) ? list.map(({ part, index }) => ({ part, index: index ?? null })) : []);
  void transport.send("POST", ROUTES.surfaceIssueRead(surfaceId, issueId), { parts: strip(message.parts), links: strip(message.links) });
}

// The issue as it reads: the page in its frame, or a View when the issue fell
// back to one or plain reading is on.
export function IssueBody({ surface, row, shown, maker, version, linked }) {
  const { act, below } = usePagePress(row.id, linked);
  const { swaps, onLive } = useLiveParts(surface.id, row.id);
  if (!shown) return <Loading blocks={4} />;
  if (shown.failed) return <LoadFailed what="this issue" retry={() => void loadIssue(surface.id, row.id)} />;
  const view = row.kind === "view" ? shown.body?.view : shown.body?.plain;
  if (view) {
    const card = <SurfaceCard card={{ issue: shown.issue, body: { ...shown.body, view } }} routineName={maker} />;
    if (!shown.body?.aside?.length) return card;
    return (
      <div className="eos-needs-item__columns">
        <div className="eos-needs-item__main">{card}</div>
        <aside className="eos-needs-aside" aria-label="About this view"><ViewAside notes={shown.body.aside} /></aside>
      </div>
    );
  }
  return (
    <EosFrame maker={maker} level="page" below={below} detail={issueLine(row)}>
      <PageRenderer
        src={api.surfacePageUrl(surface.id, row.id, version)}
        title={surface.title}
        target={{ surfaceId: surface.id, issue: row }}
        swaps={swaps}
        onLive={onLive}
        onAct={(m) => void act(m)}
        onRead={(m) => reportRead(surface.id, row.id, m)}
      />
    </EosFrame>
  );
}
