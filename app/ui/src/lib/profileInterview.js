// The first-run profile interview as data: its steps, the answers it collects,
// how they become one profile patch, and the live card's lines. A new question
// is a step here plus its body in ProfileInterview.jsx.

import { AUTONOMY_OPTIONS, CHAT_LANGUAGE_OPTIONS, LANGUAGE_OPTIONS, REPLY_OPTIONS, ROLE_OPTIONS } from "./profileOptions.js";
import { isProfileEmpty } from "./profileText.js";

export const INTERVIEW_STEPS = [
  { id: "name", title: "What should your agents call you?", sub: "Your full name stays on this Mac. Agents use the short one." },
  { id: "work", title: "What do you mostly work on?", sub: "Pick any, and add the tools you use." },
  { id: "language", title: "Which languages?", sub: "Chatting and shipping can differ." },
  { id: "style", title: "How should agents talk to you?", sub: "The same finished task, reported three ways." },
];

// The same fix, as each reply style would report it.
export const REPLY_SAMPLES = {
  terse: "Fixed. delivery.ts —\nACK raced the echo.\nTest added, green.",
  balanced: "Fixed the race in delivery.ts:\nthe ACK arrived before the\necho. Added a regression test.",
  thorough: "Root cause: the ACK raced the\ncomposer echo. Why it broke,\nwhat I tried, next steps…",
};

export function initialAnswers(profile) {
  const p = profile;
  return {
    fullName: p?.identity.fullName ?? "",
    callName: p?.identity.callName ?? "",
    roles: p?.work.roles ?? [],
    stack: p?.work.stack ?? [],
    chat: p?.language.chat ?? null,
    code: p?.language.code ?? null,
    replies: p?.style.replies ?? null,
    autonomy: p?.style.autonomy ?? null,
  };
}

// One save at the end; onboardedAt marks the interview done.
export function answersToPatch(a, now) {
  return {
    identity: { fullName: a.fullName.trim(), callName: a.callName.trim() },
    work: { roles: a.roles, stack: a.stack },
    language: { chat: a.chat, code: a.code },
    style: { replies: a.replies, autonomy: a.autonomy },
    onboardedAt: now,
  };
}

export function canContinue(stepId, a) {
  if (stepId === "name") return Boolean(a.callName.trim() || a.fullName.trim());
  return true;
}

const label = (options, v) => options.find((o) => o.value === v)?.label ?? v;

// The live card: one line per step, filled once reached; the current one lit.
export function cardLines(a, stepIndex) {
  const work = [a.roles.map((r) => label(ROLE_OPTIONS, r)).join(", "), a.stack.join(", ")].filter(Boolean).join(" · ");
  const lang = [
    a.chat && (a.chat === "mirror" ? "Mirrors your language" : `Chat in ${label(CHAT_LANGUAGE_OPTIONS, a.chat)}`),
    a.code && `code in ${label(LANGUAGE_OPTIONS, a.code)}`,
  ].filter(Boolean).join(" · ");
  const style = [a.replies && `${label(REPLY_OPTIONS, a.replies)} replies`, a.autonomy && label(AUTONOMY_OPTIONS, a.autonomy).toLowerCase()]
    .filter(Boolean).join(", ");
  const values = [a.callName.trim() || a.fullName.trim(), work, lang, style];
  return ["Call me", "Work", "Language", "Style"].map((l, i) => ({
    label: l,
    value: values[i],
    filled: i <= stepIndex && Boolean(values[i]),
    current: i === stepIndex,
  }));
}

// Offer it once: the profile was never set up and the user never skipped it.
export function shouldOfferInterview(profile, settings) {
  return Boolean(profile) && profile.onboardedAt == null && isProfileEmpty(profile)
    && !settings?.["onboarding.profileDismissed"];
}
