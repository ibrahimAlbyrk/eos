import { memo, useMemo } from "react";
import { stripMcpPrefix } from "../../lib/format.js";
import { ToolShell, Chips } from "./ToolShell.jsx";
import { resultStatus, tryParseJson } from "./shared.js";

function StateDot({ state }) {
  const s = String(state || "").toUpperCase();
  const cls =
    s === "WORKING" ? "vb-orch__dot--run" :
    s === "IDLE" ? "vb-orch__dot--idle" :
    s === "DONE" ? "vb-orch__dot--done" :
    s === "KILLING" || s === "ERRORED" ? "vb-orch__dot--err" :
    "vb-orch__dot--idle";
  return <span className={`vb-orch__dot ${cls}`} />;
}

function modelChipFor(m) {
  const s = String(m || "").toLowerCase();
  if (s.includes("opus")) return { label: "opus", tone: "clay" };
  if (s.includes("sonnet")) return { label: "sonnet", tone: "sage" };
  if (s.includes("haiku")) return { label: "haiku", tone: "saffron" };
  return { label: m || "opus", tone: "clay" };
}

export const OrchestratorTool = memo(function OrchestratorTool({ tool, result, family }) {
  const base = stripMcpPrefix(tool.tool);
  const status = resultStatus(result);
  const parsed = useMemo(() => tryParseJson(result?.body), [result]);

  // ─── spawn_worker ───
  if (base === "spawn_worker") {
    const name = tool.input?.name || "(unnamed)";
    const prompt = tool.input?.prompt || "";
    const model = tool.input?.model || "opus";
    const withGateway = tool.input?.withGateway !== false;
    const id = parsed?.id || parsed?.worker?.id || null;
    const port = parsed?.port || null;
    const mc = modelChipFor(model);

    return (
      <ToolShell
        family={family}
        icon="agentSpawn"
        title={
          <span className="vb-tool__name">
            <span className="vb-tool__verb">spawn_worker</span>
            <span className="vb-tool__arr">→</span>
            <span className="vb-orch__assignee">{name}</span>
          </span>
        }
        subtitle={
          <Chips items={[
            { value: mc.label, tone: mc.tone },
            withGateway ? { value: "gateway" } : null,
            tool.input?.maxCostUsd ? { label: "max", value: `$${tool.input.maxCostUsd}` } : null,
            tool.input?.maxElapsedMs ? { label: "ttl", value: `${Math.round(tool.input.maxElapsedMs / 1000)}s` } : null,
          ].filter(Boolean)} />
        }
        status={status}
        defaultOpen
        body={
          <div className="vb-toolbody vb-toolbody--orch">
            <div className="vb-orch__brief">
              <div className="vb-orch__brief-h">briefing</div>
              <blockquote className="vb-orch__brief-body">{prompt}</blockquote>
            </div>
            {id && (
              <div className="vb-orch__resp">
                <span className="vb-orch__resp-arrow">►</span>
                <span>spawned</span>
                <code className="vb-orch__wid">{id}</code>
                {port && <span className="vb-orch__port">port {port}</span>}
              </div>
            )}
          </div>
        }
      />
    );
  }

  // ─── kill_worker ───
  if (base === "kill_worker") {
    const id = tool.input?.id || "";
    return (
      <ToolShell
        family={family}
        icon="power"
        title={
          <span className="vb-tool__name">
            <span className="vb-tool__verb">kill_worker</span>
            <span className="vb-tool__arr">›</span>
            <code className="vb-orch__wid">{id}</code>
          </span>
        }
        status={status}
        body={null}
        bare
      />
    );
  }

  // ─── list_workers ───
  if (base === "list_workers") {
    const rows = Array.isArray(parsed) ? parsed : [];
    return (
      <ToolShell
        family={family}
        icon="list"
        title={
          <span className="vb-tool__name">
            <span className="vb-tool__verb">list_workers</span>
            <span className="vb-tool__sub-sep">·</span>
            <span className="vb-orch__count">{rows.length}</span>
          </span>
        }
        status={status}
        defaultOpen={rows.length > 0}
        body={
          rows.length > 0 ? (
            <div className="vb-toolbody vb-toolbody--orch">
              <div className="vb-orch__table">
                {rows.map((w, i) => (
                  <div key={i} className="vb-orch__trow">
                    <StateDot state={w.state} />
                    <code className="vb-orch__wid">{String(w.id || "").slice(0, 10)}</code>
                    <span className="vb-orch__tstate">{String(w.state || "").toLowerCase()}</span>
                    <span className="vb-orch__tbranch">{w.branch || "—"}</span>
                    <span className="vb-orch__tprompt">{(w.prompt || "").slice(0, 80)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null
        }
      />
    );
  }

  // ─── get_worker ───
  if (base === "get_worker") {
    const id = tool.input?.id || "";
    const worker = parsed?.worker || null;
    const events = Array.isArray(parsed?.events) ? parsed.events : [];
    return (
      <ToolShell
        family={family}
        icon="cpu"
        title={
          <span className="vb-tool__name">
            <span className="vb-tool__verb">get_worker</span>
            <span className="vb-tool__arr">›</span>
            <code className="vb-orch__wid">{id}</code>
          </span>
        }
        subtitle={worker && (
          <span className="vb-tool__sub-grp">
            <span>{String(worker.state || "").toLowerCase()}</span>
            {worker.branch && <><span className="vb-tool__sub-sep">·</span><span>{worker.branch}</span></>}
            {worker.model && <><span className="vb-tool__sub-sep">·</span><span>{worker.model}</span></>}
          </span>
        )}
        status={status}
        body={
          worker ? (
            <div className="vb-toolbody vb-toolbody--orch">
              <div className="vb-orch__statgrid">
                <div><span className="vb-orch__sk">state</span><span className="vb-orch__sv">{worker.state}</span></div>
                <div><span className="vb-orch__sk">model</span><span className="vb-orch__sv">{worker.model}</span></div>
                <div><span className="vb-orch__sk">branch</span><span className="vb-orch__sv">{worker.branch || "—"}</span></div>
                <div><span className="vb-orch__sk">cost</span><span className="vb-orch__sv">${(worker.cost_usd || 0).toFixed(3)}</span></div>
              </div>
              {events.length > 0 && (
                <div className="vb-orch__events">
                  <div className="vb-orch__events-h">recent events ({events.length})</div>
                  {events.slice(-6).map((e, i) => (
                    <div key={i} className="vb-orch__erow">
                      <span className="vb-orch__etype">{e.type}</span>
                      <span className="vb-orch__epay">{String(e.payload || "").slice(0, 80)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null
        }
      />
    );
  }

  // ─── list_pending_permissions ───
  if (base === "list_pending_permissions") {
    const rows = Array.isArray(parsed) ? parsed : [];
    return (
      <ToolShell
        family={family}
        icon="shield"
        title={
          <span className="vb-tool__name">
            <span className="vb-tool__verb">list_pending_permissions</span>
            <span className="vb-tool__sub-sep">·</span>
            <span className="vb-orch__count">{rows.length}</span>
          </span>
        }
        status={status}
        defaultOpen={rows.length > 0}
        body={
          rows.length > 0 ? (
            <div className="vb-toolbody vb-toolbody--orch">
              <div className="vb-orch__pending">
                {rows.map((r, i) => (
                  <div key={i} className="vb-orch__prow">
                    <code className="vb-orch__wid">{String(r.worker_id || "").slice(0, 10)}</code>
                    <span className="vb-orch__arrow">→</span>
                    <span className="vb-orch__tool">{r.tool_name}</span>
                    <span className="vb-orch__pend-ts">{r.created_at}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="vb-toolbody vb-toolbody--orch">
              <div className="vb-orch__empty">no pending permissions</div>
            </div>
          )
        }
      />
    );
  }

  // Fallback for any future MCP tool.
  return (
    <ToolShell
      family={family}
      icon="spawn"
      title={<span className="vb-tool__name">{base}</span>}
      subtitle={tool.args?.replace(/\s+/g, " ")}
      status={status}
      body={
        result?.body ? (
          <div className="vb-toolbody vb-toolbody--orch">
            <pre className="vb-code">{result.body}</pre>
          </div>
        ) : null
      }
    />
  );
});
