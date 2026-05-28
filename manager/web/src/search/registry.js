import { scoreMatch } from "./match.js";

// SearchProvider contract (documented, not enforced — plain objects):
//   { id: string, label: string, getResults(ctx) => SearchResult[] }
// SearchResult:
//   { id, icon, title, subtitle?, meta?, keywords?: string[], onSelect(ctx) }
//
// The registry is the single place that knows how to *aggregate* and *rank*
// results. Providers only describe their domain (Open/Closed: add a source by
// registering a provider — the palette and registry never change).

export function createSearchRegistry(initial = []) {
  const providers = [...initial];

  return {
    register(provider) {
      providers.push(provider);
      return () => {
        const i = providers.indexOf(provider);
        if (i !== -1) providers.splice(i, 1);
      };
    },

    providers() {
      return [...providers];
    },

    // Returns grouped results: [{ id, label, items }], groups in provider
    // registration order, items sorted by relevance within each group.
    search(query, ctx) {
      const q = (query || "").trim();
      const groups = [];

      for (const provider of providers) {
        const items = (provider.getResults(ctx) || [])
          .map((item) => {
            const haystack = [item.title, item.subtitle, ...(item.keywords || [])]
              .filter(Boolean)
              .join(" ");
            const score = q ? scoreMatch(q, haystack) : 0;
            return score == null ? null : { ...item, _score: score };
          })
          .filter(Boolean)
          .sort((a, b) => b._score - a._score);

        if (items.length) groups.push({ id: provider.id, label: provider.label, items });
      }

      return groups;
    },
  };
}
