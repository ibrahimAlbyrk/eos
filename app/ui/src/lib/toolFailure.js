// One classification of a tool's failure, shared by the header badge (ToolItem)
// and the body banner (ToolDetail). null = succeeded; "denied" = blocked by the
// permission gateway; "failed" = any other error result.
export function failureKind(tool) {
  if (!tool.result?.isError) return null;
  const text = tool.result.text ?? "";
  return /^denied|permission mode|denied by policy/i.test(text) ? "denied" : "failed";
}
