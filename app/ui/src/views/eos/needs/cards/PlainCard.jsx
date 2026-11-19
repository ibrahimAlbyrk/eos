import { FAILURES } from "../../capabilities/words.js";

// The item in words: its summary, and for a delivery problem why it failed.
export function PlainCard({ detail }) {
  const why = FAILURES[detail.payload?.errorKind];
  return (
    <div className="eos-needs-card">
      {detail.item.summary && <p className="eos-needs-card__lead">{detail.item.summary}</p>}
      {why && <p className="eos-needs-card__class">{why}</p>}
    </div>
  );
}

// A suggestion about the user: Eos's guess, asked back.
export function AboutYouCard({ detail }) {
  return (
    <div className="eos-needs-card">
      <p className="eos-needs-card__lead">{detail.item.title}</p>
      <p className="eos-needs-card__class">Is this right about you?</p>
    </div>
  );
}
