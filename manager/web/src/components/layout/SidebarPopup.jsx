import { useEffect, useState } from "react";

// Popup chrome around a view's sidebar("popup") content. Switching tabs from
// inside the popup remounts it (each view renders its own AppLayout); replaying
// the entry animation then reads as a close/reopen flicker. Track the last
// unmount at module scope and skip the animation on an immediate remount.
let lastUnmount = 0;

export function SidebarPopup({ children }) {
  const [animate] = useState(() => performance.now() - lastUnmount > 100);

  useEffect(() => () => { lastUnmount = performance.now(); }, []);

  return (
    <div className={"side-handle-popup side-island" + (animate ? "" : " side-handle-popup--no-anim")}>
      {children}
    </div>
  );
}
