import { navigate, setUrlDraft } from "../../state/browserPanelStore.js";

// Navigation row under the tab strip: back / forward / reload pinned left, the
// address field taking the rest. The field reuses the explorer's .fx-search
// inset-well treatment; submitting posts a BrowserNavigateRequest{action:"url"}
// for the pane's active tab. History reach (canGoBack/canGoForward) is the
// daemon's answer, carried on the tab record.
export function BrowserNavBar({ paneId, tab, urlDraft }) {
  return (
    <div className="browser-nav">
      <button
        className="fv-icon-btn"
        disabled={!tab?.canGoBack}
        title="Back"
        aria-label="Back"
        onClick={() => navigate(paneId, { action: "back" })}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 3 5 8l5 5" />
        </svg>
      </button>
      <button
        className="fv-icon-btn"
        disabled={!tab?.canGoForward}
        title="Forward"
        aria-label="Forward"
        onClick={() => navigate(paneId, { action: "forward" })}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 3 5 5-5 5" />
        </svg>
      </button>
      <button
        className="fv-icon-btn"
        disabled={!tab}
        title="Reload"
        aria-label="Reload"
        onClick={() => navigate(paneId, { action: "reload" })}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 1.5v3h-3" />
        </svg>
      </button>
      <form
        className="fx-search browser-url"
        onSubmit={(e) => { e.preventDefault(); navigate(paneId, { action: "url", url: urlDraft }); }}
      >
        <svg className="fx-search-ic" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <circle cx="8" cy="8" r="6" /><ellipse cx="8" cy="8" rx="2.6" ry="6" /><path d="M2.4 6h11.2M2.4 10h11.2" />
        </svg>
        <input
          className="fx-search-input"
          value={urlDraft}
          placeholder="Enter an address"
          spellCheck={false}
          aria-label="Address"
          onChange={(e) => setUrlDraft(paneId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            setUrlDraft(paneId, tab?.url ?? "");
            e.currentTarget.blur();
          }}
        />
      </form>
    </div>
  );
}
