import { lazy, Suspense } from "react";

// CodeMirror (editor runtime + ~25 Lezer grammars) is heavy and only ever
// mounts when a file is actually opened. Splitting it behind React.lazy keeps
// it out of the eager main bundle — the chunk loads on first file open.
const Impl = lazy(() => import("./EditView.jsx").then((m) => ({ default: m.EditView })));

export function EditView(props) {
  return (
    <Suspense fallback={<div className="fv-loading">Loading…</div>}>
      <Impl {...props} />
    </Suspense>
  );
}
