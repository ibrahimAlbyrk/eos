import { useEffect, useMemo, useState } from "react";
import { collectPathRefs, resolvePath, withPathChips } from "../lib/pathLinks.js";
import { isFresh, knownStat, statPath } from "../lib/pathStat.js";

// One letter per target: what is known about it on disk ("?" never asked, "-"
// missing, "f"/"d" file/folder) — changes exactly when the drawn chips would.
const signature = (targets) =>
  targets.map((t) => {
    const s = knownStat(t.abs);
    return s === undefined ? "?" : s ? s.type[0] : "-";
  }).join("");

// Rendered prose with the paths it names drawn as chips (lib/pathLinks.js):
// each is resolved against the agent's folder and checked on disk, and only the
// ones that exist become chips. What is already known draws at once; a fresh
// check re-renders only when an answer changed.
export function usePathChips(html, cwd, { plainText = true, shorten = true, title = false } = {}) {
  const targets = useMemo(
    () => collectPathRefs(html, { plainText })
      .map((r) => ({ written: r.path, abs: resolvePath(r.path, cwd) }))
      .filter((t) => t.abs),
    [html, cwd, plainText],
  );

  const [, setTick] = useState(0);
  useEffect(() => {
    const stale = targets.filter((t) => !isFresh(t.abs));
    if (stale.length === 0) return;
    let live = true;
    const before = signature(stale);
    Promise.all(stale.map((t) => statPath(t.abs))).then(() => {
      if (live && signature(stale) !== before) setTick((n) => n + 1);
    });
    return () => { live = false; };
  }, [targets]);

  const known = signature(targets);
  return useMemo(() => {
    if (targets.length === 0) return html;
    const absOf = new Map(targets.map((t) => [t.written, t.abs]));
    const lookup = (written) => {
      const abs = absOf.get(written);
      const stat = abs ? knownStat(abs) : undefined;
      if (stat === undefined) return null;
      return stat ? { abs, type: stat.type } : { abs, missing: true };
    };
    return withPathChips(html, lookup, { cwd, shorten, title, plainText });
    // `known` stands in for the stat answers the lookup reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, targets, known, cwd, shorten, title, plainText]);
}
