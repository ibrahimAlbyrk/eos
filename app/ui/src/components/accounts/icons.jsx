// Mono-line icons for the Accounts surfaces (24-unit grid, 1.8 stroke — the
// app's icon style).

const Svg = ({ size = 14, children, className }) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const ExternalIcon = (p) => <Svg {...p}><path d="M7 17L17 7M9 7h8v8" /></Svg>;
export const ArrowIcon = (p) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const CheckIcon = (p) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const CloseIcon = (p) => <Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const KeyIcon = (p) => <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3" /></Svg>;
export const CopyIcon = (p) => (
  <Svg {...p}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
);
export const UserIcon = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.5 20c1.4-3.6 4.3-5.5 7.5-5.5s6.1 1.9 7.5 5.5" />
  </Svg>
);
export const EyeIcon = ({ off, ...p }) => (
  <Svg {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M4 4l16 16" />}
  </Svg>
);
export const Spinner = ({ size = 14 }) => (
  <Svg size={size} className="acc-spin">
    <circle cx="12" cy="12" r="9" opacity="0.2" />
    <path d="M21 12a9 9 0 0 0-9-9" />
  </Svg>
);
