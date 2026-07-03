import { createPortal } from "react-dom";
import { useToasts } from "../../hooks/useToasts.js";
import { Toast } from "./Toast.jsx";

// The single app-wide toast region: fixed top-right, portalled to document.body
// (like ImageLightbox / PushButton) so it sits in the top layer above every
// panel and modal, unaffected by any parent overflow/transform.
//
// Politeness rides each card's role (status = polite, alert = assertive for
// errors) rather than two separate live sub-regions, so the visual stack stays
// in one chronological column. Newest renders on top (store appends newest last;
// we reverse for display).
export function ToastViewport() {
  const toasts = useToasts();
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="toast-viewport" role="region" aria-label="Notifications">
      {toasts.slice().reverse().map((t) => (
        <Toast key={t.id} {...t} />
      ))}
    </div>,
    document.body,
  );
}
