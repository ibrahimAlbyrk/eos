import { useUi } from "../../state/ui.jsx";
import { useHoverCard } from "../../hooks/useHoverCard.js";
import { artifactTabId } from "../../lib/panelTabs.js";
import { artifactBridge, openArtifactExternally } from "../../state/artifactViewStore.js";
import { ArtifactPeek } from "./ArtifactPeek.jsx";

// Every artifact link — the Artifact tool row's card, prose chips, Environment
// rows, the Artifacts list — is an <a data-art-slug href=claude.ai…>.
export const ARTIFACT_LINK = "a[data-art-slug]";
const HOVER_INTENT_MS = 120;

export function readArtifactLink(el) {
  return {
    slug: el.dataset.artSlug,
    url: el.getAttribute("href"),
    title: el.dataset.title || null,
    loginId: el.dataset.loginId || null,
  };
}

// Open (or focus) the artifact's own tab in this pane's side panel. The data
// seeds the tab until the catalog knows the artifact.
export function openArtifactTab(ui, { slug, title, loginId, url }) {
  ui.openPanel(artifactTabId(slug), { title, loginId, url });
}

// Clicks and hovers on every artifact link under the element the handlers go
// on. Click opens the tab, ⌥-click claude.ai in the browser; hover peeks at the
// live page. Without the Electron bridge a click stays a plain link and there
// is no peek. Click listens in the capture phase so it never also opens a
// message's action bar or toggles a row.
export function useArtifactLinks() {
  const ui = useUi();
  const card = useHoverCard({ openMs: HOVER_INTENT_MS });

  const linkOf = (e) => e.target.closest?.(ARTIFACT_LINK);
  const crossing = (el, e) => el && !el.contains(e.relatedTarget);

  const onClickCapture = (e) => {
    const el = linkOf(e);
    if (!el || e.defaultPrevented) return;
    const link = readArtifactLink(el);
    if (e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      card.close();
      openArtifactExternally(link.url);
      return;
    }
    if (!artifactBridge()) return;
    e.preventDefault();
    e.stopPropagation();
    card.close();
    openArtifactTab(ui, link);
  };

  const onMouseOver = (e) => {
    if (!artifactBridge()) return;
    const el = linkOf(e);
    if (!crossing(el, e)) return;
    const panel = el.closest(".side-panel");
    card.enterAnchor(el, { ...readArtifactLink(el), panelLeft: panel ? panel.getBoundingClientRect().left : null });
  };
  const onMouseOut = (e) => {
    if (crossing(linkOf(e), e)) card.leave();
  };

  const layer = card.anchor && (
    <ArtifactPeek
      anchor={card.anchor}
      link={card.payload}
      onEnter={card.enterCard}
      onLeave={card.leave}
      onClose={card.close}
      onOpen={(link) => { card.close(); openArtifactTab(ui, link); }}
    />
  );
  return { handlers: { onClickCapture, onMouseOver, onMouseOut }, layer };
}
