// A run's questions, each with a text answer; an option the run offered fills
// the answer in, picked as a choice with its mark. Answers are keyed by the
// question's text, as a chat's are. A lone question the title already asks
// is not said twice: its words stay for the field's label only.
export function QuestionCard({ detail, values, setValue }) {
  const questions = detail.payload?.questions ?? [];
  if (questions.length === 0) return null;
  const said = (q) => questions.length === 1 && q.question.trim() === detail.item.title.trim();
  return (
    <div className="eos-needs-card eos-needs-questions">
      {questions.map((q, n) => {
        const field = `eos-q-${n}`;
        return (
          <div key={field} className="eos-needs-question">
            {q.header && <p className="eos-label">{q.header}</p>}
            <label htmlFor={field} className={said(q) ? "eos-needs-question__text eos-sr" : "eos-needs-question__text"}>{q.question}</label>
            {q.options?.length > 0 && (
              <div className="eos-needs-options">
                {q.options.map((o) => (
                  <button
                    key={o.label}
                    type="button"
                    className="eos-chip eos-needs-option"
                    aria-pressed={values[q.question] === o.label}
                    onClick={() => setValue(q.question, o.label)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            <textarea
              id={field}
              className="eos-needs-question__answer"
              rows={2}
              placeholder={q.options?.length > 0 ? "Or say it in your own words" : "Your answer"}
              value={values[q.question] ?? ""}
              onChange={(e) => setValue(q.question, e.target.value)}
            />
          </div>
        );
      })}
    </div>
  );
}

// Every question answered → { question text: answer }; null while one is empty.
export function questionAnswers(detail, values) {
  const questions = detail.payload?.questions ?? [];
  const answers = Object.fromEntries(questions.map((q) => [q.question, (values[q.question] ?? "").trim()]));
  return questions.length > 0 && Object.values(answers).every(Boolean) ? answers : null;
}
