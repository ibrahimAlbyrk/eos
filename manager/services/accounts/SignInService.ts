// SignInService — browser sign-ins in flight, at most one per provider. A
// SubscriptionProvider knows how to run its provider's official sign-in and where
// the credential it yields lives; this service owns only the session lifecycle
// the UI polls: starting → waiting (sign-in page open) → succeeded | failed |
// cancelled. Finished sessions linger briefly so a late poll still sees the end.

import type { SignInSession } from "../../../contracts/src/accounts.ts";
import { errMsg } from "../../../contracts/src/util.ts";

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
  startSignIn(handlers: { onUrl(url: string): void }): SignInFlow;
  saveCredential(credential: string): void;
  signOut(): void | Promise<void>;
}

export interface SignInServiceDeps {
  providers: SubscriptionProvider[];
  newId(): string;
  /** A credential was saved or removed — account status is stale. */
  onChange?(): void;
  keepFinishedMs?: number;
}

interface Entry {
  session: SignInSession;
  flow: SignInFlow | null;
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

  start(provider: string): SignInSession {
    const p = this.providers.get(provider);
    if (!p) throw new Error(`sign-in is not supported for "${provider}"`);
    for (const [id, e] of this.sessions) {
      if (e.session.provider === provider && isActive(e.session)) this.cancel(id);
    }

    const id = this.deps.newId();
    const entry: Entry = { session: { id, provider, state: "starting", codeEntry: p.acceptsCode ?? false }, flow: null };
    this.sessions.set(id, entry);
    try {
      entry.flow = p.startSignIn({
        onUrl: (url) => { if (isActive(entry.session)) entry.session = { ...entry.session, state: "waiting", url }; },
      });
    } catch (e) {
      this.finish(entry, { state: "failed", error: errMsg(e) });
      return { ...entry.session };
    }

    entry.flow.result.then(
      (credential) => {
        if (!isActive(entry.session)) return;
        try {
          p.saveCredential(credential);
        } catch (e) {
          this.finish(entry, { state: "failed", error: `Couldn't save the sign-in: ${errMsg(e)}` });
          return;
        }
        this.finish(entry, { state: "succeeded" });
        this.deps.onChange?.();
      },
      (e) => { if (isActive(entry.session)) this.finish(entry, { state: "failed", error: errMsg(e) }); },
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
    return true;
  }

  async signOut(provider: string): Promise<void> {
    const p = this.providers.get(provider);
    if (!p) throw new Error(`sign-in is not supported for "${provider}"`);
    await p.signOut();
    this.deps.onChange?.();
  }

  private finish(e: Entry, end: Pick<SignInSession, "state" | "error">): void {
    e.session = { ...e.session, ...end };
    const t = setTimeout(() => this.sessions.delete(e.session.id), this.deps.keepFinishedMs ?? KEEP_FINISHED_MS);
    t.unref?.();
  }
}
