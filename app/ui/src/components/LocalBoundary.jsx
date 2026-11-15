import { Component } from "react";

// Keeps a render-time crash inside one transcript row, pane or side-panel tab:
// the rest of the window keeps working (the app-level ErrorBoundary is the
// last resort). Renders its children untouched until something throws; then
// `fallback(reset)`, or nothing. `resetKey` changing (another agent, another
// tab) gives the children another try.
export class LocalBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
    this.reset = () => this.setState({ error: null });
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error, info) {
    console.error(`UI crash (${this.props.name}):`, error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return this.props.fallback ? this.props.fallback(this.reset) : null;
  }
}

// A pane's or a tab's fallback: what broke, and a way to draw it again.
export function AreaCrash({ what, onReset }) {
  return (
    <div className="empty-state" role="alert">
      <span className="empty-state__title">{what} couldn’t be shown</span>
      <span className="empty-state__subtitle">Something went wrong here. The rest of Eos keeps working.</span>
      <button type="button" className="empty-state__action" onClick={onReset}>Try again</button>
    </div>
  );
}

// A transcript row's fallback, in the transcript's own error-line style.
export function RowCrash() {
  return (
    <div className="turn-error mono" role="alert">
      <span className="te-icon" aria-hidden>!</span>
      <span className="te-msg">This part of the conversation couldn’t be shown</span>
    </div>
  );
}
