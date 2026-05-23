import { useUi } from "../../state/ui.jsx";

export function AttachPopover() {
  const ui = useUi();
  if (ui.openPopover !== "attach") return null;

  const todo = () => {
    alert("Attach is not implemented in the daemon yet.");
    ui.closeAllPops();
  };

  return (
    <div className="attach-popover glass-pop open" id="attachPopover" data-popover="attach">
      <button className="menu-item" onClick={todo}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3" />
        </svg>
        Add files or photos
      </button>
      <button className="menu-item" onClick={todo}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
        </svg>
        Add folder
      </button>
    </div>
  );
}
