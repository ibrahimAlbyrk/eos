import { useEffect, useState } from "react";
import { MODELS, modelName } from "../lib/models.js";
import { providerChoices } from "../lib/backendCaps.js";
import { api } from "../api/client.js";

// The model list for a provider NAME — the SINGLE source shared by the composer's
// profile model popover and the Settings model picker. A subscription provider →
// the Claude catalog (no fetch). An API profile → GET /api/backends/:name/models,
// falling back to the profile's pinned model so the list is never a dead end.
// Returns { loading, models, error } with models as [{ id, name }].
export function useProviderModels(name) {
  const choice = providerChoices().find((p) => p.name === name) ?? null;
  const subscription = choice?.subscription ?? false;
  const pinned = choice?.model ?? null;
  const [state, setState] = useState({ loading: false, models: [], error: null });

  useEffect(() => {
    if (!name) { setState({ loading: false, models: [], error: null }); return; }
    if (subscription) {
      setState({ loading: false, models: MODELS.map((m) => ({ id: m.aliases[0] ?? m.id, name: m.name })), error: null });
      return;
    }
    let alive = true;
    setState({ loading: true, models: [], error: null });
    api.listBackendModels(name).then((res) => {
      if (!alive) return;
      const ids = res.models?.length ? res.models : (pinned ? [pinned] : []);
      setState({ loading: false, models: ids.map((id) => ({ id, name: modelName(id) || id })), error: res.error ?? null });
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, subscription]);

  return state;
}
