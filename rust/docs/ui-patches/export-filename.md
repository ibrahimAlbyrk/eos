# Export: the file name of a chat named beyond Latin-1

`GET /workers/:id/export` names the download in `content-disposition`. Today's daemon writes
`attachment; filename="export-<chat name>-<date>.html"` with the name as it is. A header value
carries bytes, not text: Node refuses a character above U+00FF in a header (the export of a chat
named with an emoji or CJK fails), and a Turkish `ş` or `ğ` arrives as whatever the reader makes of
the bytes.

The Rust core answers as RFC 6266 and RFC 5987 say:

- a name of plain ASCII (no `"` or `\`) is sent exactly as today: `attachment; filename="…"`;
- any other name gets the real name in `filename*` first, UTF-8 and percent-encoded, then an ASCII
  stand-in in `filename` (each other character becomes `_`):

  ```
  attachment; filename*=UTF-8''export-%C5%9Fi%C5%9Fe-2026-11-12.html; filename="export-_i_e-2026-11-12.html"
  ```

## What the dashboard reads today

`app/ui/src/api/client.js`, `exportWorker`:

```js
const disposition = r.headers.get("content-disposition");
const match = disposition?.match(/filename="?(.+?)"?$/);
const filename = match ? match[1] : `export-${id}.html`;
```

With `filename*` first, this regex skips it (`filename*=` is not `filename=`) and reads the ASCII
stand-in, so nothing breaks: a name beyond ASCII is saved under the stand-in until the patch below
lands. Putting `filename` first instead would make the same regex capture everything after it.

## The patch (not applied: `app/ui` is not changed by the port)

```diff
--- a/app/ui/src/api/client.js
+++ b/app/ui/src/api/client.js
@@ function encodeRawPath(p) {
+// RFC 6266: `filename*=UTF-8''…` carries the real name (percent-encoded UTF-8),
+// `filename="…"` an ASCII stand-in for readers that know no better.
+function downloadName(disposition) {
+  if (!disposition) return null;
+  const extended = disposition.match(/filename\*\s*=\s*UTF-8''([^;\s]+)/i);
+  if (extended) {
+    try {
+      return decodeURIComponent(extended[1]);
+    } catch {
+      // A malformed escape: fall back to the plain name.
+    }
+  }
+  const plain = disposition.match(/filename\s*=\s*"([^"]*)"/i) ?? disposition.match(/filename\s*=\s*([^;\s]+)/i);
+  return plain ? plain[1] : null;
+}
+
@@ async exportWorker(id, { tree = false } = {}) {
       const blob = await r.blob();
-      const disposition = r.headers.get("content-disposition");
-      const match = disposition?.match(/filename="?(.+?)"?$/);
-      const filename = match ? match[1] : `export-${id}.html`;
+      const filename = downloadName(r.headers.get("content-disposition")) ?? `export-${id}.html`;
```

`downloadName` belongs beside the other helpers at the top of the file. The native save dialog
(`webkit.messageHandlers.saveFile`) and `<a download>` both take the decoded name as it is.
