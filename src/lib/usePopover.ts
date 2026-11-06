import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface PopoverPosition {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * Open state, refs and viewport-clamped placement for a portal menu anchored to a trigger.
 * The menu flips above the trigger when there is more room there, and closes on outside
 * pointer-down or Escape.
 */
export function usePopover(width: number, maxHeight: number) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const place = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      if (below >= Math.min(maxHeight, 280) || below >= above) {
        setPos({ left, top: r.bottom + 6, maxHeight: Math.min(maxHeight, below) });
      } else {
        const height = Math.min(maxHeight, above);
        setPos({ left, top: r.top - 6 - height, maxHeight: height });
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, width, maxHeight]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return { open, setOpen, pos, triggerRef, menuRef };
}
