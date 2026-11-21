// A guess about the user, asked back: "Is this right about you?". After
// Edit, the guess sits in a field and is kept in the user's words.
export function MemoryQuestion({ detail, values = {}, setValue }) {
  return (
    <div className="eos-needs-card">
      {values.text === undefined
        ? <p className="eos-needs-card__lead">{detail.item.title}</p>
        : (
          <textarea
            className="eos-needs-question__answer"
            aria-label="In your words"
            maxLength={500}
            rows={3}
            value={values.text}
            onChange={(e) => setValue("text", e.target.value)}
          />
        )}
      <p className="eos-needs-card__class">Is this right about you?</p>
    </div>
  );
}

// The text to keep in its place, or undefined when the guess is kept as it is.
export function editedGuess(detail, values) {
  const text = values.text?.trim();
  return text && text !== detail.payload.memory.text ? text : undefined;
}
