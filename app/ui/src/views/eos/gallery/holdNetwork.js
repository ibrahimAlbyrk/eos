// The gallery draws the app's own UI context around Eos (a View needs it),
// and that context reads the app's settings and streams on mount. Here no
// request leaves the page: a read of a path in `answers` gets its sample,
// every other request is answered as refused, and a stream never opens, so
// the gallery never calls the core.
const REFUSED = JSON.stringify({ error: "the gallery calls no core" });

class ClosedStream {
  constructor() { this.readyState = 2; }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const JSON_TYPE = { "content-type": "application/json" };

export function holdNetwork(scope = globalThis, answers = {}) {
  scope.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://gallery");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = method === "GET" ? answers[url.pathname] : undefined;
    if (body !== undefined) return new Response(JSON.stringify(body), { status: 200, headers: JSON_TYPE });
    return new Response(REFUSED, { status: 503, headers: JSON_TYPE });
  };
  scope.EventSource = ClosedStream;
}
