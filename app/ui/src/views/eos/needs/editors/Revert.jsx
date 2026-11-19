// The arrow beside a changed field: puts back what the run wrote.
export function Revert({ shown, what, onRevert }) {
  if (!shown) return null;
  return (
    <button type="button" className="eos-edit__revert" aria-label={`Put back the ${what} as Eos wrote it`} title="Put back" onClick={onRevert}>↶</button>
  );
}
