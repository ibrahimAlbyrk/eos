// A machine's tile: a device-shaped icon plus the link-state dot. The shape is a
// guess from the computer's name/platform — only a visual cue.

function kindOf(name, platform) {
  const n = (name ?? "").toLowerCase();
  if (/macbook|laptop/.test(n)) return "laptop";
  if (/imac|display/.test(n)) return "display";
  if (/studio|mini/.test(n)) return "box";
  if (/iphone|phone/.test(n)) return "phone";
  if (platform && platform !== "darwin") return "server";
  return "laptop";
}

const PATHS = {
  laptop: <><rect x="3" y="3.5" width="10" height="7" rx="1.2" /><path d="M1.5 12.5h13" /></>,
  display: <><rect x="2" y="2.5" width="12" height="8.5" rx="1.3" /><path d="M6 14h4M8 11v3" /></>,
  box: <><rect x="2.5" y="5" width="11" height="7" rx="1.6" /><path d="M5.5 9.5h2" /></>,
  phone: <><rect x="4.5" y="1.5" width="7" height="13" rx="1.6" /><path d="M7 12.5h2" /></>,
  server: <><rect x="2.5" y="2.5" width="11" height="4.5" rx="1" /><rect x="2.5" y="9" width="11" height="4.5" rx="1" /><path d="M5 4.75h1M5 11.25h1" /></>,
};

export function MachineIcon({ name, platform, size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[kindOf(name, platform)]}
    </svg>
  );
}

// tone: "ok" | "warn" | "err" | "off" | null (no dot)
export function MachineGlyph({ name, platform, tone = "ok", size = "sm" }) {
  const icon = size === "xl" ? 20 : size === "lg" ? 16 : 14;
  return (
    <span className={`mg mg--${size}` + (tone === "off" ? " mg--off" : "")}>
      <MachineIcon name={name} platform={platform} size={icon} />
      {tone && <span className={`mg__st mg__st--${tone}`} />}
    </span>
  );
}
