import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useTemplates, refreshTemplates } from "../../../hooks/useTemplates.js";
import { api } from "../../../api/client.js";
import { TemplateEditorModal } from "./TemplateEditorModal.jsx";

function TemplateIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z" />
      <path d="M9.5 1.5V4.5h3" />
      <path d="M6 8.5h4M6 11h2.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m11.5 2.5 2 2L5 13l-2.7.7L3 11l8.5-8.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4.5h11M5.5 4.5v-2h5v2M4 4.5l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-9" />
    </svg>
  );
}

export function TemplatePickerPopover() {
  const ui = useUi();
  const open = ui.openPopover === "templates";
  const templates = useTemplates();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState(null);   // null | {template: null|Template}
  const [confirmDel, setConfirmDel] = useState(null);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    setConfirmDel(null);
    refreshTemplates();
  }, [open]);

  const shown = filter
    ? templates.filter((t) =>
        t.name.toLowerCase().includes(filter.toLowerCase()) ||
        t.description.toLowerCase().includes(filter.toLowerCase()))
    : templates;

  const use = (t) => {
    ui.closeAllPops();
    ui.updateComposer({ pendingTemplate: { content: t.content, ts: Date.now() } });
  };

  const startEdit = (e, t) => {
    e.stopPropagation();
    ui.closeAllPops();
    setEditing({ template: t });
  };

  const del = async (e, t) => {
    e.stopPropagation();
    if (confirmDel !== t.name) {
      setConfirmDel(t.name);
      return;
    }
    setConfirmDel(null);
    await api.deleteTemplate(t.name);
    await refreshTemplates();
  };

  return (
    <>
      {open && (
        <div className="tpl-popover glass-pop open" data-popover="templates">
          <div className="tpl-head">
            <TemplateIcon />
            <span className="tpl-head-label">Templates</span>
            <span className="tpl-grow"></span>
            <button
              className="tpl-add"
              title="New template"
              onClick={() => { ui.closeAllPops(); setEditing({ template: null }); }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          </div>
          {templates.length > 0 && (
            <input
              className="gap-search"
              autoFocus
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter templates…"
              onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) use(shown[0]); }}
            />
          )}
          <div className="tpl-list">
            {templates.length === 0 && (
              <div className="gap-empty">No templates yet — create one with +</div>
            )}
            {templates.length > 0 && shown.length === 0 && (
              <div className="gap-empty">No matches</div>
            )}
            {shown.map((t) => (
              <div
                key={t.name}
                className="menu-item tpl-row"
                role="button"
                tabIndex={0}
                onClick={() => use(t)}
                onKeyDown={(e) => { if (e.key === "Enter") use(t); }}
                onMouseLeave={() => setConfirmDel(null)}
              >
                <TemplateIcon />
                <span className="tpl-name">{t.name}</span>
                {t.description && <span className="tpl-desc">{t.description}</span>}
                <span className="tpl-grow"></span>
                <span className="tpl-actions">
                  <button className="tpl-act" title="Edit" onClick={(e) => startEdit(e, t)}>
                    <PencilIcon />
                  </button>
                  <button
                    className={"tpl-act tpl-act-del" + (confirmDel === t.name ? " confirm" : "")}
                    title={confirmDel === t.name ? "Click again to delete" : "Delete"}
                    onClick={(e) => del(e, t)}
                  >
                    <TrashIcon />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {editing && (
        <TemplateEditorModal initial={editing.template} onClose={() => setEditing(null)} />
      )}
    </>
  );
}
