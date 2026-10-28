// Plan sign-ins of providers that hold several (Settings › Accounts). Each one
// lives in its own credential store dir; the registry is the non-secret index of
// them plus, per provider, the default one new sessions start on. Pure: every
// change returns a new registry.

export interface PlanLoginRecord {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly email?: string;
  readonly storeDir: string;
  readonly createdAt: string;
}

export interface PlanLoginRegistry {
  // In the order they were added.
  readonly logins: readonly PlanLoginRecord[];
  // provider → default login id.
  readonly defaults: Readonly<Record<string, string>>;
  // provider → move a session to another login when its own runs out (on unless set).
  readonly autoSwitch?: Readonly<Record<string, boolean>>;
}

export const EMPTY_PLAN_LOGINS: PlanLoginRegistry = { logins: [], defaults: {} };

export function loginsOf(reg: PlanLoginRegistry, provider: string): PlanLoginRecord[] {
  return reg.logins.filter((l) => l.provider === provider);
}

// The registry's default, else the oldest — a provider with logins always has one.
export function defaultLoginOf(reg: PlanLoginRegistry, provider: string): PlanLoginRecord | null {
  const logins = loginsOf(reg, provider);
  return logins.find((l) => l.id === reg.defaults[provider]) ?? logins[0] ?? null;
}

// The login a new session starts on — and the one a session moves to when its
// own runs out: the default while it can run, else the oldest one that can.
// null = none can.
export function sessionLoginOf(
  reg: PlanLoginRegistry,
  provider: string,
  usable: (login: PlanLoginRecord) => boolean,
): PlanLoginRecord | null {
  const preferred = defaultLoginOf(reg, provider);
  if (preferred && usable(preferred)) return preferred;
  return loginsOf(reg, provider).find((l) => l !== preferred && usable(l)) ?? null;
}

// The login a session moves to when its own runs out: of the usable ones, the
// one with the most room left (lowest use, unknown counting as none); ties go to
// the default, then the oldest.
export function switchTargetOf(
  reg: PlanLoginRegistry,
  provider: string,
  usable: (login: PlanLoginRecord) => boolean,
  used: (login: PlanLoginRecord) => number | undefined,
): PlanLoginRecord | null {
  const preferred = defaultLoginOf(reg, provider);
  const ranked = loginsOf(reg, provider)
    .filter(usable)
    .map((login, order) => ({ login, order, use: used(login) ?? 0 }))
    .sort((a, b) => a.use - b.use || Number(b.login === preferred) - Number(a.login === preferred) || a.order - b.order);
  return ranked[0]?.login ?? null;
}

export function findLoginByEmail(reg: PlanLoginRegistry, provider: string, email: string): PlanLoginRecord | null {
  const key = email.trim().toLowerCase();
  return loginsOf(reg, provider).find((l) => l.email?.toLowerCase() === key) ?? null;
}

// A provider's first login becomes its default.
export function withLogin(reg: PlanLoginRegistry, login: PlanLoginRecord): PlanLoginRegistry {
  const first = loginsOf(reg, login.provider).length === 0;
  return {
    logins: [...reg.logins, login],
    defaults: first ? { ...reg.defaults, [login.provider]: login.id } : reg.defaults,
  };
}

// Removing the default hands it to the oldest login left.
export function withoutLogin(reg: PlanLoginRegistry, id: string): PlanLoginRegistry {
  const gone = reg.logins.find((l) => l.id === id);
  if (!gone) return reg;
  const logins = reg.logins.filter((l) => l.id !== id);
  if (reg.defaults[gone.provider] !== id) return { logins, defaults: reg.defaults };
  const { [gone.provider]: _old, ...defaults } = reg.defaults;
  const next = logins.find((l) => l.provider === gone.provider);
  return { logins, defaults: next ? { ...defaults, [gone.provider]: next.id } : defaults };
}

export function withLoginPatch(
  reg: PlanLoginRegistry,
  id: string,
  patch: Partial<Pick<PlanLoginRecord, "label" | "email" | "storeDir">>,
): PlanLoginRegistry {
  return { ...reg, logins: reg.logins.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

export function withDefaultLogin(reg: PlanLoginRegistry, provider: string, id: string): PlanLoginRegistry {
  return { ...reg, defaults: { ...reg.defaults, [provider]: id } };
}

export function autoSwitchOf(reg: PlanLoginRegistry, provider: string): boolean {
  return reg.autoSwitch?.[provider] ?? true;
}

export function withAutoSwitch(reg: PlanLoginRegistry, provider: string, enabled: boolean): PlanLoginRegistry {
  return { ...reg, autoSwitch: { ...reg.autoSwitch, [provider]: enabled } };
}

// What a login is called until the user names it: its email, else its place.
export function defaultLoginLabel(email: string | undefined, existing: number): string {
  return email?.trim() || `Account ${existing + 1}`;
}
