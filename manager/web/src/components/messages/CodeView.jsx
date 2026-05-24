import { useEffect, useMemo, useRef } from "react";
import hljs from "highlight.js/lib/common";
import { extToLang, highlightMatches } from "../../lib/fileUtils.jsx";

export function CodeView({ content, findQuery, currentMatch, matches, activeMatchKey, filePath }) {
  const bodyRef = useRef(null);
  const lines = content.split("\n");
  const lang = extToLang(filePath);

  const highlightedLines = useMemo(() => {
    if (!lang) return null;
    try { return hljs.highlight(content, { language: lang }).value.split("\n"); }
    catch { return null; }
  }, [content, lang]);

  useEffect(() => {
    if (!bodyRef.current || matches.length === 0) return;
    const mark = bodyRef.current.querySelector(".fv-match.current");
    if (mark) mark.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMatchKey, matches.length]);

  return (
    <div className="fv-code" ref={bodyRef}>
      {lines.map((line, i) => (
        <div className="fv-code-line" key={i}>
          <span className="fv-ln">{i + 1}</span>
          {findQuery ? (
            <span className="fv-lc">{highlightMatches(line, findQuery, i, currentMatch, matches, content)}</span>
          ) : highlightedLines ? (
            <span className="fv-lc hljs" dangerouslySetInnerHTML={{ __html: highlightedLines[i] }} />
          ) : (
            <span className="fv-lc">{line}</span>
          )}
        </div>
      ))}
    </div>
  );
}
