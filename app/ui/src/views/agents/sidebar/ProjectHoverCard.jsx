import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../../api/client.js";
import { remoteSlug, tildePath } from "../../../lib/projects.js";
import { saveProject, openProjectModal } from "../../../state/projectsStore.js";
import { ProjectIcon } from "../../../components/project/ProjectIcon.jsx";

const svg = (children) => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);
const TasksIcon = () => svg(<path d="M8 2.5c3.3 0 6 2.2 6 5s-2.7 5-6 5c-.8 0-1.6-.1-2.3-.4L2.5 13.5l.9-2.6C2.5 10 2 8.8 2 7.5c0-2.8 2.7-5 6-5z" />);
const RepoIcon = () => svg(<path d="M3.5 12.5v-9A1.5 1.5 0 0 1 5 2h7.5v9H5a1.5 1.5 0 0 0-1.5 1.5A1.5 1.5 0 0 0 5 14h1.5M9 12.5V15l1-.8 1 .8v-2.5" />);
const FolderIcon = () => svg(<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3l1.2 1.5h5.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />);
const GearIcon = () => svg(<><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></>);
const PinIcon = () => svg(<path d="M9.5 2.5 13.5 6.5 11 7.5 8.5 10l.5 3-6-6 3 .5L8.5 5zM5.5 10.5 2.5 13.5" />);

// Hover card for a sidebar project group: identity, task count, git remote and
// primary folder, plus pin + "Edit project". An unregistered folder group gets
// promoted into a project the first time it's pinned or edited.
export function ProjectHoverCard({ group, anchor, onEnter, onLeave, onDone }) {
  const [slug, setSlug] = useState(null);
  const project = group.project ?? null;

  useEffect(() => {
    let alive = true;
    api.listBranches(group.path).then((r) => { if (alive) setSlug(remoteSlug(r.remoteUrl)); }).catch(() => {});
    return () => { alive = false; };
  }, [group.path]);

  const togglePin = () => {
    const base = project ?? { name: group.name, folders: [group.path] };
    saveProject({ ...base, pinned: !project?.pinned }).catch(() => {});
  };

  const edit = () => {
    onDone();
    openProjectModal(project ? { project } : { path: group.path });
  };

  const count = group.roots.length;
  const style = { left: anchor.right + 8, top: Math.min(anchor.top, window.innerHeight - 200) };

  return createPortal(
    <div className="proj-card glass-pop" style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="proj-card__head">
        <ProjectIcon icon={project?.icon} size={15} />
        <span className="proj-card__name">{group.name}</span>
        <button className={"proj-card__pin" + (project?.pinned ? " on" : "")} title={project?.pinned ? "Unpin" : "Pin to top"} onClick={togglePin}>
          <PinIcon />
        </button>
      </div>
      <div className="proj-card__row"><TasksIcon /><span>{count} {count === 1 ? "task" : "tasks"}</span></div>
      <div className="proj-card__sep" />
      {slug && <div className="proj-card__row"><RepoIcon /><span>{slug}</span></div>}
      {(project?.folders ?? [group.path]).map((f) => (
        <div key={f} className="proj-card__row" title={f}><FolderIcon /><span>{tildePath(f)}</span></div>
      ))}
      <div className="proj-card__sep" />
      <button className="proj-card__row proj-card__action" onClick={edit}><GearIcon /><span>Edit project</span></button>
    </div>,
    document.body,
  );
}
