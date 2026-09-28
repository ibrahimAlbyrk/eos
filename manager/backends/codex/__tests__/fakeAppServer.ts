// A scripted AppServerClient for the codex lane tests: records requests, answers
// them from per-method handlers, and lets a test push notifications / server
// requests or kill the "process".

import type { AppServerClient } from "../AppServerClient.ts";

type Params = Record<string, unknown>;

export interface FakeAppServer extends AppServerClient {
  requests: Array<{ method: string; params: Params }>;
  notifications: Array<{ method: string; params?: Params }>;
  handlers: Record<string, (params: Params) => unknown>;
  emit(method: string, params: Params): void;
  serverRequest(method: string, params: Params): Promise<unknown>;
  crash(code?: number): void;
  closed: boolean;
}

export function fakeAppServer(handlers: Record<string, (params: Params) => unknown> = {}): FakeAppServer {
  const notificationCbs: Array<(m: string, p: Params) => void> = [];
  const exitCbs: Array<(c: number | null) => void> = [];
  let requestCb: ((m: string, p: Params) => Promise<unknown>) | null = null;
  let alive = true;
  const fake: FakeAppServer = {
    requests: [],
    notifications: [],
    handlers,
    closed: false,
    async request<T>(method: string, params: Params = {}): Promise<T> {
      fake.requests.push({ method, params });
      const h = fake.handlers[method];
      if (!h) return {} as T;
      return (await h(params)) as T;
    },
    notify(method, params) { fake.notifications.push({ method, ...(params ? { params } : {}) }); },
    onNotification(cb) { notificationCbs.push(cb); },
    onRequest(cb) { requestCb = cb; },
    onExit(cb) { exitCbs.push(cb); },
    stderrTail: () => "",
    isAlive: () => alive,
    close() { fake.closed = true; alive = false; },
    emit(method, params) { for (const cb of notificationCbs) cb(method, params); },
    serverRequest(method, params) {
      if (!requestCb) throw new Error("no request handler registered");
      return requestCb(method, params);
    },
    crash(code = 1) { alive = false; for (const cb of exitCbs) cb(code); },
  };
  return fake;
}
