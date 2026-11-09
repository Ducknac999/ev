import { listen } from "@tauri-apps/api/event";
import { appLoginItem, appQuitMode, notchMessage } from "../lib/ipc";
import { useChats } from "../store/chats";
import { useSettings } from "../store/settings";
import { isRunning, stopGeneration } from "./chatRunner";
import { exitTalkMode } from "./voiceControl";

/**
 * Quitting without losing the notch (src-tauri/src/app_mode.rs). ⌘Q hides E.V to the notch:
 * chats stop answering and Talk mode turns off here, while the notch, clipboard, dictation, music
 * and ☕ keep working. "Quit E.V completely" is in the notch and the menu-bar icon.
 */

const TOLD_KEY = "ev.quitToNotchTold";

function configure(): void {
  const { background, notch } = useSettings.getState().settings;
  void appQuitMode(background.keepNotchOnQuit && notch.mode === "ev").catch(() => {});
}

let started = false;

export function startAppMode(): void {
  if (started) return;
  started = true;
  configure();
  // Login Items follow the setting (asked first, so nothing changes if it already matches).
  const syncLogin = (want: boolean) =>
    void appLoginItem(null)
      .then((on) => (on === want ? on : appLoginItem(want)))
      .catch(() => {});
  syncLogin(useSettings.getState().settings.background.openAtLogin);
  useSettings.subscribe((state, previous) => {
    const now = state.settings;
    const before = previous.settings;
    if (now.background !== before.background || now.notch.mode !== before.notch.mode) configure();
    if (now.background.openAtLogin !== before.background.openAtLogin) syncLogin(now.background.openAtLogin);
  });
  void listen("app-quit-to-notch", () => {
    for (const chat of useChats.getState().chats) if (isRunning(chat.id)) stopGeneration(chat.id);
    exitTalkMode();
    if (!localStorage.getItem(TOLD_KEY)) {
      localStorage.setItem(TOLD_KEY, "1");
      void notchMessage("say", "E.V's window is closed — the notch is still here. Quit completely with ⏻ in the notch.", 7).catch(() => {});
    }
  }).catch(() => {});
}
