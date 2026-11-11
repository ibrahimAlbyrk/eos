// Node's side of regex-time: the same patterns and inputs.
const ordinary = [String.raw`^\s*rm\s+-[rRf]+\s+/(\s|$)`, String.raw`rm\s+-[rRf]+\s+[~/]?[^\s]*\.eos(?!/scratch/[^\s/]+/)`, String.raw`(^|\s)curl(?!.*--max-time)`, String.raw`^src/(?!generated/).*\.(ts|tsx)$`, String.raw`\.(env|pem|key)(\.[\w-]+)?$`];
const inputs = ["git status --short", "cd /Users/someone/Projects/app && npm test -- --watch=false 2>&1 | tail -40", "rm -rf ~/.eos/scratch/abc/build", "curl -s https://example.test/api/v1/items?limit=100 | jq '.items[] | .name'", "/Users/someone/Projects/app/src/components/Sidebar/SidebarItem.tsx"];
const compiled = ordinary.map((p) => new RegExp(p));
const rounds = 20_000;
let hits = 0;
let start = process.hrtime.bigint();
for (let r = 0; r < rounds; r++) for (const re of compiled) for (const t of inputs) hits += re.test(t) ? 1 : 0;
const per = Number(process.hrtime.bigint() - start) / (rounds * compiled.length * inputs.length);
console.log(`ordinary: ${per.toFixed(0)} ns per test() (${hits} hits)`);
const evil = /(a+)+$/;
for (const n of [16, 20, 24]) {
  const text = "a".repeat(n) + "!";
  start = process.hrtime.bigint();
  const hit = evil.test(text);
  console.log(`(a+)+$ on ${n} a's + '!': ${(Number(process.hrtime.bigint() - start) / 1e6).toFixed(1)} ms (match: ${hit})`);
}
