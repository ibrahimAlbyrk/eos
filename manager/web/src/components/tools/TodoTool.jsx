import { memo } from "react";
import { Icon } from "../primitives.jsx";
import { ToolShell } from "./ToolShell.jsx";
import { resultStatus } from "./shared.js";

const ICON_FOR = {
  pending: "emptySquare",
  in_progress: "halfSquare",
  completed: "checkSquare",
};

export const TodoTool = memo(function TodoTool({ tool, result, family }) {
  const todos = Array.isArray(tool.input?.todos) ? tool.input.todos : [];
  const status = resultStatus(result);
  const counts = todos.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});

  const subtitle = (
    <span className="vb-tool__sub-grp">
      <span>{todos.length} items</span>
      {counts.completed > 0 && (
        <><span className="vb-tool__sub-sep">·</span><span className="vb-tool__sub-add">{counts.completed} done</span></>
      )}
      {counts.in_progress > 0 && (
        <><span className="vb-tool__sub-sep">·</span><span className="vb-tool__chip-v">{counts.in_progress} active</span></>
      )}
      {counts.pending > 0 && (
        <><span className="vb-tool__sub-sep">·</span><span>{counts.pending} pending</span></>
      )}
    </span>
  );

  return (
    <ToolShell
      family={family}
      icon="checkSquare"
      title={<span className="vb-tool__name"><span className="vb-tool__verb">TodoWrite</span></span>}
      subtitle={subtitle}
      status={status}
      defaultOpen={todos.length > 0 && todos.length <= 12}
      body={
        todos.length > 0 ? (
          <div className="vb-toolbody vb-toolbody--todo">
            <ul className="vb-todo__list">
              {todos.map((t, i) => {
                const label = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
                return (
                  <li key={i} className={`vb-todo__row vb-todo__row--${t.status || "pending"}`}>
                    <span className="vb-todo__box">
                      <Icon name={ICON_FOR[t.status] || "emptySquare"} size={14} />
                    </span>
                    <span className="vb-todo__text">{label}</span>
                    {t.status === "in_progress" && (
                      <span className="vb-todo__badge">in progress</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null
      }
    />
  );
});
