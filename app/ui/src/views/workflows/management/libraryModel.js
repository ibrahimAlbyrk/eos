// Pure, DOM-free logic for the workflow Library view: how a definition record maps
// to its provenance rights (read-only / deletable / editable), how a definition is
// matched to its latest run, and how a duplicate is named. Kept free of React so it
// unit-tests in the repo's node test environment, like graphModel.
//
// Provenance rule (the source of the read-only contract): only RUNTIME defs (the
// editor's own PUT saves) are editable-to-save and deletable. builtin/user/project
// are read-only — builtins are code (DELETE 400), file defs are owned on disk
// (DELETE 404). This mirrors the daemon's DeleteWorkflowDefinition.
//
// Editor format: the node editor authors V2 GRAPHS (version === 2). Builtins ship
// as v1 trees (no version), which the v2 editor can't represent — so Edit/Duplicate
// (which open the editor) are gated on isGraphDefinition, while the read-only /
// deletable rule is purely provenance-based.

const WORKFLOW_GRAPH_VERSION = 2;

export function isGraphDefinition(record) {
  return record?.version === WORKFLOW_GRAPH_VERSION;
}

export function provenanceOf(record) {
  return record?.source || "runtime";
}

// builtin/user/project are read-only; only the editor's own runtime saves are not.
export function isReadOnly(record) {
  return provenanceOf(record) !== "runtime";
}

// Deletable iff runtime — matches the daemon: builtins 400, file/unknown 404.
export function isDeletable(record) {
  return provenanceOf(record) === "runtime";
}

// Edit (load into the editor as an editable def): a runtime graph. A read-only graph
// def still gets Duplicate, not Edit.
export function canEdit(record) {
  return isGraphDefinition(record) && isDeletable(record);
}

// Duplicate (open an editable copy): any GRAPH def, regardless of provenance — the
// copy becomes a fresh runtime def on Save. v1 trees can't be opened in the v2
// editor, so they offer no Duplicate.
export function canDuplicate(record) {
  return isGraphDefinition(record);
}

// The latest run for a definition: runs whose definitionName matches the record's
// name, most-recently-updated first. Null when the definition has never run.
export function latestRunFor(name, runs) {
  if (name == null) return null; // definitions always have a name; never match inline (null-name) runs
  let latest = null;
  for (const run of runs || []) {
    if (run?.definitionName !== name) continue;
    const t = run.updatedAt ?? run.startedAt ?? 0;
    const best = latest ? (latest.updatedAt ?? latest.startedAt ?? 0) : -Infinity;
    if (!latest || t >= best) latest = run;
  }
  return latest;
}

// A unique "<name>-copy" (then "-copy-2", "-copy-3", …) not already taken by an
// existing definition name. Deterministic — no Date.now/Math.random.
export function duplicateName(name, existingNames) {
  const taken = new Set(existingNames || []);
  const base = `${name}-copy`;
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

// Strip the provenance tag back to a bare graph doc the editor's graphFromDoc reads.
export function recordToDoc(record) {
  const { source: _source, ...doc } = record || {};
  return doc;
}

// A duplicate doc: the record's graph with a fresh unique name. The new def is
// runtime-owned by virtue of being PUT-saved (operator owner) from the editor.
export function duplicateDoc(record, existingNames) {
  return { ...recordToDoc(record), name: duplicateName(record?.name, existingNames) };
}
