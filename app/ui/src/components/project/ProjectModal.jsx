import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/client.js";
import { basename } from "../../lib/path.js";
import { useProjects, saveProject, deleteProject, closeProjectModal } from "../../state/projectsStore.js";
import { ProjectIcon } from "./ProjectIcon.jsx";
import { IconPicker } from "./IconPicker.jsx";

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3l1.2 1.5h5.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    </svg>
  );
}

function FolderAddIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13H3.5A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3h2.3l1.2 1.5h5.5A1.5 1.5 0 0 1 14 6v2M12 10v4M10 12h4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

// Mounted once (App); renders whatever projectsStore.modal asks for.
export function ProjectModalHost() {
  const { modal } = useProjects();
  if (!modal) return null;
  return <ProjectModal modal={modal} />;
}

// Create / edit a project: name + icon, and its source folders. folders[0] is
// the primary — agents run and git is tracked there; the rest are extra
// directories the agent may also work in. modal.path promotes a bare folder
// (an unregistered sidebar group) into a project on save.
function ProjectModal({ modal }) {
  const existing = modal.project ?? null;
  const creating = !existing && !modal.path;
  const [name, setName] = useState(existing?.name ?? (modal.path ? basename(modal.path) : ""));
  const [icon, setIcon] = useState(existing?.icon ?? null);
  const [folders, setFolders] = useState(existing?.folders ?? (modal.path ? [modal.path] : []));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);
  const iconBtnRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (pickerOpen) setPickerOpen(false); else closeProjectModal();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [pickerOpen]);

  const addFolder = async () => {
    try {
      const r = await api.pickDirectory();
      if (!r?.path) return;
      setFolders((prev) => (prev.includes(r.path) ? prev : [...prev, r.path]));
      if (!name.trim()) setName(basename(r.path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const makePrimary = (f) => setFolders((prev) => [f, ...prev.filter((x) => x !== f)]);
  const removeFolder = (f) => setFolders((prev) => prev.filter((x) => x !== f));

  const canSave = name.trim() && folders.length > 0 && !busy;

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      closeProjectModal();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const save = () => canSave && run(async () => {
    const project = await saveProject({
      ...(existing ? { id: existing.id, pinned: existing.pinned } : {}),
      name: name.trim(),
      icon,
      folders,
    });
    modal.onSaved?.(project);
  });

  const remove = () => run(() => deleteProject(existing.id));

  return createPortal(
    <div className="del-confirm-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) closeProjectModal(); }}>
      <div className="proj-modal glass-pop" role="dialog" aria-modal="true">
        <button className="proj-modal__close" title="Close" onClick={closeProjectModal}><CloseIcon /></button>
        <h2 className="proj-modal__title">{creating ? "Create project" : "Edit project"}</h2>

        <div className="proj-modal__name">
          <button ref={iconBtnRef} className="proj-modal__icon-btn" title="Change icon" onClick={() => setPickerOpen((v) => !v)}>
            <ProjectIcon icon={icon} size={15} />
          </button>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } e.stopPropagation(); }}
            placeholder="Project name"
          />
          {pickerOpen && (
            <IconPicker
              value={icon}
              onChange={(next) => { setIcon(next); if (!next || next.kind === "emoji") setPickerOpen(false); }}
              onClose={() => setPickerOpen(false)}
              anchorRef={iconBtnRef}
            />
          )}
        </div>

        <div className="proj-modal__label">Source folders</div>
        {folders.length === 0 ? (
          <div className="proj-modal__empty">
            <span>Add a folder on this computer</span>
            <button className="proj-modal__add-pill" onClick={addFolder}><FolderAddIcon /> Add</button>
          </div>
        ) : (
          <div className="proj-modal__folders">
            {folders.map((f, i) => (
              <div key={f} className="proj-folder" title={f}>
                <FolderIcon />
                <span className="proj-folder__name">{basename(f)}</span>
                {folders.length > 1 && (i === 0
                  ? <span className="proj-folder__badge">Primary</span>
                  : <button className="proj-folder__make" onClick={() => makePrimary(f)}>Make primary</button>)}
                <button className="proj-folder__x" title="Remove folder" onClick={() => removeFolder(f)}><CloseIcon /></button>
              </div>
            ))}
            <button className="proj-folder proj-folder--add" onClick={addFolder}>
              <FolderAddIcon />
              <span className="proj-folder__name">Add folder</span>
            </button>
          </div>
        )}

        {error && <div className="proj-modal__error">{error}</div>}

        <div className="proj-modal__actions">
          {existing && <button className="proj-modal__remove" disabled={busy} onClick={remove}>Remove local project</button>}
          <span className="proj-modal__spacer" />
          <button className="proj-modal__cancel" onClick={closeProjectModal}>Cancel</button>
          <button className="proj-modal__save" disabled={!canSave} onClick={save}>{creating ? "Create project" : "Save"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
