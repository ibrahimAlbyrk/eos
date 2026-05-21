import { Component } from "react";

// Catches render-time exceptions inside a subtree and falls back to a small
// inline error card instead of unmounting the whole app. Reset clears the
// error state — the subtree re-mounts on the next render.
//
// Function-component error boundaries don't exist in React 18, so this stays
// as a class component on purpose.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Surface the failure in the console for the developer; the daemon also
    // sees it because the web UI is opened from the same machine.
    console.error("[error boundary]", error, info?.componentStack);
  }
  reset = () => this.setState({ error: null });
  render() {
    if (this.state.error) {
      const label = this.props.label || "panel";
      const msg = String(this.state.error?.message || this.state.error);
      return (
        <div className="vb-error-fallback" role="alert">
          <div className="vb-error-fallback__title">{label} crashed</div>
          <pre className="vb-error-fallback__msg">{msg}</pre>
          <button className="vb-btn vb-btn--ghost" onClick={this.reset}>Reset</button>
        </div>
      );
    }
    return this.props.children;
  }
}
