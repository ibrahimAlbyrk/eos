// Fetch the catalogs the typed inspector's selectors read: worker-definition
// names (the worker `from` + expert `from` selectors) and workflow-definition
// names (the subGraph target selector). Both degrade to [] so a partial daemon
// never breaks the editor — the selectors fall back to a free-typed value.
import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";

export function useWorkerDefinitions() {
  const [defs, setDefs] = useState([]);
  useEffect(() => {
    let live = true;
    api.listWorkerDefinitions().then((d) => { if (live) setDefs(Array.isArray(d) ? d : []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return defs;
}

export function useWorkflowDefinitions() {
  const [defs, setDefs] = useState([]);
  useEffect(() => {
    let live = true;
    api.listWorkflowDefinitions().then((d) => { if (live) setDefs(Array.isArray(d) ? d : []); }).catch(() => {});
    return () => { live = false; };
  }, []);
  return defs;
}
