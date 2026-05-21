import { memo, Fragment, useState } from "react";
import { CONFIG } from "../config.js";
import { ctxPct, modelShort, liveElapsed, fmtCost, toolIcon, stripMcpPrefix } from "../lib/format.js";
import { Icon, Avatar, StatusBadge } from "./primitives.jsx";
import { exportWorkerMarkdown, downloadAsFile } from "../lib/exportMarkdown.js";

const ExportButton = memo(function ExportButton({ agent }) {
  const click = () => {
    // Pull the live event window straight from data.jsx — keeps the Details
    // component decoupled from the global events prop chain.
    const all = window.live.state.events || [];
    const mine = all.filter((e) => e.agent === agent.id || (e.agent === "user" && agent.role === "main"));
    const md = exportWorkerMarkdown(agent, mine);
    const slug = (agent.name || agent.id).replace(/[^a-z0-9_-]+/gi, "_");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadAsFile(`${slug}-${stamp}.md`, md);
  };
  return (
    <button className="vb-btn vb-btn--ghost" onClick={click} title="Download transcript as markdown" aria-label="Export transcript">
      <Icon name="copy" size={12} /> <span>Export</span>
    </button>
  );
});

const KillButton = memo(function KillButton({ agent }) {
  const [pending, setPending] = useState(false);
  const terminal = agent.status === "done" || agent.status === "killed" || agent.status === "error";
  const click = async () => {
    if (pending) return;
    setPending(true);
    try {
      await fetch(`${location.origin}/workers/${agent.id}`, { method: "DELETE" }).catch(() => {});
      window.live.refresh();
    } finally {
      setTimeout(() => setPending(false), 800);
    }
  };
  return (
    <button className="vb-btn vb-btn--ghost vb-btn--danger" onClick={click} disabled={pending}
            style={pending ? { opacity: 0.6, cursor: "wait" } : terminal ? { opacity: 0.85 } : {}}
            title="SIGTERM the worker, sweep orphans, drop the entry">
      <Icon name="kill" size={12} /> <span>{pending ? "Killing…" : "Kill"}</span>
    </button>
  );
});

const ActivitySection = memo(function ActivitySection({ activity, max }) {
  const [hover, setHover] = useState(null);
  const total = activity.reduce((s, n) => s + n, 0);
  const label = hover != null
    ? `${activity[hover]} call${activity[hover] === 1 ? "" : "s"} · ${activity.length - hover}m ago`
    : `${total} total · last ${activity.length}m`;
  return (
    <div className="vb-detsection">
      <div className="vb-detsection__head">
        <span>Activity · last {activity.length} minutes</span>
        <span className="vb-muted vb-mono">{label}</span>
      </div>
      <div className="vb-bars" onMouseLeave={() => setHover(null)}>
        {activity.map((v, i) => (
          <div key={i}
               className="vb-bar-slot"
               onMouseEnter={() => setHover(v > 0 ? i : null)}>
            <i className={`vb-bar ${v / max > 0.7 ? "vb-bar--hot" : ""} ${hover === i ? "vb-bar--hover" : ""}`}
               style={{ height: `${Math.max(6, (v / max) * 100)}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
});

export const Details = memo(function Details({ agent, agents, onSelect, onCollapse }) {
  if (!agent) {
    return (
      <aside className="vb-details">
        <div className="vb-details__head-bar">
          <span>Details</span>
          <button className="vb-iconbtn vb-iconbtn--paneltoggle" onClick={onCollapse} title="Collapse panel" aria-label="Collapse details panel">
            <Icon name="panelRight" size={14} />
          </button>
        </div>
        <div className="vb-empty">
          <Icon name="agent" size={36} />
          <div>Select an agent to inspect</div>
        </div>
      </aside>
    );
  }

  const children = agents.filter(a => a.parent === agent.id);
  const parent = agents.find(a => a.id === agent.parent);
  const pct = ctxPct(agent);
  const max = Math.max(1, ...(agent.activity || [0]));

  return (
    <aside className="vb-details">
      <div className="vb-details__head-bar">
        <span>Agent details</span>
        <button className="vb-iconbtn vb-iconbtn--paneltoggle" onClick={onCollapse} title="Collapse panel" aria-label="Collapse details panel">
          <Icon name="panelRight" size={14} />
        </button>
      </div>
      <div className="vb-details__hero">
        <Avatar agent={agent} size={44} />
        <div className="vb-details__hero-text">
          <div className="vb-details__hero-name">{agent.name}</div>
          <div className="vb-details__hero-id">
            <code className="vb-inlinecode">{agent.id}</code>
            <button className="vb-iconbtn vb-iconbtn--xs" onClick={() => navigator.clipboard?.writeText(agent.id)} title="Copy id" aria-label="Copy worker id"><Icon name="copy" size={10} /></button>
          </div>
        </div>
        <StatusBadge status={agent.status} />
      </div>

      {agent.description && <div className="vb-details__desc">{agent.description}</div>}

      <div className="vb-details__scroll">
        <div className="vb-detsection">
          <div className="vb-detsection__head">Vitals</div>
          <div className="vb-vitals">
            <div className="vb-vital"><div className="vb-vital__label">Model</div><div className="vb-vital__value">{modelShort(agent.model)}</div></div>
            <div className="vb-vital"><div className="vb-vital__label">Elapsed</div><div className="vb-vital__value vb-mono">{liveElapsed(agent)}</div></div>
            <div className="vb-vital"><div className="vb-vital__label">Cost</div><div className="vb-vital__value">{fmtCost(agent.cost || 0)}</div></div>
            <div className="vb-vital"><div className="vb-vital__label">Parent</div><div className="vb-vital__value">{parent ? <a className="vb-link" onClick={() => onSelect(parent.id)}>{parent.name}</a> : <span className="vb-muted">root</span>}</div></div>
          </div>
        </div>

        <div className="vb-detsection">
          <div className="vb-detsection__head">
            <span>Context</span>
            <span className="vb-muted vb-mono">{pct}%</span>
          </div>
          <div className="vb-segbar">
            <div className="vb-segbar__fill" style={{ width: `${pct}%` }} />
            <div className="vb-segbar__ticks">{[25, 50, 75].map(t => <div key={t} style={{ left: `${t}%` }} />)}</div>
          </div>
          <div className="vb-tokrow">
            <div><span className="vb-muted">in</span> <b>{(agent.tokens?.in || 0).toLocaleString()}</b></div>
            <div><span className="vb-muted">out</span> <b>{(agent.tokens?.out || 0).toLocaleString()}</b></div>
            <div><span className="vb-muted">budget</span> <b>{(() => {
              const b = agent.tokens?.budget || 200000;
              return b >= 1_000_000 ? `${(b/1_000_000).toFixed(0)}M` : `${(b/1000)|0}k`;
            })()}</b></div>
          </div>
        </div>

        <ActivitySection activity={agent.activity || new Array(CONFIG.activityBuckets).fill(0)} max={max} />

        <div className="vb-detsection">
          <div className="vb-detsection__head">
            <span>Tools used</span>
            <span className="vb-muted vb-mono">{(agent.tools || []).reduce((s, t) => s + t.count, 0)} calls</span>
          </div>
          {(!agent.tools || agent.tools.length === 0) ? (
            <div className="vb-empty-row">— none yet —</div>
          ) : (() => {
            const max = Math.max(...agent.tools.map(x => x.count));
            return agent.tools.map(t => (
              <div key={t.name} className="vb-toolrow">
                <span className="vb-toolrow__icon"><Icon name={toolIcon(t.name)} size={12} /></span>
                <span className="vb-toolrow__name">{stripMcpPrefix(t.name)}</span>
                <span className="vb-toolrow__bar"><span style={{ width: `${(t.count / max) * 100}%` }} /></span>
                <span className="vb-toolrow__count vb-mono">{t.count}</span>
              </div>
            ));
          })()}
        </div>

        {children.length > 0 && (
          <div className="vb-detsection">
            <div className="vb-detsection__head">
              <span>Children</span>
              <span className="vb-muted vb-mono">{children.length}</span>
            </div>
            {children.map(c => (
              <div key={c.id} className="vb-childrow" onClick={() => onSelect(c.id)}>
                <Avatar agent={c} size={26} />
                <div className="vb-childrow__col">
                  <div className="vb-childrow__name">{c.name}</div>
                  <div className="vb-childrow__meta">{modelShort(c.model)} · <span className="vb-mono">{liveElapsed(c)}</span></div>
                </div>
                <StatusBadge status={c.status} />
              </div>
            ))}
          </div>
        )}

        {(agent.branch || agent.cwd) && (
          <div className="vb-detsection">
            <div className="vb-detsection__head">Worktree</div>
            <div className="vb-kvb">
              {agent.branch && <div className="vb-kvb__row"><span className="vb-kvb__k">branch</span><span className="vb-kvb__v vb-mono">{agent.branch}</span></div>}
              {agent.cwd && (
                <div className="vb-kvb__row">
                  <span className="vb-kvb__k">cwd</span>
                  <span className="vb-kvb__v vb-mono">
                    {agent.cwd.split("/").flatMap((seg, i, arr) =>
                      i < arr.length - 1
                        ? [seg, <Fragment key={i}>/<wbr/></Fragment>]
                        : [seg]
                    )}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="vb-details__actions">
        <ExportButton agent={agent} />
        <KillButton agent={agent} />
      </div>
    </aside>
  );
});
