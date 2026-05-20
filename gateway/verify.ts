import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Case = {
  name: string;
  args: { tool_name: string; input: Record<string, unknown> };
  expect: "allow" | "deny";
  rewriteCommand?: string;
};

const cases: Case[] = [
  { name: "Bash ls",         args: { tool_name: "Bash", input: { command: "ls -la" } },              expect: "allow" },
  { name: "Bash rm -rf",     args: { tool_name: "Bash", input: { command: "rm -rf /tmp/foo" } },     expect: "deny" },
  { name: "Bash git push",   args: { tool_name: "Bash", input: { command: "git push origin main" } }, expect: "deny" },
  { name: "Bash sudo",       args: { tool_name: "Bash", input: { command: "sudo ls" } },              expect: "deny" },
  { name: "Bash curl rewrite", args: { tool_name: "Bash", input: { command: "curl https://example.com" } }, expect: "allow", rewriteCommand: "curl --max-time 10 https://example.com" },
  { name: "Bash curl skip",  args: { tool_name: "Bash", input: { command: "curl --max-time 30 https://x" } }, expect: "allow" },
  { name: "Read",            args: { tool_name: "Read", input: { file_path: "/tmp/foo" } },           expect: "allow" },
  { name: "WebFetch",        args: { tool_name: "WebFetch", input: { url: "https://example.com" } },  expect: "allow" },
];

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", new URL("./server.ts", import.meta.url).pathname],
});

const client = new Client({ name: "verify", version: "1" });
await client.connect(transport);

let pass = 0;
for (const c of cases) {
  const result = await client.callTool({ name: "decide", arguments: c.args });
  const text = (result.content as Array<{ type: string; text: string }>)[0].text;
  const decision = JSON.parse(text);
  const behaviorOk = decision.behavior === c.expect;
  const rewriteOk = !c.rewriteCommand || decision.updatedInput?.command === c.rewriteCommand;
  const ok = behaviorOk && rewriteOk;
  const tag =
    decision.behavior === "allow" && decision.updatedInput?.command !== c.args.input.command
      ? "allow+rewrite"
      : decision.behavior;
  console.log(`${ok ? " OK " : "FAIL"}  ${c.name.padEnd(22)} got=${tag}${ok ? "" : `  want=${c.expect}${c.rewriteCommand ? ` rewrite=${c.rewriteCommand}` : ""}`}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} passed`);

await client.close();
process.exit(pass === cases.length ? 0 : 1);
