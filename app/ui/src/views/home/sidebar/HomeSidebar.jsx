import { useEffect } from "react";
import { TabBar } from "../../../components/TabBar.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { useHome, refreshHome, selectHome, createHome, removeHome } from "../../../state/homeStore.js";

// The Home tab's sidebar: the shared TabBar, a "New" action, and the flat list of
// Home conversations. Mirrors CodeSidebar's island structure but without the
// grouping/archive machinery — Home conversations are a simple list.
export function HomeSidebar({ live, variant = "full" }) {
  const { conversations, selectedId, loaded } = useHome();

  useEffect(() => { refreshHome(); }, []);

  const onNew = async () => {
    try { await createHome(); } catch { /* surfaced by the store's caller path */ }
  };

  const onDelete = async (e, id) => {
    e.stopPropagation();
    try { await removeHome(id); } catch { /* ignore — list refetch reconciles */ }
  };

  const body = (
    <>
      <TabBar variant={variant} />
      <div className="sb-head">
        <div className="sb-head__title">Chats <span className="sb-head__count">{conversations.length}</span></div>
        <div className="sb-head__actions">
          <button className="sb-iconbtn" onClick={onNew} title="New chat" aria-label="New chat">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M8 3.5v9M3.5 8h9" />
            </svg>
          </button>
        </div>
      </div>
      <div className="home-convs">
        {loaded && conversations.length === 0 && (
          <div className="home-convs__empty">No chats yet — start one with New.</div>
        )}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={"home-conv" + (c.id === selectedId ? " is-active" : "")}
            onClick={() => selectHome(c.id)}
            role="button"
            tabIndex={0}
          >
            <span className="home-conv__name">{c.name || "Untitled"}</span>
            <button
              className="home-conv__del"
              onClick={(e) => onDelete(e, c.id)}
              title="Delete chat"
              aria-label="Delete chat"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      <SettingsFooter />
    </>
  );

  if (variant === "popup") return body;

  return (
    <>
      <div className="side-island side-island--agents">{body}</div>
      <div className="side-island side-island--status">
        <span className="lab">Daemon</span>
        <span className="val">
          <span className="status-dot" style={!live?.health ? { background: "var(--err)" } : {}}></span>
          {live?.health ? "online" : "offline"}
        </span>
      </div>
    </>
  );
}
