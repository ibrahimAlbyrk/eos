import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../api/routes.js";
import { fixtureTransport, setEosTransport } from "./eos/transport.js";
import { probeEosStatus } from "./eos/eosStatusStore.js";
import { NavigationProvider, initialView, shownView, useNavigation } from "./navigation.jsx";

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

async function eosServed(served) {
  setEosTransport(fixtureTransport(served ? { [ROUTES.routines]: [] } : {}));
  await probeEosStatus();
}

function Shown() {
  return useNavigation().activeViewId;
}

const render = () => renderToStaticMarkup(<NavigationProvider><Shown /></NavigationProvider>);

beforeEach(() => {
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("the stored view", () => {
  it("keeps a stored eos through a probe that answers late", async () => {
    await eosServed(false);
    localStorage.setItem("cm:activeView", "eos");

    expect(initialView()).toBe("eos");
    expect(shownView("eos")).toBe("agents");
    expect(render()).toBe("agents");
    expect(localStorage.getItem("cm:activeView")).toBe("eos");

    await eosServed(true);
    expect(shownView("eos")).toBe("eos");
    expect(render()).toBe("eos");
  });

  it("is what it always was for a user without Eos", async () => {
    await eosServed(false);
    expect(render()).toBe("agents");
    for (const id of ["agents", "code", "machines"]) {
      localStorage.setItem("cm:activeView", id);
      expect(render()).toBe(id);
    }
    localStorage.setItem("cm:activeView", "home");
    expect(render()).toBe("agents");
  });
});
