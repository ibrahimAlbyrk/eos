import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

export function ImageLightbox({ src, alt, children }) {
  const [open, setOpen] = useState(false);
  const [animating, setAnimating] = useState(false);
  const thumbRef = useRef(null);
  const imgRef = useRef(null);
  const [origin, setOrigin] = useState(null);

  const scale = useRef(1);
  const pan = useRef({ x: 0, y: 0 });
  const smooth = useRef(true);

  const apply = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    el.style.transition = smooth.current
      ? "transform 250ms cubic-bezier(0.4,0,0.2,1), opacity 250ms ease"
      : "opacity 250ms ease";
    el.style.transform = `translate(${pan.current.x}px, ${pan.current.y}px) scale(${scale.current})`;
    el.style.cursor = scale.current > 1.05 ? "zoom-out" : "zoom-in";
  }, []);

  const resetZoom = useCallback(() => {
    scale.current = 1;
    pan.current = { x: 0, y: 0 };
    smooth.current = true;
    apply();
  }, [apply]);

  const show = useCallback(() => {
    const el = thumbRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setOrigin({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height });
    scale.current = 1;
    pan.current = { x: 0, y: 0 };
    smooth.current = true;
    setOpen(true);
    requestAnimationFrame(() => setAnimating(true));
  }, []);

  const hide = useCallback(() => {
    setAnimating(false);
    setTimeout(() => setOpen(false), 250);
  }, []);

  const onImgClick = useCallback((e) => {
    e.stopPropagation();
    if (scale.current > 1.05) {
      resetZoom();
    } else {
      const img = imgRef.current;
      if (!img) return;
      const r = img.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      scale.current = 2;
      pan.current = { x: -(e.clientX - cx), y: -(e.clientY - cy) };
      smooth.current = true;
      apply();
    }
  }, [resetZoom, apply]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") hide(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hide]);

  useEffect(() => {
    if (!open || !animating) return;
    const onWheel = (e) => {
      e.preventDefault();
      const img = imgRef.current;
      if (!img) return;

      if (e.ctrlKey) {
        const mx = e.clientX - window.innerWidth / 2;
        const my = e.clientY - window.innerHeight / 2;

        const prev = scale.current;
        const next = clamp(prev * (1 - e.deltaY * 0.01), 0.5, 8);

        pan.current = {
          x: mx - (next / prev) * (mx - pan.current.x),
          y: my - (next / prev) * (my - pan.current.y),
        };
        scale.current = next;
        smooth.current = false;
        apply();
      } else if (scale.current > 1.01) {
        pan.current = {
          x: pan.current.x - e.deltaX,
          y: pan.current.y - e.deltaY,
        };
        smooth.current = false;
        apply();
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [open, animating, apply]);

  const entryTransform = origin
    ? `translate(${origin.x - window.innerWidth / 2}px, ${origin.y - window.innerHeight / 2}px) scale(${origin.w / Math.min(window.innerWidth * 0.85, 1200)})`
    : undefined;

  return (
    <>
      <span ref={thumbRef} className="lightbox-trigger" onClick={show}>
        {children}
      </span>
      {open && createPortal(
        <div className={`lightbox-overlay${animating ? " in" : ""}`} onClick={hide}>
          <img
            ref={imgRef}
            src={src}
            alt={alt}
            className="lightbox-img"
            style={!animating ? { transform: entryTransform } : undefined}
            onClick={onImgClick}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
