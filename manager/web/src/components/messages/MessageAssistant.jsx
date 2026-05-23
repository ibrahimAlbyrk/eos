export function MessageAssistant({ text }) {
  const paragraphs = String(text || "").split(/\n{2,}/).filter(Boolean);
  return (
    <div className="msg-asst">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}
