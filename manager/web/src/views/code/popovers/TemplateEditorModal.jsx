import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import { refreshTemplates } from "../../../hooks/useTemplates.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Create/edit dialog for prompt templates. `initial` null = create mode;
// rename on edit = create new file + delete old (daemon has no rename).
export function TemplateEditorModal({ initial, onClose }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [content, setContent] = useState(initial?.content ?? "");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Capture phase so Escape doesn't fall through to the app-wide chain
  // (popover close / agent interrupt) while the modal is open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = async () => {
    const slug = name.trim();
    if (!NAME_RE.test(slug)) {
      setError("Name: lowercase letters, digits and dashes (e.g. bug-fix)");
      return;
    }
    if (!content.trim()) {
      setError("Content is required");
      return;
    }
    setBusy(true);
    setError(null);
    const body = { name: slug, description: description.trim(), content: content.trim() };
    let r;
    if (initial && initial.name === slug) {
      r = await api.updateTemplate(slug, body);
    } else {
      r = await api.createTemplate(body);
      if (r.ok && initial) await api.deleteTemplate(initial.name);
    }
    setBusy(false);
    if (!r.ok) {
      setError(r.body?.error ?? `Save failed (${r.status})`);
      return;
    }
    await refreshTemplates();
    onClose();
  };

  return (
    <div className="spawn-overlay open" onMouseDown={onClose}>
      <div className="spawn-modal glass-pop" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="spawn-modal__head">
          <div className="spawn-modal__title">{initial ? "Edit template" : "New template"}</div>
          <button className="spawn-modal__close" title="Close (Esc)" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="spawn-modal__body">
          <div className="spawn-field">
            <label className="spawn-field-label">Name</label>
            <input
              autoFocus={!initial}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="bug-fix"
              spellCheck={false}
            />
          </div>
          <div className="spawn-field">
            <label className="spawn-field-label">Description <span className="optional">optional</span></label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="reproduce & fix a bug"
              spellCheck={false}
            />
          </div>
          <div className="spawn-field">
            <label className="spawn-field-label">Content</label>
            <textarea
              autoFocus={!!initial}
              className="tpl-editor-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={"Fix the bug in {{file}}.\nRepro steps: {{steps}}"}
              spellCheck={false}
            />
            <div className="hint">{"{{label}}"} becomes a tab-stop placeholder after insert</div>
          </div>
          {error && <div className="tpl-editor-error">{error}</div>}
        </div>
        <div className="spawn-modal__foot">
          <button className="spawn-btn" onClick={onClose}>Cancel</button>
          <button className="perm-btn perm-allow" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
