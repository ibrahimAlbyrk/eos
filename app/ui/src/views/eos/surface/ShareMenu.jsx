import { useState } from "react";
import { useMenuDismiss } from "../menu/useMenuDismiss.js";
import { notify } from "../../../lib/notify.js";
import { mailPreview, printIssue, revealFile, shareDocument } from "../../../state/eos/pageStore.js";

// A file name from the page's title and the issue's number.
export function shareName(title, seq) {
  const base = (title || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
  return seq == null ? `${base}.html` : `${base}-${seq}.html`;
}

// Hands `html` to the browser as a file to save.
function save(html, name) {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// Share: the issue taken out of the frame, from one menu so the header keeps
// to one line: the mail as it would be sent (one column, shown in a frame
// that runs nothing), a PDF shown in Finder once printed, and one .html file
// to share (D31).
export function ShareMenu({ surface, row }) {
  const [mail, setMail] = useState(null);
  const showMail = async () => {
    const html = await mailPreview(surface.id, row.id);
    if (html) setMail(html);
    else notify.error("The mail preview could not be made.", { title: "Mail preview" });
  };
  const [printing, setPrinting] = useState(false);
  const pdf = async () => {
    setPrinting(true);
    const r = await printIssue(surface.id, row.id, typeof navigator === "undefined" ? undefined : navigator.language);
    setPrinting(false);
    if (r.ok) void revealFile(r.path);
    else notify.error(r.error, { title: "Save as PDF" });
  };
  const share = async () => {
    const html = await shareDocument(surface.id, row.id);
    if (html) save(html, shareName(surface.title, row.seq));
    else notify.error("The file could not be made.", { title: "Save as a file" });
  };
  const [open, setOpen] = useState(false);
  const wrapRef = useMenuDismiss(open, () => setOpen(false));
  const items = [
    { label: "Mail preview", run: showMail },
    { label: printing ? "Printing…" : "Save as PDF", run: pdf, busy: printing },
    { label: "Save as a file", run: share },
  ];
  const choose = (item) => {
    setOpen(false);
    void item.run();
  };
  return (
    <>
      <span className="eos-menu-wrap" ref={wrapRef}>
        <button type="button" className="eos-btn eos-btn--quiet" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {printing ? "Printing…" : "Share"}
        </button>
        {open && (
          <ul className="eos-menu" role="menu" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
            {items.map((item) => (
              <li key={item.label} role="none">
                <button type="button" role="menuitem" className="eos-menu__item" disabled={item.busy} onClick={() => choose(item)}>{item.label}</button>
              </li>
            ))}
          </ul>
        )}
      </span>
      {mail && (
        <div className="eos-sheet-overlay" role="presentation" onClick={() => setMail(null)}>
          <div className="eos-sheet eos-mail-preview" role="dialog" aria-label="Mail preview" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === "Escape") setMail(null); }}>
            <div className="eos-mail-preview__head">
              <h2 className="eos-sheet__title">As the mail will look</h2>
              <button type="button" className="eos-btn" autoFocus onClick={() => setMail(null)}>Close</button>
            </div>
            <iframe className="eos-mail-preview__frame" title="Mail preview" sandbox="" srcDoc={mail} />
          </div>
        </div>
      )}
    </>
  );
}
