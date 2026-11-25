---
description: "Tool — app_propose"
---

Hand in the App this routine makes: one HTML document that runs inside Eos's sandboxed frame, where a Page cannot do the job. Eos scans it first; a reviewer reads it and Eos tests it in its probe, and the user sees it only once all three pass.

- `html`: the whole App, script and style inline. It has no network, no storage and no other window: no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`, `importScripts`, `<iframe>`, `window.open`, `document.cookie`, `localStorage`, `sessionStorage` or `indexedDB`. It reaches Eos only through its bridge: `parent.postMessage({jsonrpc: "2.0", id, method: "tools/call", params: {name, arguments}}, "*")`, with the answer posted back by the same `id`.
- `manifest`: `{"title", "summary", "height"?, "uses": [action ids], "queries": [query ids], "files"?: {"root": "project" | "routine_files", "read": [globs], "write": [globs]}, "stateMaxBytes"?}`. Every name the code calls must be declared: an action id in `uses`, `query.<id>` with its id in `queries`, `files.list`, `files.read` and `files.write` within `files` (the narrowest globs that do the job). `state.get` and `state.set` keep its saved state, at most 256 KB.
- `tests` (optional): the body of an async function run against the App once it has loaded, with a fake bridge that answers every call and records it: `await eosTest.click(selector)`, `await eosTest.type(selector, text)`, `eosTest.text(selector)`, `eosTest.calls()` (each `{name, arguments}` so far) and `eosTest.expect(condition, why)`. Eos also checks that the App loads within 5 seconds, throws and logs no error, draws something, fits 360 pixels and calls nothing its manifest does not declare.
- `note`: one line the user reads beside the change.

Set text from data or files with `textContent`, never as markup, and draw nothing that looks like Eos's own prompts or a "send as you" button: Eos asks the user itself.

The answer lists every problem with its place, or says the version waits for its review and tests.
