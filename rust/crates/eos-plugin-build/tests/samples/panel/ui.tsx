import React, { Fragment, useEffect, useMemo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import * as ReactDOM from "react-dom";
import { jsxDEV } from "react/jsx-dev-runtime";
import dot from "./parts/dot.png";
import data from "./parts/data.json";
import { Row, type RowProps } from "./parts/Row";
import "./parts/panel.css";

interface Api {
  sidePanel: { add(tab: { id: string; title: string; render: () => ReactNode }): void };
}

enum Mode {
  List = "list",
  Grid = "grid",
}

function Panel({ mode }: { mode: Mode }) {
  const rows = useMemo<RowProps[]>(() => data.rows.map((r, i) => ({ ...r, index: i })), []);
  useEffect(() => {
    const host = document.createElement("div");
    const root = createRoot(host);
    root.render(<i>portal</i>);
    return () => root.unmount();
  }, []);
  return (
    <>
      <img src={dot} alt="" />
      {rows.map((r) => (
        <Fragment key={r.index}>
          <Row {...r} />
        </Fragment>
      ))}
      <footer data-mode={mode}>{typeof ReactDOM.createPortal} {typeof jsxDEV} {React.version}</footer>
    </>
  );
}

export default function activate(eos: Api): void {
  eos.sidePanel.add({ id: "panel", title: "Panel", render: () => <Panel mode={Mode.Grid} /> });
}
