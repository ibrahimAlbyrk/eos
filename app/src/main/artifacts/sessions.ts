import { BrowserWindow, session as electronSession } from "electron";
import type { Session } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// claude.ai web sessions for artifact views, one Electron partition per Eos
// Claude sign-in: an artifact opens only for its owner, so each sign-in's
// artifacts render in a claude.ai session signed in as that account. These are
// Eos's own partitions — nothing comes from the user's browsers — and Eos never
// reads their cookies beyond checking that `sessionKey` exists.
//
// The single partition the old hover preview used is adopted by the sign-in
// whose email it is signed in as; <userData>/artifact-sessions.json records
// which partition each sign-in uses.

export const LEGACY_PARTITION = "persist:eos-claude";
const ACCOUNT_URL = "https://claude.ai/api/account";
const LOGIN_URL = "https://claude.ai/login";
const EMAIL_TTL_MS = 10 * 60_000;
const EMAIL_RETRY_MS = 60_000;
const CLAUDE_HOSTS = new Set(["claude.ai", "preview.claude.ai"]);
const SIGNIN_PATH = /^\/(?:login|logout|magic-link)(?:\/|$)/;

export interface AccountStatus {
  signedIn: boolean;
  email?: string;
}

export function partitionForLogin(loginId: string | null): string {
  return loginId ? `persist:eos-claude-${loginId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)}` : LEGACY_PARTITION;
}

interface Deps {
  file: string;
  parent: () => BrowserWindow | null;
}

export class ClaudeSessions {
  private readonly deps: Deps;
  private map: Record<string, string>;
  private saving: Promise<void> = Promise.resolve();
  private readonly configured = new Set<string>();
  private readonly emails = new Map<string, { email: string | null; at: number }>();
  private readonly logins = new Map<string, { win: BrowserWindow; done: Promise<boolean> }>();
  // Set by the view host: a partition just signed in / out, or a sign-in moved to another partition.
  onSignedIn: ((partition: string) => void) | null = null;
  onSignedOut: ((partition: string) => void) | null = null;
  onRelinked: ((loginId: string) => void) | null = null;

  constructor(deps: Deps) {
    this.deps = deps;
    this.map = readMap(deps.file);
  }

  partitionFor(loginId: string | null): string {
    if (!loginId) return LEGACY_PARTITION;
    return this.map[loginId] ?? partitionForLogin(loginId);
  }

  // The partition's session, configured once: every permission denied except
  // writing to the clipboard (an artifact's own Copy button). Electron grants
  // every permission when a session has no handler. Geolocation falls under the
  // deny-all, so permissions.ts denyGeolocation (whose handlers would replace
  // these) isn't layered on top.
  session(partition: string): Session {
    const ses = electronSession.fromPartition(partition);
    if (!this.configured.has(partition)) {
      this.configured.add(partition);
      ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "clipboard-sanitized-write"));
      ses.setPermissionCheckHandler((_wc, permission) => permission === "clipboard-sanitized-write");
    }
    return ses;
  }

  async signedIn(partition: string): Promise<boolean> {
    try {
      const cookies = await this.session(partition).cookies.get({ domain: "claude.ai", name: "sessionKey" });
      return cookies.some((c) => c.value !== "");
    } catch {
      return false;
    }
  }

  async account(loginId: string | null, expectedEmail?: string): Promise<AccountStatus> {
    if (loginId && expectedEmail) await this.adopt(loginId, expectedEmail);
    const partition = this.partitionFor(loginId);
    if (!(await this.signedIn(partition))) return { signedIn: false };
    const email = await this.email(partition);
    return email ? { signedIn: true, email } : { signedIn: true };
  }

  async signIn(loginId: string | null, expectedEmail?: string): Promise<AccountStatus> {
    if (loginId && expectedEmail) await this.adopt(loginId, expectedEmail);
    const partition = this.partitionFor(loginId);
    if (await this.openLogin(partition)) {
      this.emails.delete(partition);
      if (loginId && !this.map[loginId]) this.record(loginId, partition);
      this.onSignedIn?.(partition);
    }
    return this.account(loginId, expectedEmail);
  }

  async signOut(loginId: string | null): Promise<void> {
    const partition = this.partitionFor(loginId);
    try {
      await this.session(partition).clearStorageData();
    } catch (e) {
      console.error("[eos-artifacts] sign-out failed:", e instanceof Error ? e.message : String(e));
    }
    this.emails.delete(partition);
    this.onSignedOut?.(partition);
  }

  // The legacy partition becomes this sign-in's when it is signed in to
  // claude.ai as the same email, no other sign-in took it, and this sign-in's
  // own partition isn't signed in already.
  private async adopt(loginId: string, expectedEmail: string): Promise<void> {
    const taken = (): boolean => Boolean(this.map[loginId]) || Object.values(this.map).includes(LEGACY_PARTITION);
    if (taken()) return;
    if (await this.signedIn(partitionForLogin(loginId))) return;
    if (!(await this.signedIn(LEGACY_PARTITION))) return;
    const email = await this.email(LEGACY_PARTITION);
    if (!email || email.toLowerCase() !== expectedEmail.trim().toLowerCase()) return;
    if (taken()) return; // another call adopted it meanwhile
    this.record(loginId, LEGACY_PARTITION);
    this.onRelinked?.(loginId);
  }

  private record(loginId: string, partition: string): void {
    this.map = { ...this.map, [loginId]: partition };
    const body = JSON.stringify(this.map, null, 2);
    const file = this.deps.file;
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, body);
        await rename(tmp, file);
      } catch (e) {
        console.error("[eos-artifacts] artifact-sessions.json write failed:", e instanceof Error ? e.message : String(e));
      }
    });
  }

  private async email(partition: string): Promise<string | null> {
    const hit = this.emails.get(partition);
    if (hit && Date.now() - hit.at < (hit.email ? EMAIL_TTL_MS : EMAIL_RETRY_MS)) return hit.email;
    let email: string | null = null;
    try {
      const res = await this.session(partition).fetch(ACCOUNT_URL, {
        credentials: "include",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown> | null;
        const value = body?.email_address ?? body?.email;
        if (typeof value === "string" && value.includes("@")) email = value;
      }
    } catch {
      // unknown — adoption waits, the account shows without an email
    }
    this.emails.set(partition, { email, at: Date.now() });
    return email;
  }

  // A visible window on claude.ai's login in this partition; resolves once the
  // session holds a sign-in cookie and has left the login pages (a stale cookie
  // alone isn't a sign-in), or when the user closes it. One per partition.
  private openLogin(partition: string): Promise<boolean> {
    const open = this.logins.get(partition);
    if (open && !open.win.isDestroyed()) {
      open.win.focus();
      return open.done;
    }
    const parent = this.deps.parent();
    const win = new BrowserWindow({
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      width: 460,
      height: 720,
      resizable: true,
      title: "Sign in to claude.ai",
      webPreferences: { session: this.session(partition), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    void win.loadURL(LOGIN_URL).catch(() => {});
    const done = new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        this.logins.delete(partition);
        if (ok && !win.isDestroyed()) win.close();
        resolve(ok);
      };
      const timer = setInterval(() => {
        if (win.isDestroyed()) return;
        const url = win.webContents.getURL();
        void this.signedIn(partition).then((ok) => {
          if (ok && !win.isDestroyed() && !onSignInPage(url)) finish(true);
        });
      }, 1000);
      win.on("closed", () => void this.signedIn(partition).then(finish));
    });
    this.logins.set(partition, { win, done });
    return done;
  }
}

function onSignInPage(url: string): boolean {
  try {
    const u = new URL(url);
    return !CLAUDE_HOSTS.has(u.hostname) || SIGNIN_PATH.test(u.pathname);
  } catch {
    return true;
  }
}

function readMap(file: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [loginId, partition] of Object.entries(parsed)) {
      if (typeof partition === "string" && partition.startsWith(LEGACY_PARTITION)) out[loginId] = partition;
    }
    return out;
  } catch {
    return {};
  }
}
