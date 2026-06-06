import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";

export function AttachPopover({ onAttach }) {
  const ui = useUi();
  if (ui.openPopover !== "attach") return null;

  const pickFiles = async () => {
    ui.closeAllPops();
    try {
      const res = await api.pickFiles();
      if (res.cancelled || !res.paths?.length) return;
      onAttach(res.paths.map((p) => {
        const ext = p.split(".").pop()?.toLowerCase() ?? "";
        const isImage = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext);
        return { type: isImage ? "image" : "file", path: p };
      }));
    } catch (e) {
      console.error("pickFiles failed:", e);
    }
  };

  const pickFolder = async () => {
    ui.closeAllPops();
    try {
      const res = await api.pickDirectory();
      if (res.cancelled || !res.path) return;
      onAttach([{ type: "folder", path: res.path }]);
    } catch (e) {
      console.error("pickDirectory failed:", e);
    }
  };

  return (
    <div className="attach-popover glass-pop open" id="attachPopover" data-popover="attach">
      <button className="menu-item" onClick={pickFiles}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3" />
        </svg>
        Add files or photos
      </button>
      <button className="menu-item" onClick={pickFolder}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
        </svg>
        Add folder
      </button>
    </div>
  );
}
