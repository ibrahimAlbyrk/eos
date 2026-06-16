export function buildDiffHunks(oldLines, newLines) {
  const hunks = [];
  const maxCtx = Math.max(oldLines.length, newLines.length);
  if (maxCtx === 0) return hunks;

  const lcs = computeLCS(oldLines, newLines);
  let oi = 0, ni = 0, li = 0;
  let lineNum = 1;

  while (oi < oldLines.length || ni < newLines.length) {
    if (li < lcs.length && oi < oldLines.length && ni < newLines.length
        && oldLines[oi] === lcs[li] && newLines[ni] === lcs[li]) {
      hunks.push({ type: "ctx", num: lineNum, text: lcs[li] });
      oi++; ni++; li++; lineNum++;
    } else {
      const delStart = hunks.length;
      while (oi < oldLines.length && (li >= lcs.length || oldLines[oi] !== lcs[li])) {
        hunks.push({ type: "del", num: oi + 1, text: oldLines[oi] });
        oi++;
      }
      const addStart = hunks.length;
      while (ni < newLines.length && (li >= lcs.length || newLines[ni] !== lcs[li])) {
        hunks.push({ type: "add", num: ni + 1, text: newLines[ni] });
        ni++; lineNum++;
      }
      const delCount = addStart - delStart;
      const addCount = hunks.length - addStart;
      const pairCount = Math.min(delCount, addCount);
      for (let p = 0; p < pairCount; p++) {
        const dh = hunks[delStart + p];
        const ah = hunks[addStart + p];
        const [dSegs, aSegs] = inlineDiff(dh.text, ah.text);
        dh.segments = dSegs;
        ah.segments = aSegs;
      }
    }
  }
  return hunks;
}

// Renders the Edit/Write tool_result's structuredPatch into the same row shape
// as buildDiffHunks ({type, num, text, segments?}) — but with the *absolute*
// file line numbers the patch carries (oldStart/newStart), instead of the
// snippet-relative indices buildDiffHunks is forced to invent. del/add runs are
// paired for inline word-level highlighting, same as buildDiffHunks.
export function patchToHunks(structuredPatch) {
  if (!Array.isArray(structuredPatch)) return [];
  const rows = [];
  for (const h of structuredPatch) {
    let oldNum = typeof h?.oldStart === "number" ? h.oldStart : 1;
    let newNum = typeof h?.newStart === "number" ? h.newStart : 1;
    const lines = Array.isArray(h?.lines) ? h.lines : [];
    let i = 0;
    while (i < lines.length) {
      const ch = lines[i][0];
      if (ch === "\\") { i++; continue; } // "\ No newline at end of file"
      if (ch === "-" || ch === "+") {
        const delStart = rows.length;
        while (i < lines.length && lines[i][0] === "-") {
          rows.push({ type: "del", num: oldNum++, text: lines[i].slice(1) });
          i++;
        }
        const addStart = rows.length;
        while (i < lines.length && lines[i][0] === "+") {
          rows.push({ type: "add", num: newNum++, text: lines[i].slice(1) });
          i++;
        }
        const pairCount = Math.min(addStart - delStart, rows.length - addStart);
        for (let p = 0; p < pairCount; p++) {
          const dh = rows[delStart + p];
          const ah = rows[addStart + p];
          const [dSegs, aSegs] = inlineDiff(dh.text, ah.text);
          dh.segments = dSegs;
          ah.segments = aSegs;
        }
      } else {
        rows.push({ type: "ctx", num: newNum, text: lines[i].slice(1) });
        oldNum++; newNum++; i++;
      }
    }
  }
  return rows;
}

export function computeLCS(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  const result = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.push(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return result.reverse();
}

export function inlineDiff(oldText, newText) {
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++;
  let suffixO = oldText.length, suffixN = newText.length;
  while (suffixO > prefix && suffixN > prefix && oldText[suffixO - 1] === newText[suffixN - 1]) { suffixO--; suffixN--; }

  const common1 = oldText.slice(0, prefix);
  const delPart = oldText.slice(prefix, suffixO);
  const addPart = newText.slice(prefix, suffixN);
  const common2 = oldText.slice(suffixO);

  const delSegs = (
    <>
      {common1}
      {delPart && <span className="ed-hl-del">{delPart}</span>}
      {common2}
    </>
  );
  const addSegs = (
    <>
      {common1}
      {addPart && <span className="ed-hl-add">{addPart}</span>}
      {common2}
    </>
  );
  return [delSegs, addSegs];
}

export function parseAskAnswers(questions, resultText) {
  if (!resultText || questions.length === 0) return [];

  const answerMap = new Map();

  const msgMatch = resultText.match(/My answers to your questions:\n([\s\S]*)/);
  if (msgMatch) {
    for (const line of msgMatch[1].split("\n").filter(Boolean)) {
      const idx = line.indexOf(" → ");
      if (idx >= 0) answerMap.set(line.slice(0, idx).trim(), line.slice(idx + 3).trim());
    }
  }

  // Format: Your questions have been answered: "Q1"="A1", "Q2"="A2". <boilerplate>
  // Pull each quoted key="value" pair directly. Values may contain commas
  // (multi-select "Apple, Cherry") but not quotes, so the trailing prose
  // ("You can now continue …") and the leading opener never leak into a value.
  const answeredMatch = resultText.match(/Your questions have been answered:\s*([\s\S]*)/);
  if (answeredMatch) {
    const pairRe = /"([^"]+)"\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = pairRe.exec(answeredMatch[1])) !== null) {
      answerMap.set(m[1].trim(), m[2].trim());
    }
  }

  return questions.map((q) => {
    const qText = q.question ?? "";
    if (answerMap.has(qText)) return answerMap.get(qText);
    for (const [k, v] of answerMap) {
      if (qText.includes(k) || k.includes(qText)) return v;
    }
    return null;
  });
}

export function stripCatLineNumbers(text) {
  if (!text) return [];
  const lines = text.split("\n");
  const hasCatNums = lines.length > 1 && /^\s*\d+\t/.test(lines[0]);
  if (!hasCatNums) return lines.map((t, i) => ({ num: i + 1, text: t }));
  return lines.map((line) => {
    const m = line.match(/^\s*(\d+)\t(.*)$/);
    return m ? { num: parseInt(m[1], 10), text: m[2] } : { num: 0, text: line };
  });
}
