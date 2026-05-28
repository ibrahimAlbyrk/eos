import { api } from "../../../api/client.js";
import { ImageLightbox } from "../ImageLightbox.jsx";

function basename(path) {
  return path.split("/").pop() || path;
}

export function AttachmentChips({ attachments, onRemove }) {
  return (
    <div className="attachment-chips">
      {attachments.map((att) => (
        <div key={att.path} className={`att-chip att-${att.type}`} title={att.path}>
          {att.type === "image" ? (
            <ImageLightbox src={api.imageUrl(att.path)} alt={basename(att.path)}>
              <img src={api.imageUrl(att.path)} alt={basename(att.path)} className="att-thumb" />
            </ImageLightbox>
          ) : (
            <div className="att-icon-wrap">
              {att.type === "folder" ? (
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                  <path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3" />
                </svg>
              )}
            </div>
          )}
          {onRemove && (
            <button
              className="att-remove"
              onClick={(e) => { e.stopPropagation(); onRemove(att.path); }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 2l6 6M8 2l-6 6" />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
