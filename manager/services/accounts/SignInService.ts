// SignInService — browser sign-ins in flight, at most one per provider. A
// SubscriptionProvider knows how to run its provider's official sign-in and where
// the credential it yields lives; this service owns only the session lifecycle
// the UI polls: starting → waiting (sign-in page open) → succeeded | failed |
// cancelled. Finished sessions linger briefly so a late poll still sees the end.
//
// A provider that holds several sign-ins signs in to a store PlanLoginService
// prepares — a fresh one to add a sign-in, a listed sign-in's own to renew it —
// and the sign-in is recorded there once it succeeds.

import type { SignInSession } from "../../../contracts/src/accounts.ts";
import { errMsg } from "../../../contracts/src/util.ts";
import type { PlanLoginService, SignInTarget } from "../../../core/src/services/PlanLoginService.ts";

export interface SignInFlow {
  /** Resolves with the credential the provider issued; rejects on failure. */
  readonly result: Promise<string>;
  submitCode(code: string): void;
  cancel(): void;
}

export interface SubscriptionProvider {
  readonly id: string;
  /** The provider's page may show a code to paste back into the flow. */
  readonly acceptsCode?: boolean;
  /** Holds several sign-ins, each in its own store: sign-in and sign-out get
   *  that store, and describe() reads which account signed in to it. Without it
   *  the provider keeps its one sign-in in a store of its own. */
  readonly multiLogin?: boolean;
  startSignIn(handlers: { onUrl(url: string): void }, storeDir?: string): SignInFlow;
  saveCredential(credential: string): void;
  describe?(storeDir: string): { email?: string };
  signOut(storeDir?: string): void | Promise<void>;
}

export type PlanLogins = Pick<PlanLoginService, "list" | "prepare" | "commit" | "abandon" | "remove" | "trashStore">;

export interface SignInServiceDeps {
  providers: SubscriptionProvider[];
  newId(): string;
  /** Where the sign-ins of multi-login providers are recorded. */
  logins?: PlanLogins;
  /** A credential was saved or removed — account status is stale. */
  onChange?(): void;
  /** A multi-login provider's sign-in succeeded — it can run again. */
  onSignedIn?(provider: string, loginId: string): void;
  keepFinishedMs?: number;
}

interface Entry {
  session: SignInSession;
  flow: SignInFlow | null;
  target: SignInTarget | null;
}

const KEEP_FINISHED_MS = 5 * 60_000;

const isActive = (s: SignInSession): boolean => s.state === "starting" || s.state === "waiting";

export class SignInService {
  private readonly deps: SignInServiceDeps;
  private readonly providers: Map<string, SubscriptionProvider>;
  private readonly sessions = new Map<string, Entry>();

  constructor(deps: SignInServiceDeps) {
    this.deps = deps;
    this.providers = new Map(deps.providers.map((p) => [p.id, p]));
  }

  supports(provider: string): boolean {
    return this.providers.has(provider);
  }

  holdsSeveral(provider: string): boolean {
    return Boolean(this.providers.get(provider)?.multiLogin && this.deps.logins);
  }

  start(provider: string, opts: { loginId?: string } = {}): SignInSession {
    const p = this.provider(provider);
    for (const [id, e] of this.sessions) {
      if (e.session.provider === provider && isActive(e.session)) this.cancel(id);
    }

    const target = this.holdsSeveral(provider) ? this.logins().prepare(provider, opts.loginId) : null;
    const id = this.deps.newId();
    const entry: Entry = {
      session: {
        id, provider, state: "starting", codeEntry: p.acceptsCode ?? false,
        ...(target && !target.fresh ? { loginId: target.loginId } : {}),
      },
      flow: null,
      target,
    };
    this.sessions.set(id, entry);
    try {
      entry.flow = p.startSignIn({
        onUrl: (url) => { if (isActive(entry.session)) entry.session = { ...entry.session, state: "waiting", url }; },
      }, target?.storeDir);
    } catch (e) {
      this.fail(entry, errMsg(e));
      return { ...entry.session };
    }

    entry.flow.result.then(
      async (credential) => {
        if (!isActive(entry.session)) return;
        let replaced: string | null = null;
        try {
          p.saveCredential(credential);
          if (target) {
            const committed = this.logins().commit(target, p.describe?.(target.storeDir) ?? {});
            replaced = committed.replaced;
            entry.target = null;
            this.deps.onSignedIn?.(provider, committed.login.id);
          }
        } catch (e) {
          this.fail(entry, `Couldn't save the sign-in: ${errMsg(e)}`);
          return;
        }
        if (replaced) await this.retire(p, replaced);
        this.finish(entry, { state: "succeeded" });
        this.deps.onChange?.();
      },
      (e) => { if (isActive(entry.session)) this.fail(entry, errMsg(e)); },
    );
    return { ...entry.session };
  }

  get(id: string): SignInSession | null {
    const e = this.sessions.get(id);
    return e ? { ...e.session } : null;
  }

  submitCode(id: string, code: string): boolean {
    const e = this.sessions.get(id);
    if (!e || !isActive(e.session) || !e.flow) return false;
    e.flow.submitCode(code);
    return true;
  }

  cancel(id: string): boolean {
    const e = this.sessions.get(id);
    if (!e || !isActive(e.session)) return false;
    this.finish(e, { state: "cancelled" });
    e.flow?.cancel();
    this.drop(e);
    return true;
  }

  // Signs the provider out of every sign-in it holds.
  async signOut(provider: string): Promise<void> {
    const p = this.provider(provider);
    if (this.holdsSeveral(provider)) {
      for (const login of this.logins().list(provider)) {
        await p.signOut(login.storeDir);
        this.logins().remove(provider, login.id);
      }
    }
    await p.signOut();
    this.deps.onChange?.();
  }

  async removeLogin(provider: string, loginId: string): Promise<void> {
    const p = this.provider(provider);
    const login = this.holdsSeveral(provider) ? this.logins().list(provider).find((l) => l.id === loginId) : undefined;
    // remove() reports the unknown sign-in.
    if (login) await p.signOut(login.storeDir);
    this.logins().remove(provider, loginId);
    this.deps.onChange?.();
  }

  // A fresh sign-in to an account that is already listed replaced that sign-in's
  // store. The new one is in place by then and nothing reads the old one, so a
  // credential left behind there bills nothing — cleaning it up never fails the
  // sign-in.
  private async retire(p: SubscriptionProvider, storeDir: string): Promise<void> {
    try {
      await p.signOut(storeDir);
      this.logins().trashStore(storeDir);
    } catch {
      // Left in place; see above.
    }
  }

  private provider(id: string): SubscriptionProvider {
    const p = this.providers.get(id);
    if (!p) throw new Error(`sign-in is not supported for "${id}"`);
    return p;
  }

  private logins(): PlanLogins {
    if (!this.deps.logins) throw new Error("this daemon keeps no plan sign-ins");
    return this.deps.logins;
  }

  private fail(e: Entry, error: string): void {
    this.finish(e, { state: "failed", error });
    this.drop(e);
  }

  // A sign-in that didn't finish leaves no store behind.
  private drop(e: Entry): void {
    if (!e.target) return;
    this.deps.logins?.abandon(e.target);
    e.target = null;
  }

  private finish(e: Entry, end: Pick<SignInSession, "state" | "error">): void {
    e.session = { ...e.session, ...end };
    const t = setTimeout(() => this.sessions.delete(e.session.id), this.deps.keepFinishedMs ?? KEEP_FINISHED_MS);
    t.unref?.();
  }
}
