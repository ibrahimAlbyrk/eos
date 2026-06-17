import { errMsg } from "../../contracts/src/util.ts";

// Helper for tools — wraps the call in a try/catch and produces the standard
// MCP "text" content shape. Keeps each tool body focused on its logic.
export async function safeText<T>(
  fn: () => Promise<T>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const res = await fn();
    return { content: [{ type: "text" as const, text: typeof res === "string" ? res : JSON.stringify(res, null, 2) }] };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `error: ${errMsg(e)}` }],
      isError: true,
    };
  }
}
