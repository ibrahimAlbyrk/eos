import { Component } from "react";

// Top-level error boundary so a render-time crash in one panel doesn't blank
// the entire UI. Logs to the console and offers a one-click reset.

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("UI crash:", error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      // Full-window crash screen (charcoal-aurora). Inline styles on purpose:
      // the boundary must render even if a stylesheet is what broke.
      const stack = String(this.state.error?.stack ?? this.state.error ?? "");
      const nl = stack.indexOf("\n");
      const firstLine = nl === -1 ? stack : stack.slice(0, nl);
      const rest = nl === -1 ? "" : stack.slice(nl);
      const trafficDot = { width: 11, height: 11, borderRadius: "50%", background: "var(--dot-idle)" };
      return (
        <div style={{
          position: "absolute", inset: 0, zIndex: 600, background: "var(--bg)",
          display: "flex", flexDirection: "column", fontFamily: "var(--font-ui)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "16px 18px", flexShrink: 0 }}>
            <span style={trafficDot} /><span style={trafficDot} /><span style={trafficDot} />
          </div>
          <div style={{
            flex: 1, minHeight: 0, display: "flex", alignItems: "center",
            justifyContent: "center", padding: "0 32px 10vh",
          }}>
            <div style={{ width: "100%", maxWidth: 640, display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 9,
                fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--fg-strong)",
              }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--err)" }} />
                UI crashed
              </span>
              <span style={{ fontSize: 14, color: "var(--fg-dim)", textWrap: "pretty" }}>
                A component threw during render. The daemon is still running — reset to recover.
              </span>
              <pre style={{
                margin: "8px 0 0", maxHeight: 260, overflow: "hidden", padding: "14px 16px",
                borderRadius: 12, background: "var(--panel)", fontFamily: "var(--font-mono)",
                fontSize: 12, lineHeight: 1.7, color: "var(--fg-dim)",
                whiteSpace: "pre-wrap", wordBreak: "break-word",
              }}>
                <span style={{ color: "var(--err)" }}>{firstLine}</span>{rest}
              </pre>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button
                  onClick={() => this.setState({ error: null })}
                  style={{
                    display: "inline-flex", alignItems: "center", height: 32, padding: "0 16px",
                    background: "var(--accent)", color: "var(--accent-fg)", border: 0,
                    borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 500,
                  }}
                >
                  Reset
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
