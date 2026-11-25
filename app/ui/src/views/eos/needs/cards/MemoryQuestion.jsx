// A guess about the user, asked back by the lead ("Is this right about
// you?"); after Edit, the guess sits in a field and is kept in the user's
// words. Before Edit there is nothing more to show than the lead.
export function MemoryQuestion({ values = {}, setValue }) {
  if (values.text === undefined) return null;
  return (
    <div className="eos-needs-card eos-needs-well">
      <label className="eos-label" htmlFor="eos-needs-guess">In your words</label>
      <textarea
        id="eos-needs-guess"
        className="eos-needs-question__answer"
        maxLength={500}
        rows={3}
        value={values.text}
        onChange={(e) => setValue("text", e.target.value)}
      />
    </div>
  );
}

// The text to keep in its place, or undefined when the guess is kept as it is.
export function editedGuess(detail, values) {
  const text = values.text?.trim();
  return text && text !== detail.payload.memory.text ? text : undefined;
}
