import { Component } from "react";

// Wraps one slot item: if it throws while rendering, only that item disappears
// and the rest of the UI keeps working. `resetKey` changing (a new version of the
// item) gives it another try.
export class SlotBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error, info) {
    console.error(`Slot item "${this.props.name}" crashed:`, error, info?.componentStack);
  }

  render() {
    return this.state.error ? null : this.props.children;
  }
}
