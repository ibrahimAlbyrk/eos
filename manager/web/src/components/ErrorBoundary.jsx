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
      return (
        <div style={{
          padding: 32, color: "var(--fg)", maxWidth: 720, margin: "40px auto",
          fontFamily: "var(--font-ui)",
        }}>
          <h2 style={{ color: "var(--err)", marginTop: 0 }}>UI crashed</h2>
          <p style={{ color: "var(--fg-dim)" }}>
            A component threw during render. The daemon is still running — reset to recover.
          </p>
          <pre style={{
            background: "var(--surface)", padding: 12, borderRadius: 8,
            color: "var(--fg-dim)", fontSize: "var(--text-sm)", overflow: "auto",
            border: "1px solid var(--border)",
          }}>{String(this.state.error?.stack ?? this.state.error)}</pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 12, padding: "8px 14px",
              background: "var(--accent)", color: "#fff", border: 0,
              borderRadius: 6, cursor: "pointer", fontSize: "var(--text-base)",
            }}
          >
            Reset
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
