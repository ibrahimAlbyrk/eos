import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../api/client.js", () => ({
  api: { getArtifacts: vi.fn(() => new Promise(() => {})), refreshArtifacts: vi.fn() },
}));

// The ui providers seed their state (the selected agent included) from localStorage.
const ls = new Map([["cm:selectedId", "w-1"]]);
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };

const { UiProvider } = await import("../../state/ui.jsx");
const { PaneScopeContext } = await import("../../state/paneScope.js");
const { api } = await import("../../api/client.js");
const { applyArtifactsChange, revalidateArtifactCatalog } = await import("../../state/artifactCatalogStore.js");
const { publishArtifacts } = await import("../../state/artifactsStore.js");
const { ArtifactCard } = await import("./ArtifactCard.jsx");
const { ArtifactsPanel } = await import("./ArtifactsPanel.jsx");
const { ArtifactPanel } = await import("./ArtifactPanel.jsx");

const SLUG = "fc8663b5-9f93-4ff4-8a4b-ada56eec16fa";
const URL = "https://claude.ai/artifact/YBc8tWaK41fiYSKdCZ88EM";
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const inPane = (node) => renderToStaticMarkup(<UiProvider><PaneScopeContext.Provider value="leaf-a">{node}</PaneScopeContext.Provider></UiProvider>);

const catalog = {
  refreshing: false,
  accounts: [
    { loginId: "p", label: "Personal", email: "me@example.com", count: 2, refreshedAt: ago(60_000) },
    { loginId: "w", label: "Work", email: "me@work.example", count: 0, refreshedAt: ago(3600_000), error: "Sign-in expired" },
  ],
  artifacts: [
    { slug: SLUG, url: URL, title: "Eos 0.1.2 release notes", kind: "Page", versionLabel: "v3", favicon: "📄", tint: "blue", rel: "mine", updatedAt: ago(10_000), loginId: "p" },
    { slug: "9e41c7d2-1b3a-4c5d-8e9f-0a1b2c3d4e5f", url: "https://claude.ai/artifact/LYT7DezY9NMo1GzECapRkz", title: "Onboarding guide", kind: "Doc", rel: "shared", updatedAt: ago(4 * 60_000), loginId: "p" },
  ],
};

// The catalog arrives only from the route; artifacts:change just says to read it again.
// The store's first load also listens for window focus.
async function seed(c) {
  vi.stubGlobal("window", { addEventListener: () => {} });
  api.getArtifacts.mockResolvedValue(c);
  revalidateArtifactCatalog();
  applyArtifactsChange();
  await new Promise((r) => setTimeout(r, 0));
  vi.unstubAllGlobals();
}

describe("ArtifactCard", () => {
  it("shows what the tool call knows before the catalog has the artifact", () => {
    const html = renderToStaticMarkup(<ArtifactCard artifact={{ url: URL, slug: SLUG, title: "release-notes", verb: "Published", ts: Date.now() }} />);
    expect(html).toContain(`data-art-slug="${SLUG}"`);
    expect(html).toContain(`href="${URL}"`);
    expect(text(html)).toContain("release-notes Page · just now Open");
    expect(html).not.toContain("art-av");
  });

  it("takes title, kind, label, tint and account from the catalog", async () => {
    await seed(catalog);
    const html = renderToStaticMarkup(<ArtifactCard artifact={{ url: URL, slug: SLUG, title: "release-notes", verb: "Updated", ts: 1 }} />);
    expect(text(html)).toContain("Eos 0.1.2 release notes Page · v3 · just now");
    expect(html).toContain('data-tint="blue"');
    expect(html).toContain("📄");
    expect(html).toMatch(/class="art-av art-av--md" data-av="0" title="Personal"[^>]*>P</);
    expect(html).toContain('data-login-id="p"');
  });
});

describe("ArtifactsPanel", () => {
  it("groups by sign-in, flags this chat's artifacts and a failed read", async () => {
    await seed(catalog);
    publishArtifacts("w-1", [{ url: URL, slug: SLUG, title: "release-notes", ts: 1 }]);
    const html = inPane(<ArtifactsPanel />);
    const out = text(html);
    expect(out).toContain("All accounts");
    expect(out).toMatch(/Personal 2 .*Eos 0\.1\.2 release notes Page · v3 This chat just now/);
    expect(out).toContain("Onboarding guide Doc · shared with you 4 min ago");
    expect(out).toMatch(/Work 0 Sign-in expired/);
    expect(out).toContain("2 accounts · synced 1 h ago");
    expect(html).toContain('aria-label="Refresh artifacts"');
  });

  it("asks for a Claude sign-in when there is none", async () => {
    await seed({ artifacts: [], accounts: [], refreshing: false });
    const out = text(inPane(<ArtifactsPanel />));
    expect(out).toContain("Sign in to Claude in Settings › Accounts");
    expect(out).toContain("Open Settings");
  });

  it("shows the refresh running", async () => {
    await seed({ ...catalog, refreshing: true });
    const html = inPane(<ArtifactsPanel />);
    expect(text(html)).toContain("2 accounts · syncing…");
    expect(html).toMatch(/class="art-refresh is-spinning"[^>]*disabled/);
  });
});

describe("ArtifactPanel without the app's bridge", () => {
  it("offers claude.ai instead of a live view", async () => {
    await seed(catalog);
    const html = inPane(<ArtifactPanel tabId={`artifact:${SLUG}`} />);
    expect(text(html)).toContain("Eos 0.1.2 release notes");
    expect(html).toContain(`href="${URL}"`);
    expect(text(html)).toContain("Open on claude.ai");
  });
});
