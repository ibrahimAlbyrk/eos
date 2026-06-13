// Inline SVG icon kit for the branch-management UI. Same conventions as the
// rest of the app: 14px default, stroke=currentColor, thin strokes — so a
// parent's `color` (accent / git / err) tints them. Kept in one place because
// the branch panel + its context menu reuse the same glyphs.

function Svg({ size = 14, children, ...props }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" {...props}
    >
      {children}
    </svg>
  );
}

export function BranchIcon(props) {
  return <Svg {...props}><circle cx="4" cy="4" r="1.5" /><circle cx="4" cy="12" r="1.5" /><circle cx="12" cy="8" r="1.5" /><path d="M4 5.5v5M5.5 8h5" /></Svg>;
}

export function PlusIcon(props) {
  return <Svg {...props}><path d="M8 3v10M3 8h10" /></Svg>;
}

// Circular-arrows = fetch (refresh remote-tracking refs).
export function FetchIcon(props) {
  return <Svg {...props}><path d="M13.5 7a5.5 5.5 0 0 0-9.4-3.4L2 5.5" /><path d="M2.5 9a5.5 5.5 0 0 0 9.4 3.4L14 10.5" /><path d="M2 2.5v3h3M14 13.5v-3h-3" /></Svg>;
}

export function TrashIcon(props) {
  return <Svg {...props}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8" /></Svg>;
}

export function PencilIcon(props) {
  return <Svg {...props}><path d="M11.5 1.5l3 3L5 14H2v-3z" /></Svg>;
}

export function CopyIcon(props) {
  return <Svg {...props}><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" /><path d="M3.5 10.5A1 1 0 0 1 2.5 9.5v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1" /></Svg>;
}

// Cloud = a remote-tracking branch.
export function CloudIcon(props) {
  return <Svg {...props}><path d="M4.5 12h6a3 3 0 0 0 .3-6A4 4 0 0 0 3.5 7 2.8 2.8 0 0 0 4 12z" /></Svg>;
}

export function CheckIcon(props) {
  return <Svg {...props} strokeWidth="1.9"><path d="m4 8 3 3 5-6" /></Svg>;
}

export function SearchIcon(props) {
  return <Svg {...props}><circle cx="7" cy="7" r="5" /><path d="m13 13-2.5-2.5" /></Svg>;
}

// Tiny inline spinner (header fetch / in-flight ops).
export function SpinnerIcon(props) {
  return <Svg {...props} className={"git-spin" + (props.className ? " " + props.className : "")}><path d="M8 2a6 6 0 1 1-6 6" /></Svg>;
}
