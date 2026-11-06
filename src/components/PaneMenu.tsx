import { createPortal } from "react-dom";
import { usePopover } from "../lib/usePopover";
import { Icon, type IconName } from "./Icon";

/**
 * A panel's ⋯ menu: everything that used to be a row of small buttons in its header. Items are
 * grouped; a group starting with `divider` gets a line above it.
 */
export interface PaneMenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
}

export function PaneMenu({ items, label = "More" }: { items: PaneMenuItem[]; label?: string }) {
  const { open, setOpen, pos, triggerRef, menuRef } = usePopover(240, 420);
  return (
    <>
      <button
        ref={triggerRef}
        className={`icon-btn ghost pane-menu-btn${open ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        aria-label={label}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={menuRef} className="pane-menu" role="menu" style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}>
            {items.map((item) => (
              <div key={item.label}>
                {item.divider && <div className="pane-menu-line" />}
                <button
                  className={`pane-menu-item${item.danger ? " danger" : ""}`}
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  <Icon name={item.icon} size={13} />
                  <span>{item.label}</span>
                  {item.hint && <kbd>{item.hint}</kbd>}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
