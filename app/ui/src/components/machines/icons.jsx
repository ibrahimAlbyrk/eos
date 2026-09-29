// Stroke icons for the machine surfaces (16-unit grid, currentColor).

const Svg = ({ size = 15, children, strokeWidth = 1.4 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const CheckIcon = () => <Svg size={14} strokeWidth={2}><path d="m3 8 3 3 7-7" /></Svg>;
export const PlusIcon = () => <Svg strokeWidth={1.5}><path d="M8 3v10M3 8h10" /></Svg>;
export const GridIcon = () => (
  <Svg>
    <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" /><rect x="9" y="9" width="4.5" height="4.5" rx="1" />
  </Svg>
);
export const ShieldIcon = () => <Svg><path d="M8 1.8 13 3.8v4c0 3-2.2 5.2-5 6.4C5.2 13 3 10.8 3 7.8v-4z" /></Svg>;
export const UpDownIcon = () => <Svg size={12} strokeWidth={1.5}><path d="m5 6 3-3 3 3M5 10l3 3 3-3" /></Svg>;
export const LanIcon = ({ size = 14 }) => <Svg size={size}><path d="M2 6.3a9 9 0 0 1 12 0M4.3 8.9a5.8 5.8 0 0 1 7.4 0M6.5 11.4a2.6 2.6 0 0 1 3 0" /></Svg>;
export const CloudIcon = ({ size = 14 }) => <Svg size={size}><path d="M4.6 12.5h6.8a2.8 2.8 0 0 0 .3-5.6 3.9 3.9 0 0 0-7.4.8 2.4 2.4 0 0 0 .3 4.8z" /></Svg>;
export const LockIcon = ({ size = 14 }) => <Svg size={size}><rect x="3.5" y="7" width="9" height="6.5" rx="1.3" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></Svg>;
export const WindowIcon = () => <Svg><rect x="2" y="3" width="12" height="10" rx="1.6" /><path d="M2 6h12" /></Svg>;
export const RefreshIcon = () => <Svg><path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.8v3h-3" /></Svg>;
export const PowerIcon = () => <Svg strokeWidth={1.5}><path d="M8 2v5.5" /><path d="M4.6 4.4a5 5 0 1 0 6.8 0" /></Svg>;
export const HomeIcon = () => <Svg><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h8V6.5" /></Svg>;
export const LinkIcon = () => <Svg><path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" /></Svg>;
export const CopyIcon = () => <Svg><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></Svg>;
export const QrIcon = () => (
  <Svg><rect x="2.5" y="2.5" width="4" height="4" rx=".6" /><rect x="9.5" y="2.5" width="4" height="4" rx=".6" /><rect x="2.5" y="9.5" width="4" height="4" rx=".6" /><path d="M9.5 9.5h1.5v1.5M13.5 9.5v4h-4" /></Svg>
);
export const WarnIcon = ({ size = 16 }) => <Svg size={size} strokeWidth={1.5}><path d="M8 2.5 14 13H2z" /><path d="M8 6.5v3M8 11.4v.1" /></Svg>;
export const BellIcon = () => <Svg><path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3z" /><path d="M6.5 14h3" /></Svg>;
export const CloseIcon = () => <Svg size={14} strokeWidth={1.5}><path d="M4 4l8 8M12 4l-8 8" /></Svg>;
