import { memo } from "react";
import { stripMcpPrefix } from "../../lib/format.js";
import { ToolShell } from "./ToolShell.jsx";
import { resultStatus } from "./shared.js";

// Terminal-frame rendering: a header row with macOS-style traffic lights as
// purely decorative chrome, then the command behind a $ prompt, and finally
// the captured stdout/stderr in a darker pane.
export const BashTool = memo(function BashTool({ tool, result, family }) {
  const base = stripMcpPrefix(tool.tool);
  const isOutput = base === "BashOutput";
  const isKill = base === "KillShell" || base === "KillBash";
  const command = tool.input?.command || "";
  const description = tool.input?.description || "";
  const bg = !!tool.input?.run_in_background;
  const bashId = tool.input?.bash_id || tool.input?.shell_id;
  const out = (result?.body || "").trim();
  const isError = result?.type === "error";
  const status = resultStatus(result);

  // Try to surface an exit code if Claude included one (its Bash tool result
  // commonly ends with "Exit code: N"). Renders as part of the status pill.
  let exitLabel = null;
  if (status.tone === "ok") {
    const m = /\bexit code[:\s]+(-?\d+)/i.exec(out);
    if (m) exitLabel = `exit ${m[1]}`;
  }

  const subtitle = (
    <span className="vb-tool__sub-grp">
      {isKill && bashId ? <span>shell {bashId}</span> : null}
      {description ? <span className="vb-bash__desc">{description}</span> : null}
      {bg && (<><span className="vb-tool__sub-sep">·</span><span className="vb-tool__chip-v">background</span></>)}
    </span>
  );

  const body = (
    <div className="vb-toolbody vb-toolbody--bash">
      <div className="vb-term">
        <div className="vb-term__chrome">
          <span className="vb-term__dot vb-term__dot--r" />
          <span className="vb-term__dot vb-term__dot--y" />
          <span className="vb-term__dot vb-term__dot--g" />
          <span className="vb-term__title">{isOutput ? `bashOutput${bashId ? ` · ${bashId}` : ""}` : isKill ? "killShell" : "bash"}</span>
        </div>
        {!isOutput && !isKill && command && (
          <div className="vb-term__cmd">
            <span className="vb-term__prompt">$</span>
            <pre className="vb-term__cmd-text">{command}</pre>
          </div>
        )}
        {out && (
          <pre className={`vb-term__out ${isError ? "is-err" : ""}`}>{out}</pre>
        )}
      </div>
    </div>
  );

  return (
    <ToolShell
      family={family}
      icon="terminal"
      title={
        <span className="vb-tool__name">
          <span className="vb-tool__verb">{isOutput ? "bashOutput" : isKill ? "killShell" : "bash"}</span>
          {!isOutput && command && (
            <>
              <span className="vb-tool__arr">›</span>
              <span className="vb-bash__cmd-inline">{command}</span>
            </>
          )}
        </span>
      }
      subtitle={subtitle}
      status={{ tone: status.tone, label: exitLabel || status.label }}
      defaultOpen={false}
      body={body}
    />
  );
});
