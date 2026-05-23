import { useState } from "react";

export function ToolGroup({ verb, title, subtools, panel }) {
  const [open, setOpen] = useState(true);
  const cls = ["toolgroup"];
  if (open) cls.push("open");
  return (
    <div className={cls.join(" ")}>
      <div className="head-row" onClick={() => setOpen((o) => !o)}>
        <span>
          <span className={`verb ${verb}`}>{verbLabel(verb)}</span>{" "}
          {title}
        </span>
        <svg className="chev" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </div>
      {subtools && subtools.length > 0 && (
        <div className="subtools">
          {subtools.map((s, i) => (
            <div className="subtool" key={i}>
              <span className={`v ${verb}`}>{s.name}</span>
              <span className="name">{s.file}</span>
              <span className="chev">›</span>
            </div>
          ))}
        </div>
      )}
      {panel}
    </div>
  );
}

function verbLabel(verb) {
  if (verb === "bash") return "Ran";
  if (verb === "edit") return "Edit";
  return "Read";
}
