import { useEffect, useState } from "react";
import { MODELS, modelName } from "../lib/models.js";
import { providerChoices, usesClaudeCatalog } from "../lib/backendCaps.js";
import { api } from "../api/client.js";

// The model list for a provider NAME — the SINGLE source shared by the composer's
// provider model popovers. A Claude-catalog lane → the Claude catalog (no fetch).
// Anything else (an API profile, or a subscription lane with its own catalog like
// Codex) → GET /api/backends/:name/models, falling back to the pinned model so the
// list is never a dead end.
// Returns { loading, models, error } with models as [{ id, name }].
export function useProviderModels(name) {
  const choice = providerChoices().find((p) => p.name === name) ?? null;
  const claudeCatalog = usesClaudeCatalog(choice);
  const pinned = choice?.model ?? null;
  const [state, setState] = useState({ loading: false, models: [], error: null });

  useEffect(() => {
    if (!name) { setState({ loading: false, models: [], error: null }); return; }
    if (claudeCatalog) {
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
  }, [name, claudeCatalog]);

  return state;
}
