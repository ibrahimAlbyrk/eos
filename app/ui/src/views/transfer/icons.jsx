// Stroke icons for the Transfer tab (16-unit grid, currentColor) — the ones the
// machine surfaces don't already have (components/machines/icons.jsx).

const Svg = ({ size = 14, children, strokeWidth = 1.5 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const TransferIcon = () => <Svg strokeWidth={1.3}><path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" /></Svg>;
export const SwapIcon = () => <Svg><path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" /></Svg>;
export const IntoIcon = ({ size = 14 }) => <Svg size={size} strokeWidth={1.6}><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" /></Svg>;
export const OutIcon = ({ size = 14 }) => <Svg size={size} strokeWidth={1.6}><path d="M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13.5h10" /></Svg>;
export const PauseIcon = () => <Svg size={13} strokeWidth={1.6}><path d="M6 4v8M10 4v8" /></Svg>;
export const PlayIcon = () => <Svg size={13} strokeWidth={1.5}><path d="M5.5 3.8v8.4L12 8z" /></Svg>;
export const BackIcon = () => <Svg size={13} strokeWidth={1.6}><path d="m10 4-4 4 4 4" /></Svg>;
export const ChevronDownIcon = () => <Svg size={12} strokeWidth={1.6}><path d="m4 6 4 4 4-4" /></Svg>;
export const ChevronRightIcon = () => <Svg size={12} strokeWidth={1.6}><path d="m6 4 4 4-4 4" /></Svg>;
export const FolderIcon = () => <Svg strokeWidth={1.4}><path d="M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z" /></Svg>;
