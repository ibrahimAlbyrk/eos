import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageActions, MessageRow, menuPoint } from "./MessageRow.jsx";
import { ReactionChips } from "./reactions/ReactionChips.jsx";
import { ReactionPicker } from "./reactions/ReactionPicker.jsx";
import { MORE_EMOJI, QUICK_EMOJI } from "../../../lib/reactions.js";
import { _reset, applyReactionChange, coverReactions } from "../../../state/reactionsStore.js";

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

describe("MessageRow reactions", () => {
  beforeEach(() => {
    _reset();
    coverReactions("w1", 1, async () => []);
  });

  it("adds nothing to a message that takes an emoji until it has one", () => {
    const html = renderToStaticMarkup(<MessageRow ts={1} copyText="hi" reaction={{ workerId: "w1", rowId: 7 }}><p>hi</p></MessageRow>);
    expect(html).toBe('<div class="msg-row"><p>hi</p></div>');
  });

  it("shows the agent's chip, then the user's own, under the message", () => {
    applyReactionChange({ workerId: "w1", rowId: 7, actor: "agent", emoji: "👍", at: 1 });
    applyReactionChange({ workerId: "w1", rowId: 7, actor: "user", emoji: "👌", at: 2, seen: true });
    const html = renderToStaticMarkup(<MessageRow ts={1} copyText="hi" align="right" reaction={{ workerId: "w1", rowId: 7 }}><p>hi</p></MessageRow>);
    expect(html.startsWith('<div class="msg-row right"><p>hi</p><div class="msg-rx">')).toBe(true);
    expect(html.indexOf("rx-agent")).toBeLessThan(html.indexOf("rx-mine"));
    expect(html).toContain('title="The agent reacted"');
    expect(html).toMatch(/<button type="button" class="rx-chip rx-mine is-seen[^"]*"[^>]*title="Seen by the agent"/);
    // Another message's reactions are not this one's.
    expect(renderToStaticMarkup(<MessageRow reaction={{ workerId: "w1", rowId: 8 }}><p>x</p></MessageRow>)).not.toContain("msg-rx");
    expect(renderToStaticMarkup(<MessageRow><p>x</p></MessageRow>)).not.toContain("msg-rx");
  });

  const chip = (user) => renderToStaticMarkup(<ReactionChips reactions={{ user, agent: null }} onRemove={() => {}} />);

  it("says what becomes of the user's reaction: sending, seen, or with the next message", () => {
    expect(chip({ emoji: "👍", at: 1, seen: false, wakesUntil: Date.now() + 2000 })).toMatch(/title="Sending… click to undo".*class="rx-drain"/);
    expect(chip({ emoji: "👍", at: 1, seen: false })).toContain('title="Goes with your next message"');
    expect(chip({ emoji: "👍", at: 1, seen: false, wakesUntil: Date.now() - 1 })).not.toContain("rx-drain");
    const seen = chip({ emoji: "👍", at: 1, seen: true, wakesUntil: Date.now() + 2000 });
    expect(seen).toContain('title="Seen by the agent"');
    expect(seen).not.toContain("rx-drain");
  });

  it("pops in only a reaction that just appeared here", () => {
    expect(chip({ emoji: "👍", at: 1, seen: false, born: Date.now() })).toContain("is-new");
    expect(chip({ emoji: "👍", at: 1, seen: false, born: Date.now() - 5000 })).not.toContain("is-new");
    expect(chip({ emoji: "👍", at: 1, seen: false })).not.toContain("is-new");
  });

  const picks = (html) => [...html.matchAll(/<button type="button" class="rx-pick( is-on)?"[^>]*>([^<]+)<\/button>/g)].map((m) => [m[2], Boolean(m[1])]);

  it("opens the bar with six quick emoji and a plus, the user's own highlighted", () => {
    const html = renderToStaticMarkup(<ReactionPicker current="👌" onPick={() => {}} more={false} onToggleMore={() => {}} />);
    expect(picks(html)).toEqual(QUICK_EMOJI.map((e) => [e, e === "👌"]));
    expect(html).toContain('title="More emoji"');
    expect(html).not.toContain("rx-grid");
    expect(html.endsWith('<div class="rx-sep"></div>')).toBe(true);
  });

  it("opens the rest of the emoji below the quick row", () => {
    const html = renderToStaticMarkup(<ReactionPicker current={null} onPick={() => {}} more onToggleMore={() => {}} />);
    expect(html).toContain('<div class="rx-grid"');
    expect(picks(html).map(([e]) => e)).toEqual([...QUICK_EMOJI, ...MORE_EMOJI]);
  });
});

