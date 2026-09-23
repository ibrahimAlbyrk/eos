export function MarkdownView({ content }) {
  const html = renderMarkdown(content);
  return <div className="fv-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function inlineFormat(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = src.split("\n");
  let html = "";
  let inCode = false;
  let inList = false;

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inList) { html += "</ul>"; inList = false; }
      if (inCode) { html += "</pre>"; inCode = false; }
      else { html += "<pre>"; inCode = true; }
      continue;
    }
    if (inCode) { html += esc(line) + "\n"; continue; }

    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) { html += "</ul>"; inList = false; }
      html += "<br/>";
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      if (inList) { html += "</ul>"; inList = false; }
      const level = hMatch[1].length;
      html += `<h${level}>${inlineFormat(esc(hMatch[2]))}</h${level}>`;
      continue;
    }

    const liMatch = trimmed.match(/^[-*]\s+(.*)$/);
    if (liMatch) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineFormat(esc(liMatch[1]))}</li>`;
      continue;
    }

    if (inList) { html += "</ul>"; inList = false; }
    html += `<p>${inlineFormat(esc(trimmed))}</p>`;
  }
  if (inCode) html += "</pre>";
  if (inList) html += "</ul>";
  return html;
}
