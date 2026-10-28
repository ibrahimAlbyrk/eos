// Pure helpers for the /btw side question (views/btw/, state/sideQuestionStore.js).

// The composer's "/btw <question>" → { question } ("" for a bare /btw, which
// just opens the tab), or null when the text isn't a side question.
export function parseSideQuestion(text) {
  const m = /^\/btw(?:\s+([\s\S]*))?$/.exec((text ?? "").trim());
  return m ? { question: (m[1] ?? "").trim() } : null;
}

// What "Add to chat" puts in the composer: the exchange as a quote the user
// can write their message under.
export function sideQuestionQuote(question, answer) {
  const quote = (s) => s.trim().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
  return `${quote(`**Side question:** ${question}`)}\n>\n${quote(answer)}\n\n`;
}
