import { api } from "../../../api/client.js";
import { ImageLightbox } from "../ImageLightbox.jsx";
import { labelTitle } from "../../../lib/attachmentTokens.js";
import { segment, URL_RE } from "../../../lib/richText.jsx";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);

function parseAttachments(text) {
  const idx = text.indexOf("\n\nattachments:\n");
  if (idx === -1) return { display: text, attachments: [] };
  const display = text.slice(0, idx);
  const attSection = text.slice(idx + "\n\nattachments:\n".length);
  const attachments = attSection
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean)
    .map((raw) => {
      const labeled = raw.match(/^(\{(image|file|folder) #\d+\}):\s*(.+)$/);
      if (labeled) return { label: labeled[1], type: labeled[2], path: labeled[3] };
      const m = raw.match(/^(folder|file|image):\s*(.+)$/);
      if (m) return { type: m[1], path: m[2] };
      const ext = raw.split(".").pop()?.toLowerCase() ?? "";
      return { path: raw, type: IMAGE_EXTS.has(ext) ? "image" : "file" };
    });
  return { display, attachments };
}

function basename(path) {
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  return p.split("/").pop() || p;
}

function shortenPaths(text, cwd) {
  if (!cwd || !text.includes(cwd)) return text;
  return text.replaceAll(cwd + "/", "@");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRules(labels) {
  const rules = [
    {
      match: URL_RE,
      render: (url, key) => (
        <a key={key} className="msg-link" href={url} rel="noreferrer">{url}</a>
      ),
    },
  ];
  if (labels.length) {
    const re = new RegExp(`(${labels.map(escapeRegExp).join("|")})`, "g");
    rules.push({
      match: re,
      render: (lbl, key) => <span key={key} className="att-hl">{lbl}</span>,
    });
  }
  return rules;
}

export function MessageUser({ text, cwd }) {
  const { display, attachments } = parseAttachments(text);
  const shortened = shortenPaths(display, cwd);
  const labels = attachments.map((a) => a.label).filter(Boolean);
  const images = attachments.filter((a) => a.type === "image");
  const gallery = images.map((a, i) => ({
    src: api.imageUrl(a.path),
    alt: basename(a.path),
    title: labelTitle(a.label) ?? `Image #${i + 1}`,
  }));

  return (
    <div className="msg-user">
      {attachments.length > 0 && (
        <div className="msg-attachments">
          {attachments.map((att) => (
            <div key={att.path} className={`msg-att msg-att-${att.type}`} title={att.path}>
              {att.type === "image" ? (
                <ImageLightbox gallery={gallery} index={images.indexOf(att)}>
                  <img src={api.imageUrl(att.path)} alt={basename(att.path)} className="msg-att-img" />
                </ImageLightbox>
              ) : (
                <div className="msg-att-icon">
                  {att.type === "folder" ? (
                    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
                    </svg>
                  ) : (
                    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                      <path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3" />
                    </svg>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {shortened && <div className="b">{segment(shortened, buildRules(labels))}</div>}
    </div>
  );
}
