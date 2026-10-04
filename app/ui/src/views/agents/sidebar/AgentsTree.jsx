import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { statusFromState, fmtTimeAgoShort } from "../../../lib/format.js";
import { nameOf, AgentName } from "../../../lib/agentName.js";
import { loopBadgeTitle } from "../../../lib/loopDisplay.js";
import { groupAgents } from "../../../lib/agentGrouping.js";
import { sortRoots } from "../../../lib/agentSorting.js";
import { ownSignal, strongest, subtreeSignal } from "../../../lib/rowSignal.js";
import { useSidebarPrefs } from "../../../state/sidebarPrefsStore.js";
import { useCustomGroups } from "../../../state/customGroupsStore.js";
import { setActiveGroup } from "../../../state/layoutGroupsStore.js";
import { leaf } from "../../../lib/paneLayout.js";
import { subscribe as subscribeLoopCheck, checkFor as loopCheckFor } from "../../../state/loopCheckStore.js";
import { RenameInput } from "../../../components/RenameInput.jsx";
import { ArchiveNode } from "./ArchiveNode.jsx";
import { ProjectHoverCard } from "./ProjectHoverCard.jsx";
import { ProjectIcon } from "../../../components/project/ProjectIcon.jsx";
import { useProjects } from "../../../state/projectsStore.js";
import { useHoverCard } from "../../../hooks/useHoverCard.js";
import { api } from "../../../api/client.js";

// A fully transparent 1×1 image to suppress the browser's native drag ghost — the
// custom DragAffordance (PaneGrid) is what the user sees during a drag instead.
// Created once at module load so it's decoded by the time a drag starts.
const TRANSPARENT_DRAG_IMG = typeof Image === "function" ? new Image() : null;
if (TRANSPARENT_DRAG_IMG) {
  TRANSPARENT_DRAG_IMG.src =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
}

const EMPTY_SET = new Set();

// Project grouping shows this many rows per project; the rest fold behind
// "Show N more". Rows that are busy, blocked, unread or selected always show.
const PREVIEW_ROWS = 3;

// Statuses that carry no news — the row shows its last-activity age instead.
const QUIET_LABELS = new Set(["idle", "done"]);

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M3.5 3h9A1.5 1.5 0 0 1 14 4.5v5.5a1.5 1.5 0 0 1-1.5 1.5H7.5L4.5 14v-2.5h-1A1.5 1.5 0 0 1 2 10V4.5A1.5 1.5 0 0 1 3.5 3z" />
    </svg>
  );
}

function RunSpinner() {
  return (
    <svg className="ag-spin" width="12" height="12" viewBox="0 0 16 16" role="img" aria-label="running">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  );
}

// `compact` is the folded-project form: a dot instead of the "Input" chip.
function SignalMark({ signal, compact = false }) {
  if (signal === "input") {
    return compact
      ? <span className="ag-wait" title="Waiting for your input"></span>
      : <span className="ag-ask" title="Waiting for your input">Input</span>;
  }
  if (signal === "unread") return <span className="ag-notify" aria-label="finished with new output" title="finished with new output"></span>;
  if (signal === "running") return <RunSpinner />;
  return null;
}

function lastActiveAt(w) {
  return w.turn_started_at ?? w.started_at ?? null;
}

// The rows of one group, capped to PREVIEW_ROWS when `capped` — the selected
// row and anything with a live signal stay visible past the cap.
function GroupRows({ group, capped, onRename, variant, archivedSelectedId, signals, lead }) {
  const ui = useUi();
  const moreKey = `more:${group.key}`;
  const showAll = !capped || ui.collapsedNodes.has(moreKey);
  const sel = ui.selectedId;
  const kept = !capped ? group.roots : group.roots.filter((n, i) => i < PREVIEW_ROWS
    || n.id === sel || n.id === archivedSelectedId
    || (sel != null && subtreeHasId(n, sel))
    || (!n.__archived && subtreeSignal(n, signals) != null));
  const hidden = group.roots.length - kept.length;
  const rows = showAll ? group.roots : kept;

  return (
    <div className="agents-group__rows">
      {rows.map((n) => (
        n.__archived
          ? <ArchiveNode key={n.id} node={n} selectedId={archivedSelectedId} isRoot />
          : <TreeNode key={n.id} node={n} onRename={onRename} variant={variant} signals={signals} lead={lead} />
      ))}
      {hidden > 0 && (
        <button className="agents-row agents-row--more" onClick={() => ui.toggleNodeCollapsed(moreKey)}>
          <span className="tree-chev-spacer"></span>
          <span className="ag-name">{showAll ? "Show less" : `Show ${hidden} more`}</span>
        </button>
      )}
    </div>
  );
}

// A project section: the project header (icon, name, its own "+" that spawns a
// new orchestrator pre-seated to the project's primary folder) above that
// project's rows. Clicking the header folds the rows — a folded header shows
// the row count and the strongest signal inside; hovering a folder group
// shows its ProjectHoverCard. While composing a new task in this project the
// header wears the selected style.
// Rows are a MIX of live (TreeNode) and archived (ArchiveNode) agents — the
// grouping/sort pipeline interleaves both kinds, and each root is dispatched to
// its renderer by the __archived tag AgentsSidebar stamps on it.
function AgentGroup({ group, capped, onRename, variant, archivedSelectedId, waiting }) {
  const ui = useUi();
  const hover = useHoverCard();
  const collapseId = `group:${group.key}`;
  const collapsed = ui.collapsedNodes.has(collapseId);
  const selected = ui.selectedId == null && Boolean(group.path) && !ui.composer.noFolder && ui.composer.cwd === group.path;
  const signals = { waiting, unread: ui.needsAttention };
  const folded = collapsed
    ? group.roots.reduce((s, n) => (n.__archived ? s : strongest(s, subtreeSignal(n, signals))), null)
    : null;

  const onAdd = useCallback((e) => {
    e.stopPropagation();
    // Pre-seat the composer's cwd with this project's path, then enter spawn
    // mode exactly like the global + (SidebarHead). ComposerConfigRow only
    // auto-seeds cwd when unset, so this pre-selection survives the switch.
    ui.updateComposer({ cwd: group.path });
    ui.setSelectedId(null);
  }, [group.path, ui]);

  return (
    <div className="agents-group">
      <div
        className={"agents-group__head agents-group__head--toggle" + (selected ? " on" : "")}
        onClick={() => { hover.close(); ui.toggleNodeCollapsed(collapseId); }}
        onMouseEnter={group.path ? (e) => hover.enterAnchor(e.currentTarget) : undefined}
        onMouseLeave={group.path ? hover.leave : undefined}
      >
        <span className="agents-group__icon" aria-hidden="true"><ProjectIcon icon={group.project?.icon} /></span>
        <span className="agents-group__name">{group.name}</span>
        {collapsed && group.roots.length > 0 && (
          <span className="agents-group__meta">
            <SignalMark signal={folded} compact />
            <span className="ag-status">{group.roots.length}</span>
          </span>
        )}
        {group.path && (
          <button
            className="sb-iconbtn agents-group__add"
            title={`New orchestrator in ${group.name}`}
            onClick={onAdd}
          >
            <PlusIcon />
          </button>
        )}
      </div>
      {hover.anchor && (
        <ProjectHoverCard group={group} anchor={hover.anchor} onEnter={hover.enterCard} onLeave={hover.leave} onDone={hover.close} />
      )}
      {/* Rows stay mounted so fold/unfold can animate; inert keeps folded rows
          out of the tab order. */}
      <div className={"agents-group__body" + (collapsed ? " collapsed" : "")} inert={collapsed ? "" : undefined}>
        <GroupRows
          group={group}
          capped={capped}
          onRename={onRename}
          variant={variant}
          archivedSelectedId={archivedSelectedId}
          signals={signals}
        />
      </div>
    </div>
  );
}

// Sessions started with no project ("No folder") are not a project: they get
// their own Recents section under the projects instead of a pseudo-project.
function RecentsSection({ group, onRename, variant, archivedSelectedId, waiting }) {
  const ui = useUi();
  const signals = { waiting, unread: ui.needsAttention };
  const composing = ui.selectedId == null && Boolean(ui.composer.noFolder);
  const onAdd = (e) => {
    e.stopPropagation();
    ui.updateComposer({ noFolder: true });
    ui.setSelectedId(null);
  };
  return (
    <div className="agents-group agents-group--recents">
      <div className="sb-seclabel">
        <span className="sb-seclabel__text">Recents</span>
        <button className={"sb-seclabel__filter" + (composing ? " on" : "")} title="New task with no folder" onClick={onAdd}>
          <PlusIcon />
        </button>
      </div>
      <GroupRows
        group={group}
        capped
        onRename={onRename}
        variant={variant}
        archivedSelectedId={archivedSelectedId}
        signals={signals}
        lead={<ChatIcon />}
      />
    </div>
  );
}

export function AgentsTree({ roots, loaded = true, onRename, variant = "full", archivedSelectedId = null, emptyLabel, waitingIds = EMPTY_SET }) {
  const prefs = useSidebarPrefs();
  const { groups: customGroups, assignments } = useCustomGroups();
  const { projects } = useProjects();
  // A pending permission or an open ask_user question (flagged on the row by
  // the daemon, so it shows without the transcript loaded) both block on the user.
  const waiting = (w) => waitingIds.has(w.id) || w.awaiting_question === true;
  const groups = useMemo(() => {
    const raw = groupAgents(roots, prefs.groupBy, { now: Date.now(), groups: customGroups, assignments, projects });
    // Registered projects show even when empty — except in the archived-only list.
    const shown = prefs.status === "archived" ? raw.filter((g) => g.roots.length > 0) : raw;
    return shown.map((g) => ({ ...g, roots: sortRoots(g.roots, prefs.sortBy) }));
  }, [roots, prefs.groupBy, prefs.sortBy, prefs.status, customGroups, assignments, projects]);
  if (groups.length === 0) {
    // `loaded` gates the definitive empty state: until the first /workers fetch
    // resolves (or after a swallowed failure) an empty list only means "still
    // loading" — rendering "No agents yet" there reads as zero agents existing.
    return (
      <div className="agents-section">
        <div className="empty-tree" style={{ padding: "24px 14px", color: "var(--fg-faint)", fontSize: "var(--text-sm)" }}>
          {loaded ? (emptyLabel ?? "No agents yet — start one with New task.") : "Loading agents…"}
        </div>
      </div>
    );
  }
  // Only the folder (project) grouping has a scratch group; date/custom keep
  // their buckets whole and uncapped.
  const byProject = prefs.groupBy !== "date" && prefs.groupBy !== "custom";
  const recents = byProject ? groups.find((g) => g.scratch) ?? null : null;
  const projectGroups = byProject ? groups.filter((g) => !g.scratch) : groups;
  return (
    <div className="agents-section">
      {projectGroups.map((g) => (
        <AgentGroup key={g.key} group={g} capped={byProject} onRename={onRename} variant={variant} archivedSelectedId={archivedSelectedId} waiting={waiting} />
      ))}
      {recents && (
        <RecentsSection group={recents} onRename={onRename} variant={variant} archivedSelectedId={archivedSelectedId} waiting={waiting} />
      )}
    </div>
  );
}

// True when any descendant of `node` has the given id. Used to surface a
// collapsed parent as selected when the real selection is hidden inside it.
function subtreeHasId(node, id) {
  for (const c of node.children) {
    if (c.id === id || subtreeHasId(c, id)) return true;
  }
  return false;
}

function TreeNode({ node, onRename, variant = "full", signals, lead = null }) {
  const ui = useUi();
  // A live goal-check on this worker flips the static "loop" badge to "checking".
  const loopCheck = useSyncExternalStore(subscribeLoopCheck, () => loopCheckFor(node.id), () => loopCheckFor(node.id));
  const collapsed = ui.collapsedNodes.has(node.id);
  const hasChildren = node.children.length > 0;
  const status = statusFromState(node.state);
  // A folded parent shows what its hidden sub-agents are doing.
  const signal = collapsed ? subtreeSignal(node, signals) : ownSignal(node, signals);
  const activeAt = lastActiveAt(node);
  const cls = ["tree-node"];
  if (collapsed) cls.push("collapsed");
  const isSelected = ui.selectedId === node.id;
  // When this group is collapsed and the actual selection lives inside it, wear
  // the selected style so the user can see where their selection went. Purely
  // visual — selectedId still points at the hidden worker.
  const holdsCollapsedSelection =
    collapsed && !isSelected && ui.selectedId != null && subtreeHasId(node, ui.selectedId);
  const rowCls = ["agents-row"];
  if (isSelected || holdsCollapsedSelection) rowCls.push("on");
  // Shown in another (non-focused) split pane — a quieter marker than the
  // focused selection's "on".
  else if (ui.paneCount > 1 && ui.paneAgents.includes(node.id)) rowCls.push("in-pane");
  // Only the visible instance owns the rename input. When collapsed the docked
  // sidebar stays mounted (hidden via opacity/transform, still focusable), so
  // without this gate it would mount a second RenameInput sharing renamingId —
  // the two inputs fight for focus and the loser's onBlur cancels the rename.
  const renameActive = variant === "popup" || !ui.sideCollapsed;
  const isRenaming = renameActive && ui.renamingId === node.id;

  const onClick = (e) => {
    // Cmd-click toggles the agent as a split pane (unchanged). Plain click yields
    // a single-pane fullscreen of this agent (Plan B): in a split, collapse to one
    // fresh leaf; already single-pane, swap the agent in place (keep-alive, no
    // remount). Either way, drop the active layout-group marker — the tree no
    // longer matches a saved group.
    if (e.metaKey) { ui.togglePaneForAgent(node.id); return; }
    if (ui.paneCount > 1) ui.setLayout(leaf(node.id));
    else ui.selectAgent(node.id);
    setActiveGroup(null);
  };
  const onCtx = (e) => {
    e.preventDefault();
    ui.openPop("ctx-menu", {
      x: e.clientX, y: e.clientY,
      data: { agentId: node.id },
    });
  };

  const handleRename = useCallback((newName) => {
    ui.setRenamingId(null);
    onRename?.(node.id, newName);
  }, [node.id, onRename, ui]);

  const cancelRename = useCallback(() => {
    ui.setRenamingId(null);
  }, [ui]);

  return (
    <div className={cls.join(" ")}>
      <div
        className={rowCls.join(" ")}
        onClick={onClick}
        onContextMenu={onCtx}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-eos-agent", node.id);
          e.dataTransfer.effectAllowed = "move";
          if (TRANSPARENT_DRAG_IMG) e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0);
        }}
      >
        {hasChildren ? (
          <button
            className="tree-chev"
            title="Toggle"
            onClick={(e) => { e.stopPropagation(); ui.toggleNodeCollapsed(node.id); }}
          >
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
        ) : (
          <span className={"tree-chev-spacer" + (lead ? " ag-lead" : "")}>{lead}</span>
        )}
        {node.agent_role === "git" && !isRenaming && (
          <span className="ag-git-badge" title="Git agent">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4.5" cy="3.5" r="1.5" />
              <circle cx="4.5" cy="12.5" r="1.5" />
              <circle cx="11.5" cy="5" r="1.5" />
              <path d="M4.5 5v6M11.5 6.5c0 2.2-2.7 2.6-4.5 3.2" />
            </svg>
          </span>
        )}
        {isRenaming
          ? <RenameInput currentName={nameOf(node)} onSave={handleRename} onCancel={cancelRename} workerId={node.id} />
          : <span
              className={`ag-name ${node.is_orchestrator || node.agent_role === "focused" ? "main" : ""}`}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                ui.setRenamingId(node.id);
                api.renameIntent(node.id, true).catch(() => {});
              }}
            ><AgentName worker={node} short /></span>}
        {!isRenaming && (node.loop || loopCheck) && (
          <span
            className={`ag-loop-badge st-${loopCheck ? "checking" : node.loop?.status}`}
            title={loopBadgeTitle(node.loop)}
          >{loopCheck ? "checking" : "loop"}</span>
        )}
        {!isRenaming && (signal
          ? <SignalMark signal={signal} />
          : <span className="ag-status" title={status.label}>
              {QUIET_LABELS.has(status.label) && activeAt != null ? fmtTimeAgoShort(activeAt) : status.label}
            </span>)}
      </div>
      {hasChildren && (
        <div className="tree-children">
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} onRename={onRename} variant={variant} signals={signals} />
          ))}
        </div>
      )}
    </div>
  );
}
