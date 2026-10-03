// Small stroke glyphs shared by the Changes panel's header, menus and cards.

const S = { fill: "none", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" };

export const BranchGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...S}><circle cx="4.5" cy="3.8" r="1.5" /><circle cx="4.5" cy="12.2" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" /><path d="M4.5 5.3v5.4M11.5 7c0 2.5-3 3-7 3.7" /></svg>
);
export const EditGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...S}><path d="M9.8 3.2 12.8 6.2 6 13H3v-3z" /><path d="m8.5 4.5 3 3" /></svg>
);
export const CommitGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...S}><circle cx="8" cy="8" r="2.6" /><path d="M1.5 8h3.9M10.6 8h3.9" /></svg>
);
export const StashGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...S}><path d="M2.5 9.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" /><path d="M2.5 9.5 4 3.5h8l1.5 6H10a2 2 0 0 1-4 0z" /></svg>
);
export const CheckGlyph = () => (
  <svg className="cx-check" width="13" height="13" viewBox="0 0 16 16" {...S} strokeWidth="1.8"><path d="m3 8.5 3.5 3.5L13 5" /></svg>
);
export const ChevronDown = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" {...S} strokeWidth="1.6"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></svg>
);
export const ArrowRight = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" {...S}><path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5" /></svg>
);
export const MoreGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="12.5" cy="8" r="1.1" /></svg>
);
export const RefreshGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...S}><path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 3v2.5h-2.5" /></svg>
);
export const SplitGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...S}><rect x="2" y="3" width="12" height="10" rx="2" /><path d="M8 3v10" /></svg>
);
export const TreeGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...S}><path d="M3 3.5h4M5 3.5v8.5h3M5 8h3" /><rect x="9" y="6.3" width="4" height="3.4" rx="1" /><rect x="9" y="10.3" width="4" height="3.4" rx="1" /></svg>
);
export const EyeGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...S}><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" /><circle cx="8" cy="8" r="1.9" /></svg>
);
export const OpenGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" {...S}><path d="M5 11 11 5M6 5h5v5" /></svg>
);
export const SearchGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" {...S}><circle cx="7.2" cy="7.2" r="4.3" /><path d="m10.5 10.5 3 3" /></svg>
);
export const InfoGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" {...S}><circle cx="8" cy="8" r="5.8" /><path d="M8 7.3v3.4" /><circle cx="8" cy="5.2" r=".8" fill="currentColor" stroke="none" /></svg>
);
export const PrevGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" {...S}><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>
);
export const NextGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" {...S}><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>
);
export const ReviewGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" {...S}><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" /><path d="m5.8 7.5 1.5 1.5 3-3" /></svg>
);
