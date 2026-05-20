import { createRoot } from "react-dom/client";
import "./styles.css";
// data.jsx is a side-effect module: it attaches window.live + window.fmtDur
// and starts the polling/SSE loops. App.jsx and its children consume window.live
// via the useLive() hook.
import "./data.jsx";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(<App />);
