import { FolderIcon } from "./icons.jsx";
import { tildify } from "./text.js";

// Where the copy lands, and the one way to change it.
export function Destination({ dest, toLabel, onChange }) {
  return (
    <div className="tx-dest">
      <span className="tx-dest__label">Save to</span>
      <div className="tx-field">
        <span className="tx-field__ic"><FolderIcon /></span>
        <span className="tx-field__path mono" title={dest?.destDir}>{dest ? tildify(dest.destDir) : "Pick something to send"}</span>
        <button type="button" className="m-btn m-btn--quiet m-btn--sm" onClick={onChange}>Change</button>
      </div>
      {dest?.reason === "project" && <span className="tx-hint">Same project on {toLabel} — matched by its git remote.</span>}
    </div>
  );
}
