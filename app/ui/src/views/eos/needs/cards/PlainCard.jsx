// The item in words: its summary.
export function PlainCard({ detail }) {
  return (
    <div className="eos-needs-card">
      {detail.item.summary && <p className="eos-needs-card__lead">{detail.item.summary}</p>}
    </div>
  );
}
