import { useEffect, useRef } from "react";
import { api } from "../api/client.js";
import { createReconnectingStream } from "../api/sse.js";

export function useWebNotifications() {
  const permissionRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().then((p) => { permissionRef.current = p; });
    } else {
      permissionRef.current = Notification.permission;
    }
  }, []);

  useEffect(() => {
    if (streamRef.current) streamRef.current.close();
    const s = createReconnectingStream({
      onChange(e) {
        if (document.visibilityState !== "hidden") return;
        if (permissionRef.current !== "granted") return;
        try {
          const data = JSON.parse(e.data);
          if (data.reason !== "notification:fire") return;
          const { title, body, workerId } = data.payload ?? {};
          if (!title) return;
          const n = new Notification(title, { body: body ?? "", tag: `eos-${workerId}` });
          n.onclick = () => {
            window.focus();
            window.__nativeNavigate?.(workerId);
          };
        } catch {}
      },
    });
    streamRef.current = s;
    return () => {
      s.close();
      streamRef.current = null;
    };
  }, []);
}
