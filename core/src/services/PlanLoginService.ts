// PlanLoginService — the one write path for a provider's plan sign-ins
// (Settings › Accounts). A sign-in writes into a store dir prepared here: a fresh
// one to add a login, the login's own to renew it. Once it succeeds, commit()
// records it — a fresh sign-in to an account that is already listed (same email)
// takes that login's place, and the store it replaced is handed back so the
// caller can sign it out before it is trashed.

import { NotFoundError } from "../errors/index.ts";
import type { Clock } from "../ports/Clock.ts";
import type { PlanLoginDirs, PlanLoginStore } from "../ports/PlanLoginStore.ts";
import type { LoginReadiness } from "./PlanLimitLedger.ts";
import {
  type PlanLoginRecord, type PlanLoginRegistry,
  autoSwitchOf, defaultLoginLabel, defaultLoginOf, findLoginByEmail, loginsOf, sessionLoginOf, switchTargetOf,
  withAutoSwitch, withDefaultLogin, withLogin, withLoginPatch, withoutLogin,
} from "../domain/plan-logins.ts";

export interface PlanLoginServiceDeps {
  readonly store: PlanLoginStore;
  readonly dirs: PlanLoginDirs;
  readonly clock: Clock;
  newId(): string;
}

// Where a sign-in in flight writes: a new login's fresh store, or the store of
// the login it renews.
export interface SignInTarget {
  readonly provider: string;
  readonly loginId: string;
  readonly storeDir: string;
  readonly fresh: boolean;
}

// What the spawn path and the Accounts list read — nothing that writes.
export interface PlanLoginReader {
  list(provider: string): PlanLoginRecord[];
  defaultId(provider: string): string | null;
  sessionLogin(provider: string, usable: (login: PlanLoginRecord) => boolean): PlanLoginRecord | null;
  runnableLogin(provider: string, readiness: (login: PlanLoginRecord) => LoginReadiness): PlanLoginRecord | null;
  switchTarget(
    provider: string,
    usable: (login: PlanLoginRecord) => boolean,
    used: (login: PlanLoginRecord) => number | undefined,
  ): PlanLoginRecord | null;
  autoSwitch(provider: string): boolean;
}

export class PlanLoginService implements PlanLoginReader {
  private readonly deps: PlanLoginServiceDeps;
  private reg: PlanLoginRegistry;

  constructor(deps: PlanLoginServiceDeps) {
    this.deps = deps;
    this.reg = deps.store.load();
  }

  list(provider: string): PlanLoginRecord[] {
    return loginsOf(this.reg, provider);
  }

  defaultId(provider: string): string | null {
    return defaultLoginOf(this.reg, provider)?.id ?? null;
  }

  sessionLogin(provider: string, usable: (login: PlanLoginRecord) => boolean): PlanLoginRecord | null {
    return sessionLoginOf(this.reg, provider, usable);
  }

  // The login new sessions run on: a ready one, picked as sessionLogin picks;
  // when every login is at its limit, one of those — its turn then meets the
  // limit like any other. null = none is signed in.
  runnableLogin(provider: string, readiness: (login: PlanLoginRecord) => LoginReadiness): PlanLoginRecord | null {
    const known = new Map(this.list(provider).map((l) => [l.id, readiness(l)]));
    return this.sessionLogin(provider, (l) => known.get(l.id) === "ready")
      ?? this.sessionLogin(provider, (l) => known.get(l.id) === "limited");
  }

  switchTarget(
    provider: string,
    usable: (login: PlanLoginRecord) => boolean,
    used: (login: PlanLoginRecord) => number | undefined,
  ): PlanLoginRecord | null {
    return switchTargetOf(this.reg, provider, usable, used);
  }

  autoSwitch(provider: string): boolean {
    return autoSwitchOf(this.reg, provider);
  }

  setAutoSwitch(provider: string, enabled: boolean): void {
    this.save(withAutoSwitch(this.reg, provider, enabled));
  }

  prepare(provider: string, loginId?: string): SignInTarget {
    if (loginId) {
      const login = this.get(provider, loginId);
      return { provider, loginId, storeDir: login.storeDir, fresh: false };
    }
    const id = this.deps.newId();
    return { provider, loginId: id, storeDir: this.deps.dirs.create(provider, id), fresh: true };
  }

  commit(target: SignInTarget, info: { email?: string }): { login: PlanLoginRecord; replaced: string | null } {
    const email = info.email?.trim() || undefined;
    if (!target.fresh) {
      if (email) this.save(withLoginPatch(this.reg, target.loginId, { email }));
      return { login: this.get(target.provider, target.loginId), replaced: null };
    }
    const same = email ? findLoginByEmail(this.reg, target.provider, email) : null;
    if (same) {
      this.save(withLoginPatch(this.reg, same.id, { storeDir: target.storeDir }));
      return { login: this.get(target.provider, same.id), replaced: same.storeDir };
    }
    return { login: this.add(target.provider, target.loginId, target.storeDir, email), replaced: null };
  }

  // A sign-in that didn't finish leaves nothing behind.
  abandon(target: SignInTarget): void {
    if (target.fresh) this.deps.dirs.discard(target.storeDir);
  }

  // The caller signs the login out of its store first.
  remove(provider: string, id: string): PlanLoginRecord {
    const login = this.get(provider, id);
    this.save(withoutLogin(this.reg, id));
    this.deps.dirs.trash(login.storeDir);
    return login;
  }

  rename(provider: string, id: string, label: string): PlanLoginRecord {
    this.get(provider, id);
    this.save(withLoginPatch(this.reg, id, { label: label.trim() }));
    return this.get(provider, id);
  }

  setDefault(provider: string, id: string): void {
    this.get(provider, id);
    this.save(withDefaultLogin(this.reg, provider, id));
  }

  // A store that replaced another (commit's `replaced`), once signed out.
  trashStore(storeDir: string): void {
    this.deps.dirs.trash(storeDir);
  }

  // The provider's sign-in from before it could hold several becomes its first
  // login, in place — its store (and the credential keyed to that dir) stays put.
  adopt(provider: string, storeDir: string, email?: string): PlanLoginRecord | null {
    if (this.list(provider).length > 0) return null;
    return this.add(provider, this.deps.newId(), storeDir, email?.trim() || undefined);
  }

  private add(provider: string, id: string, storeDir: string, email: string | undefined): PlanLoginRecord {
    const login: PlanLoginRecord = {
      id,
      provider,
      label: defaultLoginLabel(email, this.list(provider).length),
      ...(email ? { email } : {}),
      storeDir,
      createdAt: new Date(this.deps.clock.now()).toISOString(),
    };
    this.save(withLogin(this.reg, login));
    return login;
  }

  private get(provider: string, id: string): PlanLoginRecord {
    const login = this.reg.logins.find((l) => l.id === id && l.provider === provider);
    if (!login) throw new NotFoundError("sign-in", id);
    return login;
  }

  private save(reg: PlanLoginRegistry): void {
    this.deps.store.save(reg);
    this.reg = reg;
  }
}
