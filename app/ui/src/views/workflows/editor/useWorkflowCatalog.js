// Fetch the node-kind palette catalog once on mount, normalized for the editor.
import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import { normalizeCatalog } from "./catalog.js";

export function useWorkflowCatalog() {
  const [catalog, setCatalog] = useState(() => normalizeCatalog(null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    api
      .getWorkflowCatalog()
      .then((resp) => {
        if (!live) return;
        setCatalog(normalizeCatalog(resp));
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => { live = false; };
  }, []);

  return { catalog, loading, error };
}
