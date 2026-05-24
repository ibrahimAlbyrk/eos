import { useEffect, useState } from "react";
import { api } from "../api/client.js";

export function useCommands(cwd) {
  const [commands, setCommands] = useState([]);

  useEffect(() => {
    let cancelled = false;
    api.listCommands(cwd).then((r) => {
      if (!cancelled) setCommands(r.commands ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [cwd]);

  return commands;
}
