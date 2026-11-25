// The check the result went through (01 G5): each rule on a hairline after
// its mark, ok or failed; what the result must fix before it may pass, when
// it did not. A run not yet checked has no verdict and no section.
export function RunCheck({ verdict }) {
  if (!verdict?.checks?.length) return null;
  const failed = verdict.checks.filter((c) => !c.ok).length;
  return (
    <section className="eos-section eos-run-check" aria-label="The check">
      <header className="eos-section__head">
        <h2 className="eos-label">The check</h2>
        <span className={verdict.pass ? "eos-section__aside" : "eos-section__aside eos-run-check__failed"}>
          {verdict.pass ? "Passed" : `${failed} of ${verdict.checks.length} failed`}
        </span>
      </header>
      <ul className="eos-run-check__rows">
        {verdict.checks.map((c) => (
          <li key={c.key} className={c.ok ? "eos-fact eos-fact--done" : "eos-fact eos-fact--err"}>
            {c.note}
            <span className="eos-sr">{c.ok ? ", passed" : ", failed"}</span>
          </li>
        ))}
      </ul>
      {verdict.mustFix?.length > 0 && (
        <div className="eos-run-check__fix">
          <p className="eos-run-check__fix-label">To pass, it must</p>
          <ul>
            {verdict.mustFix.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}
