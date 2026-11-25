// The gallery's states of a routine's Page beyond the samples as they stand:
// read slowly, refused or gone; the designer at work, checking or refused by
// its checks; a new version kept; and what the reader opened on it (the
// issues, Share, its words to edit).
import { ROUTES } from "../../../api/routes.js";
import { applyDesignChange, reshape } from "../../../state/eos/pageStore.js";
import paper from "./sample/paper.json";
import pages from "./sample/paper-pages.json";

const PAPER = paper.surface.id;
const AT = `eos:/surfaces/${PAPER}`;
const CHANGING = `${AT}?mode=reshape`;

const press = (selector, text) => [...document.querySelectorAll(selector)].find((b) => b.textContent.trim().startsWith(text))?.click();

// Writes answer as the core does for a change to the page: a designer's run.
const designing = async (method, path) => (path === ROUTES.surfaceReshape(PAPER)
  ? { ok: true, status: 202, body: { runId: "rn-design" } }
  : { ok: true, status: 200, body: {} });

const said = () => void reshape(PAPER, { baseVersion: 2, instruction: "Give the desk column more room" });

// Version 4, refused by its checks at two widths.
const refused = (s) => ({
  ...s,
  [ROUTES.surfaceVersion(PAPER, 4)]: {
    ...paper.versionBodies["2"],
    meta: { ...paper.versionBodies["2"].meta, version: 4, status: "failed", note: "The desk column takes a third." },
    checks: { passed: false, probe: [{ widths: [
      { width: 390, findings: [{ check: "readable", part: "desk", detail: "text under 12 px at phone width" }] },
      { width: 1280, findings: [{ check: "narrow", part: "lead", detail: "the headline runs past the sheet" }, { check: "readable", part: "desk", detail: "text under 12 px at phone width" }] },
    ] }] },
  },
});

const withCandidate = (s) => ({ ...s, [ROUTES.surface(PAPER)]: { ...paper.surface, candidateVersion: 3 } });

export const PAGE_STATES = [
  { id: "page-loading", label: "Page · loading", location: AT, answer: "loading" },
  { id: "page-error", label: "Page · cannot read", location: AT, answer: "error" },
  { id: "page-gone", label: "Page · no longer here", location: AT, reads: (s) => {
    const { [ROUTES.surface(PAPER)]: _, ...rest } = s;
    return rest;
  } },
  { id: "page-issues", label: "Page · the issues open", location: AT, then: () => press(".eos-issues__pick", "Issue") },
  { id: "page-share", label: "Page · Share open", location: AT, then: () => press(".eos-head__side button", "Share") },
  { id: "page-mail", label: "Page · its mail preview", location: AT,
    reads: (s) => ({ ...s, [ROUTES.surfaceIssueMail(PAPER, "si-7b3m1c000003")]: pages.mail }),
    then: () => {
      press(".eos-head__side button", "Share");
      setTimeout(() => press(".eos-menu button", "Mail preview"), 200);
    } },
  { id: "page-edit", label: "Page · editing its words", location: AT, then: () => press(".eos-page-end button", "Edit its words") },
  { id: "page-working", label: "Page · Eos redrawing it", location: CHANGING, sends: designing, then: said },
  { id: "page-checking", label: "Page · a new version being checked", location: CHANGING, then: () => applyDesignChange({ surfaceId: PAPER, version: 4, phase: "checking" }) },
  { id: "page-failed", label: "Page · a new version refused by its checks", location: CHANGING, reads: refused, then: () => applyDesignChange({ surfaceId: PAPER, version: 4, phase: "failed" }) },
  { id: "page-kept", label: "Page · a new version kept", location: CHANGING, reads: withCandidate, sends: designing, then: () => press(".eos-reshape__lead button", "Keep version") },
];
