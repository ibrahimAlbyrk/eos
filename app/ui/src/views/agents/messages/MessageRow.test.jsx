import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "./MessageRow.jsx";

// No jsdom in this suite, so the right-click → bar wiring can't be dispatched;
// this pins the resting state: nothing but the message, so no space is reserved.
describe("MessageRow", () => {
  it("renders only the message at rest — the action bar waits for a right-click", () => {
    const html = renderToStaticMarkup(
      <MessageRow ts={1} copyText="hi" align="right" onRewind={async () => ({ ok: true })} onReply={() => {}}>
        <p>hi</p>
      </MessageRow>,
    );
    expect(html).toBe('<div class="msg-row right"><p>hi</p></div>');
  });
});
