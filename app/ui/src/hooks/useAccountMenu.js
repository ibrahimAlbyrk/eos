import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { useAccounts, ensureAccountsLoaded } from "../state/accountsStore.js";
import { accountArgContext, matchLogins, parseAccountCommand, resolveLogin } from "../lib/accountCommand.js";

const CLAUDE = "anthropic";
const NONE = [];

// "/account <name>" in the composer: the Claude sign-ins to pick from while
// the name is typed, which of them the chat runs on, and the move itself.
export function useAccountMenu({ text, cursorPos, workerId }) {
  const { accounts } = useAccounts();
  const logins = accounts?.find((a) => a.id === CLAUDE)?.logins ?? NONE;
  const ctx = useMemo(() => accountArgContext(text, cursorPos), [text, cursorPos]);
  const open = Boolean(ctx);
  const [current, setCurrent] = useState(null);

  // Read each time the menu opens: an automatic switch may have moved the chat.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    ensureAccountsLoaded();
    setCurrent(null);
    if (workerId) {
      api.getWorkerAccount(workerId)
        .then((r) => { if (!cancelled) setCurrent(r?.body?.loginId ?? null); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [open, workerId]);

  const results = useMemo(() => (ctx ? matchLogins(logins, ctx.query) : NONE), [logins, ctx]);

  // Runs the typed command: null when the text is not one, else { ok } or
  // { ok: false, error } worded for the user.
  const run = async (typed) => {
    const command = parseAccountCommand(typed);
    if (!command) return null;
    if (!workerId) return { ok: false, error: "Open a chat first — /account moves the chat you are in." };
    await ensureAccountsLoaded();
    const { login, error } = resolveLogin(logins, command.query);
    if (!login) return { ok: false, error };
    const r = await api.setWorkerAccount(workerId, login.id).catch(() => null);
    if (r?.ok) return { ok: true };
    return { ok: false, error: r?.body?.error ?? "Couldn't change the account." };
  };

  return { ctx, results, current, run };
}
