import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ROUTES } from "../api/routes.js";
import { fixtureTransport, setEosTransport } from "../state/eos/transport.js";
import { probeEosStatus } from "../state/eos/eosStatusStore.js";
import { useViewSwitchHotkeys } from "./useViewSwitchHotkeys.js";

let binding = null;
const setActiveView = vi.fn();
vi.mock("../keymap/useKeymap.js", () => ({ useKeybinding: (b) => { binding = b; } }));
vi.mock("../state/navigation.jsx", () => ({ useNavigation: () => ({ setActiveView }) }));

async function eosServed(served) {
  setEosTransport(fixtureTransport(served ? { [ROUTES.routines]: [] } : {}));
  await probeEosStatus();
}

// ⌘⌃<digit> on a Mac; → the view it opened, or null.
function press(digit) {
  setActiveView.mockClear();
  const e = { metaKey: true, ctrlKey: true, altKey: false, shiftKey: false, code: `Digit${digit}`, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  expect(binding.match(e)).toBe(true);
  binding.run({}, e);
  return setActiveView.mock.calls[0]?.[0] ?? null;
}

beforeEach(() => useViewSwitchHotkeys());
afterEach(() => setEosTransport(null));

describe("⌘⌃1…9", () => {
  it("are today's shortcuts while Eos is hidden", async () => {
    await eosServed(false);
    expect([1, 2, 3, 4].map(press)).toEqual(["agents", "code", "machines", null]);
  });

  it("open Eos with ⌘⌃1 and move the others down one once it shows", async () => {
    await eosServed(true);
    expect([1, 2, 3, 4].map(press)).toEqual(["eos", "agents", "code", "machines"]);
  });
});
