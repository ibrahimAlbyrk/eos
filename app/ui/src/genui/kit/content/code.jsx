// Code (mono block + copy, highlighted off the main thread) and FileRef (a chip
// that opens the file in the side panel).

import { useEffect, useState } from "react";
import { Icon } from "../icons.jsx";
import { useItem, useView } from "../../runtime/ViewContext.jsx";
import { attrBool, attrNum, attrText } from "../../../../../../contracts/src/genui/attrs.ts";
import { highlightAsync } from "../../../lib/asyncHighlight.js";
import { cls, openHref, textOf, tpl } from "./util.js";

// lang= → a file name the shared highlighter recognizes.
const LANG_EXT = {
  js: "js", javascript: "js", jsx: "jsx", ts: "ts", typescript: "ts", tsx: "tsx", json: "json",
  py: "py", python: "py", sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh",
  css: "css", html: "html", xml: "xml", md: "md", markdown: "md", yaml: "yaml", yml: "yaml",
  sql: "sql", go: "go", rust: "rs", rs: "rs", java: "java", c: "c", cpp: "cpp", "c++": "cpp",
  php: "php", swift: "swift", kotlin: "kt", ruby: "rb", rb: "rb", toml: "toml",
};

function tokensOf(line) {
  return line.map((tok, k) => (tok.c ? <span key={k} className={tok.c}>{tok.t}</span> : tok.t));
}

export function CodeBlock({ code, lang, title, wrap = false }) {
  const [hl, setHl] = useState(null);
  const [copied, setCopied] = useState(false);
  const ext = LANG_EXT[(lang || "").toLowerCase()];
  useEffect(() => {
    setHl(null);
    if (!ext || !code) return undefined;
    let cancelled = false;
    highlightAsync(code, `snippet.${ext}`).then((r) => { if (!cancelled) setHl(r); }, () => {});
    return () => { cancelled = true; };
  }, [code, ext]);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  if (!code) return null;
  const head = title || (lang && lang.toLowerCase() !== "text" ? lang : "");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const lines = code.split("\n");
  return (
    <div className={cls("gv-code", wrap && "is-wrap", head && "has-head")}>
      {head ? <div className="gv-code-head">{head}</div> : null}
      <button type="button" className="gv-code-copy" aria-label={copied ? "Copied" : "Copy code"} title={copied ? "Copied" : "Copy"} onClick={copy}>
        <Icon name={copied ? "check" : "copy"} size={13} stroke={2} />
      </button>
      <pre className="gv-code-pre"><code>
        {lines.map((ln, i) => (
          <span className="gv-code-line" key={i}>
            {hl?.[i] ? tokensOf(hl[i]) : ln}
            {i < lines.length - 1 ? "\n" : null}
          </span>
        ))}
      </code></pre>
    </div>
  );
}

export function Code({ attrs = {}, node, children }) {
  const view = useView();
  const item = useItem();
  const code = attrs.value !== undefined ? tpl(view, attrs.value, item) : textOf(node, children);
  return (
    <CodeBlock
      code={code.replace(/\n+$/, "")}
      lang={attrText(attrs.lang)}
      title={tpl(view, attrs.title, item)}
      wrap={attrBool(attrs.wrap, /^(text|plain|txt|log)$/i.test(attrText(attrs.lang)))}
    />
  );
}

function baseName(p) {
  const s = String(p).replace(/\/+$/, "");
  return s.slice(s.lastIndexOf("/") + 1) || s;
}

export function FileRef({ attrs = {} }) {
  const view = useView();
  const item = useItem();
  const path = tpl(view, attrs.path, item).trim();
  if (!path) return null;
  const line = attrNum(tpl(view, attrs.line, item));
  const where = line != null ? `${path}:${line}` : path;
  return (
    <button
      type="button"
      className="gv-fileref"
      title={where}
      aria-label={`Open ${where}`}
      onClick={(e) => {
        e.stopPropagation();
        openHref(view, path, line != null ? { line } : {});
      }}
    >
      <Icon name="file" size={13} stroke={2} />
      <span>{baseName(path)}{line != null ? `:${line}` : ""}</span>
    </button>
  );
}
