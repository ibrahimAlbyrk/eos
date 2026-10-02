import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { subscribeGitChange, BRANCH_KINDS } from "../state/gitChangeBus.js";

const EMPTY = { list: [], names: new Set(), current: null };

// Local branches of `cwd`'s repo for `#branch` completion. Fetched eagerly (not
// on the first `#`) because a restored draft's `#refs` need the names to color;
// kept live by the git-change bus so a new/deleted branch shows up at once.
export function useBranchNames(cwd) {
  const [branches, setBranches] = useState(EMPTY);
  useEffect(() => {
    setBranches(EMPTY);
    if (!cwd) return undefined;
    let cancelled = false;
    const refresh = () => {
      api.listBranches(cwd).then((r) => {
        if (cancelled) return;
        const list = r.branches ?? [];
        setBranches({ list, names: new Set(list), current: r.current ?? null });
      }).catch(() => {});
    };
    refresh();
    const unsubscribe = subscribeGitChange(cwd, BRANCH_KINDS, refresh);
    return () => { cancelled = true; unsubscribe(); };
  }, [cwd]);
  return branches;
}
