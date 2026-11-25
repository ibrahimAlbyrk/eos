// The How slot: the steps, the checks a result must pass ("Add a check"),
// and the shape of the result. An emptied step or check goes away.

function freeKey(checks) {
  const taken = new Set(checks.map((c) => c.key));
  let n = checks.length + 1;
  while (taken.has(`check-${n}`)) n += 1;
  return `check-${n}`;
}

export function howParts(how) {
  const h = how ?? {};
  const steps = h.steps ?? [];
  const checks = h.checks ?? [];
  const parts = steps.flatMap((step, n) => [
    ...(n > 0 ? [" · "] : []),
    { key: `step.${n}`, label: "Step", editor: "text", text: step, value: step, apply: (v) => ({ ...h, steps: v ? steps.map((s, i) => (i === n ? v : s)) : steps.filter((_, i) => i !== n) }) },
  ]);
  if (steps.length === 0) parts.push("No steps written");
  parts.push({ break: true });
  for (const [n, check] of checks.entries()) {
    parts.push({
      key: `check.${check.key}`, label: "Check", editor: "text", chip: true, text: check.text, value: check.text,
      apply: (v) => ({ ...h, checks: v ? checks.map((c, i) => (i === n ? { ...c, text: v } : c)) : checks.filter((_, i) => i !== n) }),
    });
  }
  parts.push({ key: "check.add", label: "New check", editor: "text", text: "Add a check", value: "", optional: true, add: true, apply: (v) => (v ? { ...h, checks: [...checks, { key: freeKey(checks), text: v }] } : h) });
  parts.push({ break: true }, { key: "format", label: "Format", editor: "text", note: true, text: h.format || "Any format", value: h.format ?? "", apply: (v) => ({ ...h, format: v }) });
  return parts;
}
