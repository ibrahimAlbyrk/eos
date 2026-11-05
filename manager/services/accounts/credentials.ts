// Credentials (Settings › Accounts / Usage): every sign-in Eos made, the store a
// new claude run uses, the CLI homes the Codex and Gemini lanes run with, plan
// usage and the sign-in flows — built in one place. Only sign-ins made through
// Eos count: each CLI Eos runs keeps its login under ~/.eos/accounts, never the
// one a Claude Code / Codex / Gemini CLI install on this Mac uses. Every claude
// child Eos runs (agents, summarizer, Code-view panes, sign-in) gets the Eos
// store; a plain terminal pane stays the user's own shell.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import type { DaemonConfig } from "../../shared/config.ts";
import { errMsg } from "../../../contracts/src/util.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { SubscriptionUsageProvider } from "../../../core/src/ports/SubscriptionUsageProvider.ts";
import type { PlanLoginRecord } from "../../../core/src/domain/plan-logins.ts";
import { PlanLoginService } from "../../../core/src/services/PlanLoginService.ts";
import { PlanLimitLedger } from "../../../core/src/services/PlanLimitLedger.ts";
import { buildSubscriptionChildEnv } from "../../../core/src/domain/env-allowlist.ts";
import { readClaudeCodeLogin, readClaudeAccountEmail, clearClaudeLogin, CLAUDE_STORE_ENV, type ClaudeCodeLogin } from "../../../infra/src/auth/SubscriptionAuthResolver.ts";
import { createClaudeLoginRefresher } from "../../../infra/src/auth/ClaudeLoginRefresher.ts";
import { createPlanLoginDirs } from "../../../infra/src/auth/planLoginDirs.ts";
import { FilePlanLoginStore } from "../../../infra/src/persistence/FilePlanLoginStore.ts";
import { probeClaudeToken } from "../../../infra/src/auth/claudeTokenProbe.ts";
import { readCodexLogin } from "../../../infra/src/auth/codexLogin.ts";
import { readGeminiLogin, clearGeminiLogin, geminiHome } from "../../../infra/src/auth/geminiLogin.ts";
import { createClaudeUsageProvider } from "../../../infra/src/usage/ClaudeUsageProvider.ts";
import { createFileUsageSnapshotStore } from "../../../infra/src/usage/FileUsageSnapshotStore.ts";
import { appendToPath } from "../../../infra/src/util/path-env.ts";
import { spawnPtyHost } from "../../../spawner/pty-host.ts";
import { resolveCodexBinary } from "../../backends/codex/codexBinary.ts";
import { openAppServer } from "../../backends/codex/AppServerClient.ts";
import { createCodexUsageProvider } from "../../backends/codex/CodexUsageProvider.ts";
import { resolveCliBinary } from "../../backends/cliBinary.ts";
import { openAcpAgent } from "../../backends/gemini/AcpClient.ts";
import { patchAnthropicConfig } from "../../shared/anthropic-config.ts";
import { PROVIDER_PRESETS } from "../../shared/provider-presets.ts";
import { UsageService } from "../UsageService.ts";
import { AccountsService } from "./AccountsService.ts";
import { SignInService } from "./SignInService.ts";
import { createClaudeSubscription } from "./claudeSubscription.ts";
import { createCodexSubscription } from "./codexSubscription.ts";
import { createGeminiSubscription } from "./geminiSubscription.ts";

type Env = Record<string, string | undefined>;

export interface CredentialsDeps {
  // ~/.eos
  readonly home: string;
  // Read live: a Settings write is picked up without a restart.
  readonly config: () => DaemonConfig;
  readonly reloadConfig: () => void;
  readonly clock: Clock;
  readonly bus: EventBus;
  readonly log: Logger;
}

export type Credentials = ReturnType<typeof createCredentials>;

export function createCredentials(deps: CredentialsDeps) {
  const { config, clock, bus, log } = deps;
  const accountsDir = join(deps.home, "accounts");
  const claudeStoreDir = join(accountsDir, "claude");
  const codexHomeDir = join(accountsDir, "codex");
  const geminiCliHome = join(accountsDir, "gemini");
  for (const dir of [claudeStoreDir, codexHomeDir, geminiCliHome]) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Claude holds several sign-ins, each in its own store; the one Claude had
  // before (accounts/claude) becomes the first, in place.
  const logins = new PlanLoginService({
    store: new FilePlanLoginStore(join(accountsDir, "logins.json")),
    dirs: createPlanLoginDirs(accountsDir),
    clock,
    newId: () => `lg-${randomBytes(6).toString("hex")}`,
  });
  if (readClaudeCodeLogin(claudeStoreDir).present) logins.adopt("anthropic", claudeStoreDir, readClaudeAccountEmail(claudeStoreDir));
  // Sign-ins that hit their plan limit or stopped working mid-turn (in memory).
  const ledger = new PlanLimitLedger(clock);
  const signedIn = (l: PlanLoginRecord): boolean => readClaudeCodeLogin(l.storeDir).present;
  const apiKeySet = (): boolean => Boolean(config().anthropic?.apiKey?.trim());
  // The store every new claude run uses: the default sign-in while it can run,
  // else the oldest one that can — with every one at its limit, one of those.
  const claudeStore = (): string =>
    logins.runnableLogin("anthropic", (l) => ledger.readiness(l.id, signedIn(l)))?.storeDir ?? claudeStoreDir;
  const readEosClaudeLogin = (): ClaudeCodeLogin => readClaudeCodeLogin(claudeStore());
  const claudeLoginOf = (loginId: string): PlanLoginRecord | undefined =>
    logins.list("anthropic").find((l) => l.id === loginId);

  const claudeBinary = resolveCliBinary({ name: "claude", overrideVar: "EOS_CLAUDE_BIN" });
  // Terminals that run `claude` (sign-in, Code-view) find the one Eos runs agents
  // with when the user has none on PATH — on Windows Eos ships its own.
  const withEosClaude = (env: Env): Env => (claudeBinary ? appendToPath(env, dirname(claudeBinary)) : env);

  // The Codex CLI (the user's own install) backs both Sign in with ChatGPT and the
  // codex-cli lane. Its app-server never sees an OpenAI API key, so a signed-in
  // ChatGPT plan is what it bills — the Accounts rule.
  const codexBinary = resolveCodexBinary();
  const codexEnv = (): Env => {
    const { OPENAI_API_KEY: _apiKey, CODEX_API_KEY: _codexKey, ...env } = process.env;
    return { ...env, CODEX_HOME: codexHomeDir };
  };
  // Likewise the Gemini CLI backs Sign in with Google and the gemini-cli lane,
  // never seeing a Gemini API key. Its launcher is a `#!/usr/bin/env node` script,
  // so its own install dir (where npm / Homebrew keep node) leads PATH — the
  // daemon may run with a launchd-minimal one.
  const geminiBinary = resolveCliBinary({ name: "gemini", overrideVar: "EOS_GEMINI_BIN" });
  const geminiEnv = (): Env => {
    const { GEMINI_API_KEY: _geminiKey, GOOGLE_API_KEY: _googleKey, ...rest } = process.env;
    const env: Env = { ...rest, GEMINI_CLI_HOME: geminiCliHome };
    return geminiBinary ? { ...env, PATH: [dirname(geminiBinary), env.PATH].filter(Boolean).join(delimiter) } : env;
  };
  const geminiDir = geminiHome(geminiCliHome);

  // A Claude store's OAuth access token, for Eos's own reads on that sign-in's
  // behalf (usage, artifacts) — renewed first when it lapsed while no session ran.
  const claudeRefresher = claudeBinary ? createClaudeLoginRefresher({ binary: claudeBinary }) : null;
  const claudeAccessToken = async (store: string): Promise<string | null> => {
    let login = readClaudeCodeLogin(store);
    if (login.present && !login.token && claudeRefresher) {
      await claudeRefresher.renew(store)
        .catch((e) => log.warn("claude login refresh failed", { error: errMsg(e) }));
      login = readClaudeCodeLogin(store);
    }
    return login.token;
  };

  // Subscription usage (Settings › Usage), from the Eos sign-ins only. The
  // UsageService owns the cache + 180s upstream floor and pushes each refresh
  // (usage:change); the last good snapshots live in ~/.eos/usage-cache.json
  // (regenerable).
  const planTitle = (plan: string | undefined) => (plan ? `${plan[0].toUpperCase()}${plan.slice(1)}` : undefined);
  // One usage provider per Claude sign-in, kept per login so each remembers the
  // token source that worked. With no sign-ins, the one provider reads the legacy
  // setup-token, which the endpoint rejects for scope (the UI turns that into
  // "sign in again").
  const claudeUsageByLogin = new Map<string, SubscriptionUsageProvider>();
  const claudeUsageOf = (l: PlanLoginRecord): SubscriptionUsageProvider => {
    let p = claudeUsageByLogin.get(l.id);
    if (!p) {
      p = createClaudeUsageProvider({
        getTokens: async () => {
          const token = await claudeAccessToken(l.storeDir);
          return token ? [{ source: "eos", token }] : [];
        },
        plan: () => planTitle(readClaudeCodeLogin(l.storeDir).plan),
        login: () => ({ id: l.id, label: claudeLoginOf(l.id)?.label ?? l.label }),
      });
      claudeUsageByLogin.set(l.id, p);
    }
    return p;
  };
  const legacyClaudeUsage = createClaudeUsageProvider({
    getTokens: () => {
      const legacy = config().anthropic?.authToken?.trim();
      return legacy ? [{ source: "config", token: legacy }] : [];
    },
  });
  // ChatGPT plan limits, read through the Codex app-server while signed in.
  const codexUsage = createCodexUsageProvider({ binary: codexBinary, env: codexEnv, signedIn: () => readCodexLogin(codexEnv()).present, open: openAppServer });
  const usage = new UsageService({
    providers: () => {
      const list = logins.list("anthropic");
      return [...(list.length ? list.map(claudeUsageOf) : [legacyClaudeUsage]), codexUsage];
    },
    clock,
    store: createFileUsageSnapshotStore(join(deps.home, "usage-cache.json")),
    onChange: (res) => bus.publish("usage:change", res),
  });
  // How much of its 5-hour window a sign-in has used, from the last snapshot (a
  // window whose reset passed has rolled over).
  const used = (l: PlanLoginRecord): number | undefined => {
    const w = usage.peek().find((u) => u.loginId === l.id)?.windows.fiveHour;
    if (!w) return undefined;
    return w.resetsAt && Date.parse(w.resetsAt) <= Date.now() ? 0 : w.utilization;
  };
  // How much of its plan the sign-in a new run would use has spent (the larger
  // of its 5-hour and weekly windows, 0–1), or null when unknown.
  const claudeUtilization = async (): Promise<number | null> => {
    const loginId = logins.list("anthropic").find((l) => l.storeDir === claudeStore())?.id;
    const claude = (await usage.getUsage()).providers.find((p) => p.provider === "claude" && p.loginId === loginId);
    const spent = [claude?.windows.fiveHour?.utilization, claude?.windows.sevenDay?.utilization]
      .filter((n): n is number => typeof n === "number");
    return spent.length ? Math.max(...spent) / 100 : null;
  };

  // Live claude sessions → the store their latest launch runs on.
  const liveClaudeStores = new Map<string, string>();
  const noteLaunch = (workerId: string, storeDir: string | null): void => {
    if (storeDir) liveClaudeStores.set(workerId, storeDir);
    else liveClaudeStores.delete(workerId);
  };
  const loginOfWorker = (workerId: string): string | undefined => {
    const store = liveClaudeStores.get(workerId);
    return store ? logins.list("anthropic").find((l) => l.storeDir === store)?.id : undefined;
  };

  // Sign in with Claude runs the official `claude auth login` (a one-shot PTY
  // with the billing-stripped env, so no ambient key or nested-session marker
  // reaches it) into the Eos store; CLAUDE_CONFIG_DIR keeps its account
  // bookkeeping out of the user's ~/.claude.json. Sign in with ChatGPT is the
  // Codex app-server's own login, Sign in with Google the Gemini CLI's — each
  // under its Eos home (codexEnv / geminiEnv).
  const planLogins: Record<string, () => { present: boolean; plan?: string; source: "eos" }> = {
    openai: () => ({ ...readCodexLogin(codexEnv()), source: "eos" }),
    gemini: () => ({ ...readGeminiLogin(geminiDir), source: "eos" }),
  };
  const accounts = new AccountsService({
    getConfig: config,
    claudeLogins: logins,
    claudeLimits: ledger,
    sessionsOn: (storeDir) => [...liveClaudeStores.values()].filter((d) => d === storeDir).length,
    readClaudeLogin: readClaudeCodeLogin,
    probe: (token) => probeClaudeToken(token),
    presets: PROVIDER_PRESETS,
    supportsSignIn: (provider) => signIns.supports(provider),
    presetLogin: (provider) => planLogins[provider]?.() ?? null,
  });
  const signIns = new SignInService({
    providers: [
      createClaudeSubscription({
        spawnPty: spawnPtyHost,
        cwd: homedir(),
        env: (storeDir) => withEosClaude({ ...buildSubscriptionChildEnv(process.env), [CLAUDE_STORE_ENV]: storeDir, CLAUDE_CONFIG_DIR: storeDir }),
        clearLegacyToken: () => {
          patchAnthropicConfig(deps.home, { authToken: "" });
          deps.reloadConfig();
        },
        clearLogin: clearClaudeLogin,
        describe: (storeDir) => ({ email: readClaudeAccountEmail(storeDir) }),
      }),
      ...(codexBinary
        ? [createCodexSubscription({
            binary: codexBinary,
            env: codexEnv,
            open: openAppServer,
          })]
        : []),
      ...(geminiBinary
        ? [createGeminiSubscription({ binary: geminiBinary, env: geminiEnv, open: openAcpAgent, clearLogin: () => clearGeminiLogin(geminiDir) })]
        : []),
    ],
    newId: () => randomBytes(8).toString("hex"),
    logins,
    onSignedIn: (_provider, loginId) => ledger.clear(loginId),
    onChange: () => {
      accounts.invalidate();
      usage.invalidate();
    },
  });

  return {
    logins,
    ledger,
    // What moving a session to another Claude sign-in reads.
    plan: { logins, ledger, signedIn, apiKeySet, used },
    claudeStore,
    readEosClaudeLogin,
    claudeBinary,
    withEosClaude,
    claudeLoginOf,
    claudeAccessToken,
    claudeRefresher,
    claudeUtilization,
    codexBinary,
    codexEnv,
    geminiBinary,
    geminiEnv,
    noteLaunch,
    loginOfWorker,
    usage,
    accounts,
    signIns,
  };
}
