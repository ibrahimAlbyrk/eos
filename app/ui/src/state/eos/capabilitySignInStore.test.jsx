import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { setEosTransport } from "./transport.js";
import { cancelSignIn, closeSignIn, openSignInPage, startSignIn, useSignIn } from "./capabilitySignInStore.js";

const PATH = ROUTES.capabilitySignIn("github");
const CODE = { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: 1763500900000 };
const ok = (body) => ({ ok: true, status: 200, body });

function current() {
  let read;
  function Probe() {
    read = useSignIn();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read;
}

// A core whose sign-in answers `started` to POST and each of `statuses` to GET, in turn.
function core(started, statuses = []) {
  const queue = [...statuses];
  const t = {
    get: vi.fn(async () => queue.shift() ?? ok({ state: "pending" })),
    send: vi.fn(async (method) => (method === "POST" ? started : ok({}))),
  };
  setEosTransport(t);
  return t;
}

let open;
beforeEach(() => {
  vi.useFakeTimers();
  open = vi.fn();
  vi.stubGlobal("window", { open });
});
afterEach(() => {
  closeSignIn();
  setEosTransport(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("signing in to GitHub", () => {
  it("shows the code and opens GitHub's page in the system browser", async () => {
    const t = core(ok(CODE));
    const started = startSignIn("github");
    expect(current()).toEqual({ id: "github", phase: "starting" });
    await started;
    expect(t.send).toHaveBeenCalledWith("POST", PATH, undefined);
    expect(current()).toEqual({ id: "github", phase: "code", userCode: CODE.userCode, verificationUri: CODE.verificationUri });
    expect(open).toHaveBeenCalledWith(CODE.verificationUri, "_blank", "noopener,noreferrer");
  });

  it("follows the status until the user is signed in", async () => {
    const t = core(ok(CODE), [ok({ state: "pending" }), ok({ state: "pending" }), ok({ state: "signed_in", accountLabel: "octocat" })]);
    await startSignIn("github");
    await vi.advanceTimersByTimeAsync(2000);
    expect(current().phase).toBe("pending");
    expect(current().userCode).toBe(CODE.userCode);
    await vi.advanceTimersByTimeAsync(4000);
    expect(current()).toMatchObject({ phase: "ready", accountLabel: "octocat" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(t.get).toHaveBeenCalledTimes(3);
    expect(t.get).toHaveBeenCalledWith(PATH);
  });

  it("ends when the code ran out or GitHub was told no", async () => {
    core(ok(CODE), [ok({ state: "expired" })]);
    await startSignIn("github");
    await vi.advanceTimersByTimeAsync(2000);
    expect(current().phase).toBe("expired");

    core(ok(CODE), [ok({ state: "denied" })]);
    await startSignIn("github");
    await vi.advanceTimersByTimeAsync(2000);
    expect(current().phase).toBe("denied");
  });

  it("keeps asking through a failed read, and stops when the core forgot the attempt", async () => {
    core(ok(CODE), [{ ok: false, status: 502, body: { error: "x" } }, { ok: false, status: 404, body: { error: "not found" } }]);
    await startSignIn("github");
    await vi.advanceTimersByTimeAsync(2000);
    expect(current().phase).toBe("code");
    await vi.advanceTimersByTimeAsync(2000);
    expect(current()).toMatchObject({ phase: "failed", error: "The sign-in was interrupted. Try again." });
  });

  it("can be cancelled: the core stops waiting and nothing is asked after", async () => {
    const t = core(ok(CODE));
    await startSignIn("github");
    cancelSignIn();
    expect(t.send).toHaveBeenLastCalledWith("DELETE", PATH, undefined);
    expect(current()).toEqual({ id: "github", phase: "cancelled" });
    await vi.advanceTimersByTimeAsync(10000);
    expect(t.get).not.toHaveBeenCalled();
  });

  it("closing while it waits cancels it too", async () => {
    const t = core(ok(CODE));
    await startSignIn("github");
    closeSignIn();
    expect(t.send).toHaveBeenLastCalledWith("DELETE", PATH, undefined);
    expect(current()).toBeNull();
  });

  it("says when Eos has no GitHub client id", async () => {
    core({ ok: false, status: 409, body: { error: "github needs setup: client_id_missing", code: "client_id_missing" } });
    await startSignIn("github");
    expect(current()).toEqual({ id: "github", phase: "client_id_missing" });
    expect(open).not.toHaveBeenCalled();
  });

  it("says when this is a dev run", async () => {
    core({ ok: false, status: 403, body: { error: "refused in a dev run: this request can reach another computer" } });
    await startSignIn("github");
    expect(current()).toEqual({ id: "github", phase: "dev_run" });
  });

  it("shows the core's reason for any other failure", async () => {
    core({ ok: false, status: 404, body: { error: "capability linear-issues not found" } });
    await startSignIn("github");
    expect(current()).toMatchObject({ phase: "failed", error: "capability linear-issues not found" });
  });

  it("opens only an https page", async () => {
    core(ok({ ...CODE, verificationUri: "javascript:alert(1)" }));
    await startSignIn("github");
    openSignInPage();
    expect(open).not.toHaveBeenCalled();
  });
});
