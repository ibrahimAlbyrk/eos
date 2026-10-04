import { useEffect } from "react";
import {
  useUserMemories, ensureUserMemoriesLoaded, approveMemory, dismissMemory,
} from "../../../state/userMemoryStore.js";
import { useOpenMemory } from "../../../hooks/useOpenMemory.js";
import { CATEGORY_OPTIONS, projectLabel } from "../../../lib/memoryGroups.js";
import { FailureBanner } from "./ToolDetail.jsx";

// Views for the memory tools (both MCP servers). A suggestion is a live card: it
// follows the memory in the store, so the row says whether the user kept it, and
// the card offers Keep / Dismiss right in the chat while it waits. A search reads
// as one line with its hit count and opens to the memories it found. Registered
// in ./toolViews.jsx.

const failed = (t) => t.result?.isError === true;

const SPARK = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /><path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" /></svg>;
const PIN = <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 3h6l-1 6 4 3v2H6v-2l4-3zM12 14v7" /></svg>;
const OPEN = <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 11 11 5M6 5h5v5" /></svg>;

// suggest_memory's text: "Suggested (um-…). …" or "Already known (um-…): "…". …".
export function parseSuggestResult(text) {
  const t = text ?? "";
  const id = /\b(um-[a-z0-9]+)\b/.exec(t)?.[1] ?? null;
  if (t.startsWith("Declined before")) return { id, duplicate: true, declined: true, knownText: null };
  if (t.startsWith("Already known")) return { id, duplicate: true, knownText: /: "([\s\S]*)"\. Nothing to do\.$/.exec(t)?.[1] ?? null };
  if (t.startsWith("Suggested")) return { id, duplicate: false, knownText: null };
  return null;
}

// search_memory's text: one "- [(this project) ]text" line per hit, or "No memories match."
export function parseSearchResult(text) {
  return (text ?? "").split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => {
      const body = l.slice(2);
      const project = body.startsWith("(this project) ");
      return { text: project ? body.slice("(this project) ".length) : body, project };
    });
}

function useMemory(id) {
  const { memories } = useUserMemories();
  useEffect(() => { ensureUserMemoriesLoaded(); }, []);
  if (!id || !memories) return undefined; // unknown yet
  return memories.find((m) => m.id === id) ?? null; // null = gone (dismissed / deleted)
}

// waiting | kept | gone | known | declined — what became of the suggestion.
function suggestionState(tool, memory) {
  const r = parseSuggestResult(tool.result?.text);
  if (!r) return null;
  if (r.declined) return "declined";
  if (r.duplicate) return "known";
  if (memory === undefined) return null;
  if (memory === null || memory.status === "dismissed") return "gone";
  return memory.status === "active" ? "kept" : "waiting";
}

const STATE_LABEL = { waiting: "Waiting for you", kept: "Kept", gone: "Dismissed", known: "Already known", declined: "Declined before" };

function StatusPill({ tool }) {
  const memory = useMemory(parseSuggestResult(tool.result?.text)?.id);
  const state = suggestionState(tool, memory);
  if (!state || failed(tool)) return null;
  return <span className={`mtl-pill mtl-pill--${state}`}>{STATE_LABEL[state]}</span>;
}

const categoryLabel = (c) => CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c;

function SuggestDetail({ tool }) {
  const r = parseSuggestResult(tool.result?.text);
  const memory = useMemory(r?.id);
  const openMemory = useOpenMemory();
  if (failed(tool)) return <div className="tool-detail"><FailureBanner tool={tool} /></div>;
  const state = suggestionState(tool, memory);
  const scope = memory?.scope.kind === "project" ? projectLabel(memory.scope.path)
    : tool.input?.scope === "project" ? "This project" : "All projects";
  const meta = [categoryLabel(tool.input?.category), scope].filter(Boolean).join(" · ");

  return (
    <div className="tool-detail pgc-detail">
      <div className={`web-card pgc mtl-card mtl-card--${state ?? "waiting"}`}>
        <div className="pgc-head">
          <span className="pgc-tile mtl-tile">{SPARK}</span>
          <span className="pgc-titles">
            <span className="pgc-title">{state === "known" ? "Already remembered" : state === "declined" ? "You declined this before" : "Memory suggestion"}</span>
            <span className="pgc-meta">{meta}</span>
          </span>
          <button type="button" className="pgc-open" onClick={openMemory}>{OPEN}Memory</button>
        </div>
        <div className="web-sep" />
        <div className="pgc-body">
          <p className="mtl-quote">{state === "known" && r?.knownText ? r.knownText : (memory?.text ?? tool.input?.text)}</p>
          {tool.input?.why && state !== "known" && state !== "declined" && <p className="mtl-why">{tool.input.why}</p>}
          {state === "waiting" && memory && (
            <div className="mtl-actions">
              <button type="button" className="mem-btn mem-btn--primary" onClick={() => void approveMemory(memory.id)}>Keep</button>
              <button type="button" className="mem-btn mem-btn--ghost" onClick={() => void dismissMemory(memory.id)}>Dismiss</button>
              <span className="mtl-hint">Nothing is remembered until you keep it.</span>
            </div>
          )}
          {state === "kept" && memory && (
            <span className="mtl-outcome mtl-outcome--kept">
              {memory.tier === "always" ? <>{PIN}Kept · in every new agent's prompt</> : "Kept · agents look it up when relevant"}
            </span>
          )}
          {state === "gone" && <span className="mtl-outcome">Dismissed — agents won't be told this.</span>}
        </div>
      </div>
    </div>
  );
}

function SearchDetail({ tool }) {
  if (failed(tool)) return <div className="tool-detail"><FailureBanner tool={tool} /></div>;
  const hits = parseSearchResult(tool.result?.text);
  return (
    <div className="tool-detail ptl-list mtl-list">
      {hits.map((h, i) => (
        <div key={i} className="ptl-row mtl-row">
          {SPARK}
          <span className="mtl-row__text">{h.text}</span>
          {h.project && <span className="mtl-scope">this project</span>}
        </div>
      ))}
    </div>
  );
}

function SearchCount({ tool }) {
  if (tool.running || failed(tool) || !tool.result) return null;
  const n = parseSearchResult(tool.result.text).length;
  return <span className={`mtl-count${n ? "" : " is-none"}`}>{n ? `${n} found` : "nothing found"}</span>;
}

const queryLabel = (t) => (t.input?.query?.trim() ? `“${t.input.query.trim()}”` : "recent memories");
const quoted = (t) => (t.input?.text ? `“${t.input.text}”` : "");

// tool name → view spec (ToolItem contract: label/runningLabel/headerBadge/expandable/Detail).
export const MEMORY_TOOL_VIEWS = {
  search_memory: {
    label: (t) => ({ verb: "Searched memory for", file: queryLabel(t) }),
    runningLabel: (t) => ({ verb: "Searching memory for", file: queryLabel(t) }),
    headerBadge: (t) => <SearchCount tool={t} />,
    expandable: (t) => failed(t) || parseSearchResult(t.result?.text).length > 0,
    Detail: SearchDetail,
  },
  suggest_memory: {
    label: (t) => ({ verb: "Suggested a memory", file: quoted(t) }),
    runningLabel: (t) => ({ verb: "Suggesting a memory", file: quoted(t) }),
    headerBadge: (t) => <StatusPill tool={t} />,
    expandable: (t) => failed(t) || Boolean(t.result),
    Detail: SuggestDetail,
  },
};
