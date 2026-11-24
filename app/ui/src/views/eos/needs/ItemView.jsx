import { useEffect } from "react";
import { loadIssue, usePages } from "../../../state/eos/pageStore.js";
import { loadItemView, useSurfaces } from "../../../state/eos/surfacesStore.js";
import { IssueBody } from "../surface/IssueBody.jsx";
import { PageDataEditor } from "./editors/PageDataEditor.jsx";
import { SurfaceCard } from "./SurfaceCard.jsx";

// A page issue a Needs-you item holds: the page in its frame, and its marked
// fields to edit before it goes.
export function PageItem({ surfaceId, issueId, routineName }) {
  const shown = usePages().issues[issueId];
  useEffect(() => { void loadIssue(surfaceId, issueId); }, [surfaceId, issueId]);
  if (!shown?.issue) return null;
  const surface = { id: surfaceId, title: routineName ?? "Page" };
  return (
    <div className="eos-page-item">
      <IssueBody surface={surface} row={shown.issue} shown={shown} maker={routineName} />
      <section className="eos-card eos-page__edit" aria-label="Edit before it goes">
        <PageDataEditor key={issueId} surfaceId={surfaceId} issue={shown.issue} data={shown.body?.data} />
      </section>
    </div>
  );
}

// What a Needs-you item shows of its routine's surface: a View (a card, or a
// question whose press answers its run), or a page issue with its editor.
export function ItemView({ item, routineName }) {
  const card = useSurfaces().byIssue[item.view.issueId];
  useEffect(() => { void loadItemView(item.view); }, [item.view]);
  if (!card) return null;
  if (card.issue.kind === "page") return <PageItem surfaceId={item.view.surfaceId} issueId={item.view.issueId} routineName={routineName} />;
  return <SurfaceCard card={card} routineName={routineName} />;
}
