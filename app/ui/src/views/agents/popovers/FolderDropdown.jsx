import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { basename } from "../../../lib/path.js";
import { projectChoices } from "../../../lib/projects.js";
import { useProjects, openProjectModal } from "../../../state/projectsStore.js";
import { ProjectIcon } from "../../../components/project/ProjectIcon.jsx";
import { SearchField } from "./SearchField.jsx";

// Project picker for the next spawn: registered projects, then recent folders no
// project owns. Picking seats ui.composer.cwd to the project's primary folder;
// "New project" opens the create modal and seats the new project on save.
export function FolderDropdown({ live }) {
  const ui = useUi();
  const { projects } = useProjects();
  const [query, setQuery] = useState("");
  const open = ui.openPopover === "folder-dd";

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  if (!open) return null;

  const current = ui.composer.cwd;
  const pick = (path) => {
    ui.updateComposer({ cwd: path });
    ui.closeAllPops();
  };

  const newProject = () => {
    ui.closeAllPops();
    openProjectModal({
      onSaved: (p) => { ui.updateComposer({ cwd: p.folders[0] }); live.refreshRecents(); },
    });
  };

  const q = query.trim().toLowerCase();
  const all = projectChoices(projects, live.recents);
  const choices = q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.path.toLowerCase().includes(q)) : all;

  return (
    <div className="cb-chip-dd ca-pop ca-folder-dd open" id="cbFolderDD" data-popover="folder-dd">
      {all.length > 0 && <SearchField value={query} onChange={setQuery} placeholder="Search projects" />}
      <div className="cb-chip-dd-scroll">
        {choices.length === 0 && (
          <div style={{ padding: "10px 12px", color: "var(--fg-faint)", fontSize: "var(--text-sm)" }}>
            {all.length > 0 ? "No matching projects" : "No projects yet"}
          </div>
        )}
        {choices.map((c) => {
          const on = c.project ? c.project.folders.includes(current) : current === c.path;
          return (
            <button key={c.key} className={"sp-chip-dd-item" + (on ? " on" : "")} onClick={() => pick(c.path)} title={c.path}>
              <ProjectIcon icon={c.project?.icon} />
              <span className="ca-folder-dd__name">{c.name}</span>
              {c.project && c.name !== basename(c.path) && <span className="ca-folder-dd__dir">{basename(c.path)}</span>}
              <span className="check">
                <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="m4 8 3 3 5-6" />
                </svg>
              </span>
            </button>
          );
        })}
      </div>

      <div className="sp-chip-dd-sep"></div>
      <button className="sp-chip-dd-item sp-chip-dd-item--action" onClick={newProject}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M8 3v10M3 8h10" />
        </svg>
        <span>New project</span>
      </button>
    </div>
  );
}
