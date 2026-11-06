import { createPortal } from "react-dom";
import { lockHolder } from "../lib/locks";
import { usePopover } from "../lib/usePopover";
import { modelLabel, modelsFor, PROVIDER_ORDER, PROVIDERS, sameModel } from "../providers/catalog";
import { useChats } from "../store/chats";
import { useSettings } from "../store/settings";
import type { Chat, ModelRef } from "../types";
import { Icon } from "./Icon";

const MENU_WIDTH = 300;
const MENU_MAX_HEIGHT = 520;

export function ProviderDot({ provider }: { provider: ModelRef["provider"] }) {
  return <span className={`provider-dot provider-${provider}`} aria-hidden="true" />;
}

/** Model dropdown rendered in a portal so it is never clipped by small or scrolling cards. */
export function ModelPicker({ chat }: { chat: Chat }) {
  const { open, setOpen, pos, triggerRef, menuRef } = usePopover(MENU_WIDTH, MENU_MAX_HEIGHT);
  const settings = useSettings((s) => s.settings);
  const chats = useChats((s) => s.chats);
  const requestModel = useChats((s) => s.requestModel);

  const choose = (model: ModelRef) => {
    setOpen(false);
    requestModel(chat.id, model);
  };

  const hasKeys = (provider: ModelRef["provider"]) =>
    provider === "claude" || settings.providers[provider].keys.length > 0;

  return (
    <>
      <button
        ref={triggerRef}
        className={`model-trigger${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change model"
      >
        <ProviderDot provider={chat.model.provider} />
        <span className="model-trigger-label">{modelLabel(chat.model)}</span>
        {PROVIDERS[chat.model.provider].locked && <Icon name="lock" size={11} className="lock-icon" />}
        <Icon name="chevron" size={11} className="muted" />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="model-menu"
            role="listbox"
            style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight, width: MENU_WIDTH }}
          >
            {PROVIDER_ORDER.map((provider) => {
              const info = PROVIDERS[provider];
              const holder = lockHolder(chats, { provider, model: "" }, chat.id);
              return (
                <div key={provider} className="model-group">
                  <div className="model-group-head">
                    <ProviderDot provider={provider} />
                    <span className="model-group-name">{info.label}</span>
                    {info.locked ? (
                      <span className="tag tag-locked" title={holder ? `In use by ${holder.title}` : "One active chat at a time"}>
                        <Icon name="lock" size={9} /> {holder ? `IN USE · ${holder.title}` : "EXCLUSIVE"}
                      </span>
                    ) : (
                      <span className="tag tag-free">CONCURRENT</span>
                    )}
                    {!hasKeys(provider) && <span className="tag tag-warn">NO KEYS</span>}
                  </div>
                  {modelsFor(provider, settings).map((m) => {
                    const ref = { provider, model: m.id };
                    const selected = sameModel(ref, chat.model);
                    return (
                      <button
                        key={m.id}
                        role="option"
                        aria-selected={selected}
                        className={`model-option${selected ? " selected" : ""}`}
                        onClick={() => choose(ref)}
                      >
                        <span>{m.label}</span>
                        {selected && <Icon name="check" size={13} />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
