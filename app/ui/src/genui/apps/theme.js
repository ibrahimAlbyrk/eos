// The look an agent-authored app inherits: Eos's dark tokens published under
// the MCP Apps standard variable names (so an app written against that spec, or
// one following the present_app prompt, matches the chat) plus a few --eos-*
// aliases for the things the standard has no name for (the tones, the accent).
// The values are literal, not var(--…) references — the app's document can't
// see the dashboard's custom properties.

const FONT_SANS = '"Geist Variable", "Geist", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
const FONT_MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// McpUiStyleVariableKey → value. Also what ui/initialize hands the app as
// hostContext.styles.variables.
export const MCP_THEME_VARIABLES = Object.freeze({
  "--color-background-primary": "#171717",
  "--color-background-secondary": "#212121",
  "--color-background-tertiary": "#292929",
  "--color-background-inverse": "#f5f5f5",
  "--color-background-ghost": "rgba(255, 255, 255, 0.04)",
  "--color-background-info": "rgba(110, 164, 232, 0.13)",
  "--color-background-danger": "rgba(196, 127, 121, 0.13)",
  "--color-background-success": "rgba(111, 174, 134, 0.13)",
  "--color-background-warning": "rgba(201, 161, 99, 0.13)",
  "--color-background-disabled": "#1c1c1c",

  "--color-text-primary": "#e9e9e9",
  "--color-text-secondary": "#a8a8a8",
  "--color-text-tertiary": "#737373",
  "--color-text-inverse": "#101010",
  "--color-text-info": "#8ab9f0",
  "--color-text-danger": "#c47f79",
  "--color-text-success": "#6fae86",
  "--color-text-warning": "#c9a163",
  "--color-text-disabled": "#474747",
  "--color-text-ghost": "#8b8b8b",

  "--color-border-primary": "#2f2f2f",
  "--color-border-secondary": "#242424",
  "--color-border-tertiary": "#1e1e1e",
  "--color-border-inverse": "#f5f5f5",
  "--color-border-ghost": "rgba(255, 255, 255, 0.06)",
  "--color-border-info": "rgba(110, 164, 232, 0.45)",
  "--color-border-danger": "rgba(196, 127, 121, 0.45)",
  "--color-border-success": "rgba(111, 174, 134, 0.45)",
  "--color-border-warning": "rgba(201, 161, 99, 0.45)",
  "--color-border-disabled": "#242424",

  "--color-ring-primary": "#6ea4e8",
  "--color-ring-secondary": "#8b8b8b",
  "--color-ring-inverse": "#f5f5f5",
  "--color-ring-info": "#6ea4e8",
  "--color-ring-danger": "#c47f79",
  "--color-ring-success": "#6fae86",
  "--color-ring-warning": "#c9a163",

  "--font-sans": FONT_SANS,
  "--font-mono": FONT_MONO,
  "--font-weight-normal": "400",
  "--font-weight-medium": "500",
  "--font-weight-semibold": "600",
  "--font-weight-bold": "700",

  "--font-text-xs-size": "12px",
  "--font-text-sm-size": "13px",
  "--font-text-md-size": "14px",
  "--font-text-lg-size": "16px",
  "--font-heading-xs-size": "14px",
  "--font-heading-sm-size": "15px",
  "--font-heading-md-size": "17px",
  "--font-heading-lg-size": "19px",
  "--font-heading-xl-size": "22px",
  "--font-heading-2xl-size": "28px",
  "--font-heading-3xl-size": "36px",
  "--font-text-xs-line-height": "16px",
  "--font-text-sm-line-height": "19px",
  "--font-text-md-line-height": "21px",
  "--font-text-lg-line-height": "24px",
  "--font-heading-xs-line-height": "20px",
  "--font-heading-sm-line-height": "21px",
  "--font-heading-md-line-height": "24px",
  "--font-heading-lg-line-height": "26px",
  "--font-heading-xl-line-height": "28px",
  "--font-heading-2xl-line-height": "34px",
  "--font-heading-3xl-line-height": "42px",

  "--border-radius-xs": "4px",
  "--border-radius-sm": "6px",
  "--border-radius-md": "10px",
  "--border-radius-lg": "14px",
  "--border-radius-xl": "18px",
  "--border-radius-full": "999px",
  "--border-width-regular": "1px",

  "--shadow-hairline": "0 0 0 1px rgba(255, 255, 255, 0.06)",
  "--shadow-sm": "0 1px 4px -1px rgba(0, 0, 0, 0.25)",
  "--shadow-md": "0 6px 14px -4px rgba(0, 0, 0, 0.35)",
  "--shadow-lg": "0 22px 50px -14px rgba(0, 0, 0, 0.7)",
});

export const EOS_THEME_ALIASES = Object.freeze({
  "--eos-bg": "#101010",
  "--eos-panel": "#171717",
  "--eos-raised": "#212121",
  "--eos-row": "#292929",
  "--eos-chip": "#2f2f2f",
  "--eos-line": "#242424",
  "--eos-fg-strong": "#f5f5f5",
  "--eos-fg": "#e9e9e9",
  "--eos-fg-mid": "#d4d4d4",
  "--eos-fg-dim": "#a8a8a8",
  "--eos-fg-faint": "#737373",
  "--eos-accent": "#6ea4e8",
  "--eos-accent-fg": "#0b1018",
  "--eos-blue": "#6ea4e8",
  "--eos-green": "#6fae86",
  "--eos-amber": "#c9a163",
  "--eos-red": "#c47f79",
  "--eos-violet": "#c8a2ff",
  "--eos-teal": "#5cb8c4",
  "--eos-font-sans": FONT_SANS,
  "--eos-font-mono": FONT_MONO,
});

// The <style> body that opens every app document. It comes before the app's
// own CSS, so anything the app sets wins.
export function themeCss() {
  const vars = Object.entries({ ...MCP_THEME_VARIABLES, ...EOS_THEME_ALIASES })
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  return (
    `:root{color-scheme:dark;${vars}}` +
    "body{margin:0;background:var(--color-background-primary);color:var(--color-text-primary);" +
    "font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}"
  );
}
