// Pure helpers for "/account <name>": the composer's command that moves the
// selected chat to another Claude sign-in (hooks/useAccountMenu.js).

const PREFIX = "/account ";

// The composer's "/account <name>" → { query } ("" for a bare /account), or
// null when the text isn't the command.
export function parseAccountCommand(text) {
  const m = /^\/account(?:[ \t]+([^\n]*))?$/.exec((text ?? "").trim());
  return m ? { query: (m[1] ?? "").trim() } : null;
}

// While the caret is in the command's argument: what was typed of the name,
// lowercased. null anywhere else.
export function accountArgContext(text, cursorPos) {
  if (!text.startsWith(PREFIX) || text.includes("\n") || cursorPos < PREFIX.length) return null;
  return { query: text.slice(PREFIX.length).trim().toLowerCase() };
}

export function accountCommandText(login) {
  return PREFIX + login.label;
}

const names = (login) => [login.label, login.email].filter(Boolean).map((n) => n.toLowerCase());

const named = (logins, query) => logins.find((l) => names(l).includes(query));

// The sign-ins the menu offers for what was typed: those whose label or email
// contains it. None once it names a sign-in exactly — Enter then sends.
export function matchLogins(logins, query) {
  if (!query) return logins;
  if (named(logins, query)) return [];
  return logins.filter((l) => names(l).some((n) => n.includes(query)));
}

// The one sign-in a typed name means: { login }, or { error } worded for the user.
export function resolveLogin(logins, query) {
  const q = query.trim().toLowerCase();
  if (!q) return { error: "Type an account's name after /account." };
  const exact = named(logins, q);
  if (exact) return { login: exact };
  const found = matchLogins(logins, q);
  if (found.length === 1) return { login: found[0] };
  return { error: found.length ? `Several accounts match "${query}" — type more of the name.` : `No account matches "${query}".` };
}
