import { useState } from "react";
import "./style.css";
import icon from "./icon.svg";
import { label } from "./lib/label.ts";

function Clock() {
  const [n, setN] = useState(0);
  return (
    <button className="clock" onClick={() => setN(n + 1)} title={icon}>
      {label(n)}
    </button>
  );
}

export default function activate(eos) {
  eos.headerRight.add({ id: "clock", render: () => <Clock /> });
}
