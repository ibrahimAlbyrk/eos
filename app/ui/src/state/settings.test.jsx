import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Effects run as the provider renders, so the server renderer shows what the
// provider hands on.
vi.mock("react", async (original) => ({ ...(await original()), useEffect: (run) => { run(); } }));

const boot = vi.hoisted(() => ({ settings: undefined }));
vi.mock("../api/boot.js", () => ({ peekBootPart: (path) => (path === "/api/settings" ? boot.settings : undefined) }));
vi.mock("../api/client.js", () => ({
  api: new Proxy({}, { get: () => () => new Promise(() => {}) }),
}));
vi.mock("./composer.jsx", () => ({ useComposer: () => ({ updateComposer: () => {} }) }));
vi.mock("./selection.jsx", () => ({ useSelection: () => ({ resetToolToggles: () => {} }) }));
vi.mock("../settings/theme.js", () => ({ THEME_STORAGE_KEY: "cm:theme", setTheme: () => {} }));
const setEosPreview = vi.hoisted(() => vi.fn());
vi.mock("./eos/eosStatusStore.js", () => ({ setEosPreview, isEosShown: () => false }));

const { SettingsProvider } = await import("./settings.jsx");

function provide(settings) {
  boot.settings = settings === undefined ? undefined : { settings };
  vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
  renderToStaticMarkup(<SettingsProvider>{null}</SettingsProvider>);
}

beforeEach(() => {
  setEosPreview.mockClear();
  vi.unstubAllGlobals();
});

describe("the Eos preview setting", () => {
  it("reaches the probe store when it is on", () => {
    provide({ "eos.preview": true });
    expect(setEosPreview).toHaveBeenCalledWith(true);
    expect(setEosPreview).not.toHaveBeenCalledWith(false);
  });

  it("keeps Eos hidden when it is off or not set", () => {
    provide({ "eos.preview": false });
    expect(setEosPreview.mock.calls).toEqual([[false]]);
    setEosPreview.mockClear();
    provide(undefined);
    expect(setEosPreview.mock.calls).toEqual([[false]]);
  });
});
