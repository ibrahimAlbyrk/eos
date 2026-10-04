import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileAvatar } from "./ProfileAvatar.jsx";
import { ProfileMenuHeader } from "./ProfileMenuHeader.jsx";
import { ProfileInterview } from "./ProfileInterview.jsx";
import { mergeProfilePatch } from "../../lib/profileText.js";

const EMPTY = {
  rev: 7, updatedAt: 0,
  identity: { fullName: "", callName: "", handle: "", avatar: null },
  language: { chat: null, code: null },
  work: { roles: [], stack: [], level: null },
  style: { replies: null, autonomy: null, whenUnclear: null, commits: null },
  instructions: "", sharing: { withholdFrom: [] }, budgetTokens: 800, onboardedAt: null,
};
const IBRAHIM = mergeProfilePatch(EMPTY, {
  identity: { fullName: "Ibrahim Albayrak", callName: "Ibrahim" },
  language: { chat: "tr", code: "en" },
  work: { roles: ["engineering"] },
});

describe("ProfileAvatar", () => {
  it("photo › orb with initials › placeholder", () => {
    expect(renderToStaticMarkup(<ProfileAvatar profile={mergeProfilePatch(IBRAHIM, { identity: { avatar: "png" } })} />))
      .toMatch(/<img class="prof-avatar prof-avatar--photo" src="[^"]*\/api\/profile\/avatar\?v=7"/);
    expect(renderToStaticMarkup(<ProfileAvatar profile={IBRAHIM} />)).toContain(">IA</span>");
    expect(renderToStaticMarkup(<ProfileAvatar profile={EMPTY} className="sb-settings__avatar" />))
      .toContain('class="prof-avatar prof-avatar--empty sb-settings__avatar"');
  });
});

describe("ProfileMenuHeader", () => {
  it("an empty profile invites set-up", () => {
    const html = renderToStaticMarkup(<ProfileMenuHeader profile={EMPTY} onOpen={() => {}} />);
    expect(html).toContain("Introduce yourself");
    expect(html).toContain("Set up profile");
  });

  it("a set profile shows name and subtitle", () => {
    const html = renderToStaticMarkup(<ProfileMenuHeader profile={IBRAHIM} onOpen={() => {}} />);
    expect(html).toContain(">Ibrahim Albayrak<");
    expect(html).toContain("Engineering · Türkçe / English");
  });
});

describe("ProfileInterview", () => {
  it("opens on the name question with the live card", () => {
    const html = renderToStaticMarkup(<ProfileInterview profile={EMPTY} onClose={() => {}} onSkip={() => {}} onOpenProfile={() => {}} />);
    expect(html).toContain("What should your agents call you?");
    expect(html).toContain("Skip for now");
    expect(html).toContain("What every agent reads first");
    expect(html.match(/class="intv__seg/g)).toHaveLength(4);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Continue/); // nothing typed yet
  });
});

