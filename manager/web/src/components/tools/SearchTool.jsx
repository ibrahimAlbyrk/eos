import { memo, useMemo } from "react";
import { stripMcpPrefix } from "../../lib/format.js";
import { ToolShell, Chips, PathLine } from "./ToolShell.jsx";
import { resultStatus } from "./shared.js";

// Parse Claude's Grep "files_with_matches" or default "content" output. The
// default content mode looks like `path:lineNo:matched_text`; the
// files_with_matches mode is one path per line. We auto-detect.
function parseGrepBody(body, pattern) {
  if (!body) return { kind: "empty", groups: [], files: [] };
  const lines = body.split("\n").filter(Boolean);
  // Detect "found N files" header
  const headerIdx = lines.findIndex(l => /^Found \d+ (file|matches?)/i.test(l));
  const payload = headerIdx >= 0 ? lines.slice(headerIdx + 1) : lines;

  // If every line is just a path → files_with_matches mode
  const looksPathOnly = payload.every(l => !/:\d+:/.test(l));
  if (looksPathOnly) {
    return { kind: "files", groups: [], files: payload.slice(0, 60), totalFiles: payload.length };
  }

  // Otherwise group by file.
  const groups = new Map();
  for (const raw of payload) {
    const m = /^(.+?):(\d+):(.*)$/.exec(raw);
    if (!m) continue;
    const [, path, lineNo, text] = m;
    if (!groups.has(path)) groups.set(path, []);
    groups.get(path).push({ lineNo: Number(lineNo), text });
  }
  const groupList = Array.from(groups.entries()).map(([path, matches]) => ({ path, matches }));
  return { kind: "matches", groups: groupList, files: [], totalFiles: groupList.length };
}

function highlightMatch(text, needle) {
  if (!needle) return text;
  try {
    const re = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "g");
    const parts = text.split(re);
    return parts.map((p, i) =>
      i % 2 === 1 ? <mark key={i} className="vb-grep__hit">{p}</mark> : <span key={i}>{p}</span>
    );
  } catch {
    return text;
  }
}

export const SearchTool = memo(function SearchTool({ tool, result, family }) {
  const base = stripMcpPrefix(tool.tool);
  const status = resultStatus(result);

  if (base === "Glob") {
    const pattern = tool.input?.pattern || "";
    const path = tool.input?.path || "";
    const body = (result?.body || "").trim();
    const files = useMemo(() => {
      const m = /^Found (\d+)/i.exec(body);
      const lines = body.split("\n").filter(Boolean);
      const list = m ? lines.slice(1) : lines;
      return list.slice(0, 80);
    }, [body]);
    const total = useMemo(() => {
      const m = /^Found (\d+)/i.exec(body);
      return m ? Number(m[1]) : files.length;
    }, [body, files.length]);

    const subtitle = (
      <span className="vb-tool__sub-grp">
        {path && <span>in <PathLine path={path} /></span>}
        {path && <span className="vb-tool__sub-sep">·</span>}
        <span>{total} {total === 1 ? "file" : "files"}</span>
      </span>
    );

    const bodyEl = (
      <div className="vb-toolbody vb-toolbody--glob">
        <ol className="vb-glob__list">
          {files.map((f, i) => <li key={i}><PathLine path={f} /></li>)}
          {total > files.length && <li className="vb-glob__more">… {total - files.length} more</li>}
        </ol>
      </div>
    );

    return (
      <ToolShell
        family={family}
        icon="grep"
        title={
          <span className="vb-tool__name">
            <span className="vb-tool__verb">Glob</span>
            <span className="vb-tool__arr">›</span>
            <code className="vb-grep__pattern">{pattern}</code>
          </span>
        }
        subtitle={subtitle}
        status={status}
        body={bodyEl}
      />
    );
  }

  // Grep
  const pattern = tool.input?.pattern || "";
  const path = tool.input?.path || "";
  const glob = tool.input?.glob || "";
  const type = tool.input?.type || "";
  const outputMode = tool.input?.output_mode || "";
  const ci = tool.input?.["-i"];
  const parsed = useMemo(() => parseGrepBody((result?.body || "").trim(), pattern), [result, pattern]);

  const totalMatches = parsed.kind === "matches"
    ? parsed.groups.reduce((n, g) => n + g.matches.length, 0)
    : parsed.files.length;

  const subtitle = (
    <span className="vb-tool__sub-grp">
      {path && <span>in <PathLine path={path} /></span>}
      {path && <span className="vb-tool__sub-sep">·</span>}
      <span>{totalMatches} {parsed.kind === "matches" ? "matches" : "files"}</span>
      {parsed.kind === "matches" && parsed.groups.length > 1 && (
        <><span className="vb-tool__sub-sep">·</span><span>{parsed.groups.length} files</span></>
      )}
    </span>
  );

  const chips = (
    <Chips items={[
      glob && { label: "glob", value: glob },
      type && { label: "type", value: type },
      outputMode && { label: "mode", value: outputMode },
      ci && { label: "", value: "case-insensitive", tone: "accent" },
    ].filter(Boolean)} />
  );

  const bodyEl = (
    <div className="vb-toolbody vb-toolbody--grep">
      {chips}
      {parsed.kind === "matches" && (
        <div className="vb-grep__groups">
          {parsed.groups.slice(0, 12).map((g, gi) => (
            <div key={gi} className="vb-grep__group">
              <div className="vb-grep__file">
                <PathLine path={g.path} />
                <span className="vb-grep__count">{g.matches.length}</span>
              </div>
              <div className="vb-grep__matches">
                {g.matches.slice(0, 8).map((m, mi) => (
                  <div key={mi} className="vb-grep__row">
                    <span className="vb-grep__lineno">{m.lineNo}</span>
                    <span className="vb-grep__text">{highlightMatch(m.text, pattern)}</span>
                  </div>
                ))}
                {g.matches.length > 8 && (
                  <div className="vb-grep__more">+ {g.matches.length - 8} more</div>
                )}
              </div>
            </div>
          ))}
          {parsed.groups.length > 12 && (
            <div className="vb-grep__more">+ {parsed.groups.length - 12} more files</div>
          )}
        </div>
      )}
      {parsed.kind === "files" && (
        <ol className="vb-glob__list">
          {parsed.files.map((f, i) => <li key={i}><PathLine path={f} /></li>)}
          {parsed.totalFiles > parsed.files.length && (
            <li className="vb-glob__more">… {parsed.totalFiles - parsed.files.length} more</li>
          )}
        </ol>
      )}
    </div>
  );

  return (
    <ToolShell
      family={family}
      icon="grep"
      title={
        <span className="vb-tool__name">
          <span className="vb-tool__verb">Grep</span>
          <span className="vb-tool__arr">›</span>
          <code className="vb-grep__pattern">{pattern}</code>
        </span>
      }
      subtitle={subtitle}
      status={status}
      body={bodyEl}
    />
  );
});
