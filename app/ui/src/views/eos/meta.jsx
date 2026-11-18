import { isEosShown } from "../../state/eos/eosStatusStore.js";

export function EosModeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2.5 11.5h11M5 11.5a3 3 0 0 1 6 0M8 4.5V6M3.9 6.7l1 1M12.1 6.7l-1 1" />
    </svg>
  );
}

// Shown only while the core serves routines (state/eos/eosStatusStore.js).
export const eosMeta = { id: "eos", label: "Eos", Icon: EosModeIcon, visible: isEosShown };
