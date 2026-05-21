const POOLS = {
  main: { dir: "old", count: 14 },
  sub: { dir: "adult", count: 40 },
  sub2: { dir: "kid", count: 38 },
};

const SIZES = [32, 64, 128, 256];

const STORAGE_KEY = "vb.portraits.v2";
const mem = new Map();
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      for (const k of Object.keys(obj)) mem.set(k, obj[k]);
    }
  } catch {}
}

function persist() {
  try {
    const obj = {};
    for (const [k, v] of mem) obj[k] = v;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {}
}

function effectiveRole(agent) {
  if (agent.id === "orchestrator" || agent.isOrchestrator || agent.role === "main") return "main";
  if (agent.role === "sub2") return "sub2";
  return "sub";
}

const CDN_BASE = "https://cdn.jsdelivr.net/gh/ibrahimAlbyrk/claude-manager-avatars@v1";

function buildUrls(role, n) {
  const pool = POOLS[role];
  const base = `${CDN_BASE}/${pool.dir}/${pool.dir}_${n}`;
  return {
    src: `${base}_${SIZES[SIZES.length - 1]}.webp`,
    srcSet: SIZES.map(s => `${base}_${s}.webp ${s}w`).join(", "),
  };
}

export function pickPortrait(agent) {
  if (!agent || !agent.id) return null;
  load();
  const cached = mem.get(agent.id);
  if (cached) return buildUrls(cached.role, cached.n);
  const role = effectiveRole(agent);
  const pool = POOLS[role];
  const n = Math.floor(Math.random() * pool.count) + 1;
  mem.set(agent.id, { role, n });
  persist();
  return buildUrls(role, n);
}
