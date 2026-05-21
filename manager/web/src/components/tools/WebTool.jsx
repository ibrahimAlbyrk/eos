import { memo, useMemo } from "react";
import { stripMcpPrefix } from "../../lib/format.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { ToolShell } from "./ToolShell.jsx";
import { resultStatus } from "./shared.js";

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

export const WebTool = memo(function WebTool({ tool, result, family }) {
  const base = stripMcpPrefix(tool.tool);
  const status = resultStatus(result);

  if (base === "WebFetch") {
    const url = tool.input?.url || "";
    const prompt = tool.input?.prompt || "";
    const body = (result?.body || "").trim();
    const html = useMemo(() => renderMarkdown(body), [body]);
    const host = hostOf(url);

    return (
      <ToolShell
        family={family}
        icon="globe"
        title={
          <span className="vb-tool__name">
            <span className="vb-tool__verb">WebFetch</span>
            {host && (
              <a
                className="vb-web__hostpill"
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="vb-web__hostpill-icon">⏵</span>
                <span>{host}</span>
              </a>
            )}
          </span>
        }
        subtitle={prompt && (
          <span className="vb-web__quoted">
            <span className="vb-web__quote-mark">❝</span> {prompt} <span className="vb-web__quote-mark">❞</span>
          </span>
        )}
        status={status}
        defaultOpen={false}
        body={
          body ? (
            <div className="vb-toolbody vb-toolbody--web">
              <div className="vb-web__resp vb-md" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          ) : null
        }
      />
    );
  }

  // WebSearch
  const query = tool.input?.query || "";
  const allowed = tool.input?.allowed_domains;
  const blocked = tool.input?.blocked_domains;
  const body = (result?.body || "").trim();
  // Pull URL lines out as results; the rest renders as markdown context.
  const results = useMemo(() => {
    const matches = [...body.matchAll(/https?:\/\/\S+/g)].map(m => m[0]);
    // Dedupe
    return Array.from(new Set(matches)).slice(0, 12);
  }, [body]);

  const subtitle = (
    <span className="vb-tool__sub-grp">
      {results.length > 0 && <span>{results.length} results</span>}
      {allowed?.length > 0 && (
        <><span className="vb-tool__sub-sep">·</span><span>allow: {allowed.join(", ")}</span></>
      )}
      {blocked?.length > 0 && (
        <><span className="vb-tool__sub-sep">·</span><span>block: {blocked.join(", ")}</span></>
      )}
    </span>
  );

  const bodyEl = body ? (
    <div className="vb-toolbody vb-toolbody--web">
      {results.length > 0 ? (
        <ol className="vb-web__results">
          {results.map((u, i) => (
            <li key={i}>
              <a href={u} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                <span className="vb-web__results-host">{hostOf(u)}</span>
                <span className="vb-web__results-path">{u.replace(/^https?:\/\/[^/]+/, "")}</span>
              </a>
            </li>
          ))}
        </ol>
      ) : (
        <div className="vb-web__resp vb-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
      )}
    </div>
  ) : null;

  return (
    <ToolShell
      family={family}
      icon="globe"
      title={
        <span className="vb-tool__name">
          <span className="vb-tool__verb">WebSearch</span>
          <span className="vb-tool__arr">›</span>
          <span className="vb-web__query">"{query}"</span>
        </span>
      }
      subtitle={subtitle}
      status={status}
      body={bodyEl}
    />
  );
});
