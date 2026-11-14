// The page the app's hidden preview view runs (for the plugin_preview tool): one plugin's build, activated alone, drawn in the
// same markup Eos gives that surface — main view, side-panel tab or header —
// with stand-in stored values. Nothing here writes to the daemon.

import { createRoot } from "react-dom/client";
import { activatePlugin, describeError } from "./runtime.js";
import { previewPluginValues } from "./pluginValues.js";
import { setPluginReportSink } from "./report.js";
import { headerRight, mainViews } from "../slots/index.js";
import { listPanels } from "../lib/panelRegistry.js";

const DEFAULT_WAIT_MS = 700;
// Plugin components get `live`; a preview has no agents.
const live = { workers: [] };

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// What the plugin registered, per surface, by the ids the plugin itself used.
function registered(pid) {
  const own = (items, sep) => items
    .filter((i) => i.id.startsWith(`${pid}${sep}`))
    .map((i) => ({ id: i.id.slice(pid.length + 1), item: i }));
  return {
    main: own(mainViews.list(), ":"),
    panel: own(listPanels(), "."),
    header: own(headerRight.list(), ":"),
  };
}

function MainSurface({ item }) {
  const View = item.Component;
  return (
    <div className="single-pane main-view-host" style={{ height: "100%", background: "var(--bg)" }}>
      <div className="sp-main"><View live={live} /></div>
    </div>
  );
}

function PanelSurface({ item }) {
  const Tab = item.Component;
  return (
    <div className="single-pane" style={{ height: "100%" }}>
      <aside className="side-panel" style={{ width: "100%", borderLeft: "none" }}>
        <div className="sp-tabbar">
          <span className="sp-tab is-active">
            {item.icon && <span className="sp-tab-icon">{item.icon}</span>}
            <span className="sp-tab-label">{item.label}</span>
          </span>
        </div>
        <div className="sp-body">
          <div className="sp-content">
            <div className="sp-tab-body"><Tab live={live} tabId={item.type} /></div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function HeaderSurface({ items }) {
  return (
    <div className="pane-head pane-head--topright" style={{ background: "var(--bg)" }}>
      <div className="crumb"><span className="cur">New chat</span></div>
      <div className="pane-head-actions">
        {items.map(({ item }) => <item.Component key={item.id} live={live} worker={null} topRight />)}
      </div>
    </div>
  );
}

async function preview(args) {
  // sizes: contracts PLUGIN_PREVIEW_SIZES, passed in by the app.
  const { plugin, store, view, sizes, waitMs = DEFAULT_WAIT_MS } = args;
  const errors = [];
  setPluginReportSink((_id, report) => { if (!report.ok && report.error) errors.push(report.error); });
  window.addEventListener("error", (e) => errors.push(describeError(e.error ?? e.message)));
  window.addEventListener("unhandledrejection", (e) => errors.push(describeError(e.reason)));
  previewPluginValues(plugin.id, store);

  try {
    await activatePlugin(plugin, []);
  } catch (e) {
    errors.push(describeError(e));
  }
  const found = registered(plugin.id);
  const available = Object.fromEntries(Object.entries(found).map(([s, list]) => [s, list.map((x) => x.id)]));
  const surface = args.surface ?? ["main", "panel", "header"].find((s) => found[s].length) ?? "main";
  const picked = surface === "header" ? null : (view ? found[surface].find((x) => x.id === view) : found[surface][0]) ?? null;
  const [w, h] = sizes[surface];
  const size = { width: args.width ?? w, height: args.height ?? h };

  if (surface === "header" ? found.header.length === 0 : !picked) {
    errors.push(view
      ? `no ${surface} "${view}" — the plugin registered: ${available[surface].join(", ") || "none"}`
      : `the plugin registered no ${surface} surface`);
  } else {
    createRoot(document.getElementById("root")).render(
      surface === "main" ? <MainSurface item={picked.item} />
        : surface === "panel" ? <PanelSurface item={picked.item} />
          : <HeaderSurface items={found.header} />,
    );
  }
  await document.fonts.ready;
  await nextFrame();
  await nextFrame();
  await sleep(waitMs);
  return { surface, view: picked?.id ?? null, ...size, errors, available };
}

export function startPluginPreview() {
  window.__eosPluginPreview = preview;
}
