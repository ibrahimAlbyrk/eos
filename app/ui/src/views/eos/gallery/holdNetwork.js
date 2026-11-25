// The gallery draws the app's own UI context around Eos (a View needs it),
// and that context reads the app's settings and streams on mount. Here no
// request leaves the page: each one is answered as refused, and a stream
// never opens, so the gallery never calls the core.
const REFUSED = JSON.stringify({ error: "the gallery calls no core" });

class ClosedStream {
  constructor() { this.readyState = 2; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

export function holdNetwork(scope = globalThis) {
  scope.fetch = async () => new Response(REFUSED, { status: 503, headers: { "content-type": "application/json" } });
  scope.EventSource = ClosedStream;
}
