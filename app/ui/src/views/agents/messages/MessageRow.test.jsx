import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageActions, MessageRow, menuPoint } from "./MessageRow.jsx";

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

  it("opens the bar where the pointer is, unless an inner menu already took the click", () => {
    const box = { left: 100, top: 40 };
    expect(menuPoint({ defaultPrevented: false, clientX: 130, clientY: 55 }, box)).toEqual({ x: 30, y: 15 });
    // A path chip's own menu (usePathLinks) prevents the default: the bar stays shut.
    expect(menuPoint({ defaultPrevented: true, clientX: 130, clientY: 55 }, box)).toBeNull();
  });

  const titles = (html) => [...html.matchAll(/<button[^>]*title="([^"]+)"/g)].map((m) => m[1]);

  it("offers the time, Rewind, Copy and Reply on a user message, in that order", () => {
    const html = renderToStaticMarkup(
      <MessageActions ts={Date.now()} canRewind rewindState={null} onRewind={() => {}} onCopy={() => {}} onReply={() => {}} />,
    );
    expect(html.startsWith('<span class="msg-time"')).toBe(true);
    expect(titles(html)).toEqual(["Rewind to here", "Copy", "Reply"]);
    expect(html).not.toContain("disabled");
  });

  it("keeps Rewind visible but inert while the agent is busy", () => {
    const html = renderToStaticMarkup(
      <MessageActions ts={1} canRewind rewindDisabled rewindState={null} onRewind={() => {}} onCopy={() => {}} onReply={() => {}} />,
    );
    expect(titles(html)).toEqual(["Agent is busy", "Copy", "Reply"]);
    expect(html).toMatch(/<button class="msg-action-btn is-busy"[^>]*disabled=""/);
  });

  it("offers only Copy and Reply on an assistant message, Copy alone without a reply", () => {
    expect(titles(renderToStaticMarkup(<MessageActions ts={1} onCopy={() => {}} onReply={() => {}} />))).toEqual(["Copy", "Reply"]);
    expect(titles(renderToStaticMarkup(<MessageActions onCopy={() => {}} onReply={null} />))).toEqual(["Copy"]);
  });
});
