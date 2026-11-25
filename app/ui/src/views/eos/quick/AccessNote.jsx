import { useEffect, useState } from "react";

// Why the panel arrives empty (D38): without Accessibility Eos cannot read
// what the front app has selected. The system asked once, at the first
// press; this line stays until the user allows it.
export function AccessNote({ doors }) {
  const [access, setAccess] = useState(null);
  useEffect(() => { doors?.accessibility?.().then(setAccess, () => {}); }, [doors]);
  if (!access?.available || access.trusted) return null;
  return <AccessLine onOpen={() => void doors.openAccessibilitySettings().catch(() => {})} />;
}

export function AccessLine({ onOpen }) {
  return (
    <div className="eos-quick__note" role="status">
      <span className="eos-quick__note-text">Allow Eos in Accessibility, and this panel arrives holding what you selected in the app in front.</span>
      <button type="button" className="eos-btn" onClick={onOpen}>Open Settings</button>
    </div>
  );
}
