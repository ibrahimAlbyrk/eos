// Page bodies are plain markdown. These are the pure reads and targeted edits
// over them: the list summary (excerpt + checklist counts) and the agent edit
// ops (append / replace / tick a task), which apply to the LATEST body so an
// agent edit never clobbers what the user typed meanwhile. Lines inside fenced
// code blocks are never treated as headings or tasks.

import { ValidationError } from "../errors/index.ts";
import type { PageEditRequest } from "../../../contracts/src/http.ts";

const TASK_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;
const FENCE_RE = /^\s*(```|~~~)/;

// Per line: true when it sits inside (or opens/closes) a fenced code block.
function fencedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const m = line.match(FENCE_RE);
    if (open) {
      out.push(true);
      if (m && m[1] === open) open = null;
    } else if (m) {
      out.push(true);
      open = m[1]!;
    } else {
      out.push(false);
    }
  }
  return out;
}

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

export function pageTaskCounts(body: string): { open: number; done: number } {
  const lines = body.split("\n");
  const fenced = fencedLines(lines);
  let open = 0;
  let done = 0;
  lines.forEach((line, i) => {
    const m = !fenced[i] && line.match(TASK_RE);
    if (!m) return;
    if (m[2] === " ") open += 1;
    else done += 1;
  });
  return { open, done };
}

// The first prose of the page with the markdown markers stripped, for list rows.
export function pageExcerpt(body: string, max = 160): string {
  const lines = body.split("\n");
  const fenced = fencedLines(lines);
  const parts: string[] = [];
  let len = 0;
  for (let i = 0; i < lines.length && len < max; i++) {
    if (fenced[i] || HEADING_RE.test(lines[i]!)) continue;
    const text = lines[i]!
      .replace(/^\s*(?:[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)]|>)\s*/, "")
      .replace(/[*_`~]/g, "")
      .trim();
    if (!text) continue;
    parts.push(text);
    len += text.length + 1;
  }
  const joined = parts.join(" ");
  return joined.length > max ? `${joined.slice(0, max - 1).trimEnd()}…` : joined;
}

export function applyPageEdit(body: string, edit: PageEditRequest): string {
  switch (edit.op) {
    case "append": return appendToPage(body, edit.text, edit.heading);
    case "replace": return replaceInPage(body, edit.oldText, edit.newText);
    case "setTask": return setPageTask(body, edit.task, edit.done);
  }
}

// Two adjacent list items stay one list; anything else gets a blank line between.
function joinBlocks(before: string, text: string): string {
  if (!before.trim()) return text;
  const lastLine = before.slice(before.lastIndexOf("\n") + 1);
  const sep = LIST_ITEM_RE.test(lastLine) && LIST_ITEM_RE.test(text) ? "\n" : "\n\n";
  return before + sep + text;
}

function appendToPage(body: string, rawText: string, heading?: string): string {
  const text = rawText.replace(/^\n+/, "").trimEnd();
  if (!text) throw new ValidationError("nothing to append");
  if (!heading) return `${joinBlocks(body.trimEnd(), text)}\n`;

  const lines = body.split("\n");
  const fenced = fencedLines(lines);
  const target = norm(heading.replace(/^#+\s*/, ""));
  const at = lines.findIndex((l, i) => !fenced[i] && norm(l.match(HEADING_RE)?.[2] ?? "\0") === target);
  if (at === -1) return `${joinBlocks(body.trimEnd(), `## ${heading.replace(/^#+\s*/, "").trim()}`)}\n\n${text}\n`;

  // The section runs to the next heading of the same or a higher level.
  const level = lines[at]!.match(HEADING_RE)![1]!.length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const m = !fenced[i] && lines[i]!.match(HEADING_RE);
    if (m && m[1]!.length <= level) { end = i; break; }
  }
  const section = lines.slice(0, end).join("\n").trimEnd();
  const rest = lines.slice(end).join("\n").replace(/^\n+/, "");
  const merged = joinBlocks(section, text);
  return rest ? `${merged}\n\n${rest.trimEnd()}\n` : `${merged}\n`;
}

function replaceInPage(body: string, oldText: string, newText: string): string {
  const first = body.indexOf(oldText);
  if (first === -1) throw new ValidationError("old text was not found on the page — read the page again and copy the passage exactly");
  let count = 0;
  for (let i = first; i !== -1; i = body.indexOf(oldText, i + oldText.length)) count += 1;
  if (count > 1) throw new ValidationError(`old text appears ${count} times — include more of the surrounding text so it matches once`);
  return body.slice(0, first) + newText + body.slice(first + oldText.length);
}

function setPageTask(body: string, task: string, done: boolean): string {
  const lines = body.split("\n");
  const fenced = fencedLines(lines);
  const want = norm(task.replace(/^\s*[-*+]\s+\[[ xX]\]\s*/, ""));
  const items: Array<{ i: number; text: string }> = [];
  lines.forEach((line, i) => {
    const m = !fenced[i] && line.match(TASK_RE);
    if (m) items.push({ i, text: m[4]! });
  });
  const exact = items.filter((t) => norm(t.text) === want);
  const hits = exact.length ? exact : items.filter((t) => norm(t.text).includes(want));
  if (hits.length === 0) throw new ValidationError(`no checklist item matches "${task}"`);
  if (hits.length > 1) {
    const names = hits.slice(0, 5).map((t) => `"${t.text.trim()}"`).join(", ");
    throw new ValidationError(`"${task}" matches ${hits.length} checklist items (${names}) — use the item's full text`);
  }
  const { i } = hits[0]!;
  lines[i] = lines[i]!.replace(TASK_RE, (_m, pre: string, _mark: string, mid: string, rest: string) => `${pre}${done ? "x" : " "}${mid}${rest}`);
  return lines.join("\n");
}
