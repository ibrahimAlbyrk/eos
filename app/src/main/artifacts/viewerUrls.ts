// Which pages an artifact view may show: only claude.ai's artifact viewer. Its
// login pages mean the partition needs a sign-in.

const CLAUDE_HOSTS = new Set(["claude.ai", "preview.claude.ai"]);
const VIEWER_PATH = /^\/(?:artifact|code\/artifact|code\/frame)\//;
const LOGIN_PATH = /^\/(?:login|logout)(?:\/|$)/;

function claudePath(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && CLAUDE_HOSTS.has(u.hostname) ? u.pathname : null;
  } catch {
    return null;
  }
}

export function isViewerUrl(url: string): boolean {
  const p = claudePath(url);
  return p != null && VIEWER_PATH.test(p);
}

export function isLoginUrl(url: string): boolean {
  const p = claudePath(url);
  return p != null && LOGIN_PATH.test(p);
}

export const isWeb = (url: string): boolean => /^https?:/i.test(url);
