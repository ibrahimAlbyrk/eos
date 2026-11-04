// The `eos` object a plugin's activate(eos) receives. Everything it adds is
// remembered and taken away again when the plugin unloads (a new build, turned
// off, deleted), so a plugin never cleans up after itself. Ids a plugin picks
// are its own: they're namespaced by plugin id, so two plugins never collide.

import { Component, createElement, useSyncExternalStore } from "react";
import { headerRight, sidebarNav, mainViews, setMainView, closeMainView, getMainView } from "../slots/index.js";
import { registerPanel } from "../lib/panelRegistry.js";
import { notify } from "../lib/notify.js";
import { getPlugin, subscribePlugins } from "./pluginsStore.js";
import { usePluginValue } from "./pluginValues.js";

// A plugin's component that throws while rendering shows nothing instead of
// taking its surroundings down with it.
class PluginBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`Plugin "${this.props.plugin}" crashed:`, error, info?.componentStack);
  }

  render() {
    return this.state.error ? null : this.props.children;
  }
}

function guarded(pluginId, Inner) {
  function Guarded(props) {
    return createElement(PluginBoundary, { plugin: pluginId }, createElement(Inner, props));
  }
  Guarded.displayName = `Plugin(${pluginId})`;
  return Guarded;
}

export function createPluginApi(plugin, disposers) {
  const pid = plugin.id;
  const ns = (id) => `${pid}:${id}`;
  const keep = (dispose) => { disposers.push(dispose); return dispose; };
  const need = (value, what) => {
    if (!value) throw new Error(`${what} is required`);
    return value;
  };

  const useSettings = () => {
    const get = () => getPlugin(pid)?.settings ?? plugin.settings ?? {};
    return useSyncExternalStore(subscribePlugins, get, get);
  };

  return {
    id: pid,

    // A widget on the right of a chat's header. once: only in the top-right
    // pane (one per window) instead of every pane.
    // Component props: { worker, live, topRight }
    headerRight({ id, Component, order = 100, once = false }) {
      return keep(headerRight.add({ id: ns(need(id, "id")), order, once, Component: guarded(pid, need(Component, "Component")) }));
    },

    // A row in the left sidebar's nav (under New task / Changes / Archive).
    // Opens main view `view` (a mainView id of this plugin), or renders a
    // custom row: Component({ live }).
    sidebarNav({ id, label, icon = null, view, Component: Row, order = 100 }) {
      const item = Row
        ? { id: ns(need(id, "id")), order, Component: guarded(pid, Row) }
        : { id: ns(need(id, "id")), order, label: need(label, "label"), icon, view: ns(need(view, "view")) };
      return keep(sidebarNav.add(item));
    },

    // A view that takes the chat area while open (beside the side panel).
    // Component props: { live }
    mainView({ id, Component }) {
      const vid = ns(need(id, "id"));
      const remove = mainViews.add({ id: vid, Component: guarded(pid, need(Component, "Component")) });
      return keep(() => {
        remove();
        closeMainView(vid);
      });
    },
    openMainView: (id) => setMainView(ns(id)),
    closeMainView: (id) => closeMainView(ns(id)),
    isMainViewOpen: (id) => getMainView() === ns(id),

    // A tab of the right side panel; launcher: true also puts it in the
    // new-tab launcher. Component props: { live, tabId }
    sidePanelTab({ id, label, icon = null, Component, launcher = false, keepAlive = true }) {
      const type = `${pid}.${need(id, "id")}`;
      return keep(registerPanel({
        type,
        label: need(label, "label"),
        icon,
        Component: guarded(pid, need(Component, "Component")),
        keepAlive,
        ...(launcher ? { launcher: { order: 1000, in: ["agent", "code"] } } : {}),
      }));
    },

    // Styles for this plugin, removed with it. (A CSS file imported from the
    // UI entry is loaded the same way.)
    css(text) {
      const el = document.createElement("style");
      el.dataset.plugin = pid;
      el.textContent = String(text);
      document.head.appendChild(el);
      return keep(() => el.remove());
    },

    // Hooks — call them inside the plugin's components.
    // The plugin's settings (Settings › Plugins), defaults filled in.
    useSettings,
    useSetting: (key) => useSettings()[key],
    // A value this plugin keeps across restarts: [value, setValue].
    useStore: (key, initial) => usePluginValue(pid, key, initial),

    notify,
  };
}
