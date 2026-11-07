import { startNotch } from "./services/notchBridge";
import { prewarmRouter } from "./services/router";
import { useCallback, useEffect, useState } from "react";
import { Onboarding } from "./components/Onboarding";
import { Icon } from "./components/Icon";
import { ClosedChatsDrawer } from "./components/ClosedChatsDrawer";
import { ConfirmDeleteModal } from "./components/ConfirmDeleteModal";
import { LockConflictModal } from "./components/LockConflictModal";
import { OrbStage } from "./components/OrbStage";
import { SessionPanel } from "./components/SessionPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { Workspace } from "./components/Workspace";
import { openExternal } from "./lib/ipc";
import { closeChat, requestDelete, toggleCollapsed } from "./services/chatLifecycle";
import { stopGeneration } from "./services/chatRunner";
import { startUsageMonitor } from "./services/usageMonitor";
import { startNativeDrop } from "./services/nativeDrop";
import { startNotchLink } from "./services/notchLink";
import { startHoldToTalk } from "./services/holdToTalk";
import { startApprovalPopup } from "./services/approvalPopup";
import { startQuickPanel } from "./services/quickPanel";
import { refreshBalance } from "./services/spending";
import { startTerminals, writeToTerminal } from "./services/terminals";
import { startVoiceApprovals } from "./services/voiceApproval";
import { listen } from "@tauri-apps/api/event";
import { stopEverything } from "./services/chatRunner";
import { startReminders } from "./services/schedule";
import { pruneChatMemories, startVault, useVault } from "./store/vault";
import { syncConnections } from "./providers/agent/connections";
import { useConnectionErrors } from "./components/ConnectionsSettings";
import { useLayoutPrefs } from "./store/layoutPrefs";
import { useSessionPanel } from "./store/sessionPanel";
import { stopSpeaking, toggleTalkMode } from "./services/voiceControl";
import { activeChats, useChats } from "./store/chats";
import { useNotice } from "./store/notice";
import { useSettings } from "./store/settings";
import { useVoice } from "./store/voice";
import type { LayoutMode } from "./types";

const LAYOUT_CYCLE: LayoutMode[] = ["hud", "focus", "tray"];

function useGlobalShortcuts(openSettings: () => void, toggleClosed: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chats = useChats.getState();
      const focused = chats.focusedChatId;
      const settings = useSettings.getState().settings;

      if (e.key === "Escape") {
        if (useVoice.getState().speaking) {
          e.preventDefault();
          stopSpeaking();
        }
        return;
      }
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();

      const handled = (() => {
        if (!e.shiftKey && key === "n") return useSessionPanel.getState().open({ mode: "new" }), true;
        if (!e.shiftKey && key === "t") {
          const id = chats.createSession(settings, { kind: "shell", cwd: settings.recentFolders[0] ?? "~" });
          chats.focusChat(id);
          return true;
        }
        if (!e.shiftKey && key === "b") return useLayoutPrefs.getState().toggleSidebar(), true;
        if (!e.shiftKey && key === ",") return openSettings(), true;
        if (!e.shiftKey && key === ".") {
          const chat = chats.chats.find((c) => c.id === focused);
          if (chat?.kind === "ai") stopGeneration(chat.id);
          else if (chat) writeToTerminal(chat.id, "\x03");
          return true;
        }
        if (!e.shiftKey && key === "\\") {
          const next = LAYOUT_CYCLE[(LAYOUT_CYCLE.indexOf(chats.layout) + 1) % LAYOUT_CYCLE.length];
          return chats.setLayout(next), true;
        }
        if (!e.shiftKey && /^[1-9]$/.test(key)) {
          const target = activeChats(chats.chats)[Number(key) - 1];
          if (!target) return true;
          if (chats.layout === "focus") chats.openInFocus(target.id);
          else {
            if (target.collapsed) chats.setCollapsed(target.id, false);
            chats.focusChat(target.id);
          }
          return true;
        }
        if (e.shiftKey && key === "m") return focused && toggleCollapsed(focused), true;
        if (e.shiftKey && key === "w") return focused && closeChat(focused), true;
        if (e.shiftKey && key === "backspace") return focused && requestDelete(focused), true;
        if (e.shiftKey && key === "a") return toggleClosed(), true;
        if (e.shiftKey && key === "t") return toggleTalkMode(), true;
        if (e.shiftKey && key === "v") {
          // The speaker of the chat you're in.
          if (!focused || useChats.getState().chats.find((c) => c.id === focused)?.kind !== "ai") return true;
          const on = !useVoice.getState().speakers[focused];
          if (!on) stopSpeaking();
          useVoice.getState().setSpeaker(focused, on);
          return true;
        }
        return false;
      })();
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSettings, toggleClosed]);
}

/** Route markdown links to the default browser instead of navigating the app webview. */
function useExternalLinks() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        void openExternal(href);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}

function NoticeToast() {
  const notice = useNotice((s) => s.notice);
  const dismiss = useNotice((s) => s.dismiss);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(dismiss, 5000);
    return () => window.clearTimeout(timer);
  }, [notice, dismiss]);
  if (!notice) return null;
  return (
    <div className="toast toast-info" role="status" key={notice.id}>
      <span className="toast-text">{notice.message}</span>
      {notice.action && (
        <button
          className="btn neon small"
          onClick={() => {
            notice.action?.();
            dismiss();
          }}
        >
          {notice.actionLabel}
        </button>
      )}
      <button className="icon-btn ghost" onClick={dismiss} aria-label="Dismiss">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function VoiceToast() {
  const error = useVoice((s) => s.error);
  const setError = useVoice((s) => s.setError);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 7000);
    return () => window.clearTimeout(timer);
  }, [error, setError]);
  if (!error) return null;
  return (
    <div className="toast" role="alert">
      <Icon name="alert" size={14} />
      <span>{error}</span>
      <button className="icon-btn ghost" onClick={() => setError(null)} aria-label="Dismiss">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function emergencyStop(): void {
  const stopped = stopEverything();
  useNotice.getState().show({ message: stopped ? `Emergency stop — halted ${stopped} running task${stopped === 1 ? "" : "s"}.` : "Emergency stop — nothing was running." });
}

let lastEscape = 0;
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const now = Date.now();
  if (now - lastEscape < 600) emergencyStop();
  lastEscape = now;
});

export default function App() {
  const loaded = useSettings((s) => s.loaded);
  const loadError = useSettings((s) => s.loadError);
  const mode = useVoice((s) => s.mode);
  const onboarded = useSettings((s) => s.settings.onboarded);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closedOpen, setClosedOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const toggleClosed = useCallback(() => setClosedOpen((o) => !o), []);
  const closeDrawer = useCallback(() => setClosedOpen(false), []);

  useEffect(() => {
    void useSettings.getState().load();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    startUsageMonitor();
    void listen("emergency-stop", () => emergencyStop()).catch(() => {});
    startTerminals();
    startVoiceApprovals();
    void startVault().then(() => {
      startReminders();
      const prune = () => pruneChatMemories(new Set(useChats.getState().chats.map((c) => c.id)));
      prune();
      useChats.subscribe((state, previous) => {
        if (state.chats !== previous.chats) prune();
      });
      // Connections run only while switched on (Settings → Connections).
      const sync = () => {
        const { loaded: open, connections } = useVault.getState();
        if (open) void syncConnections(connections).then((errors) => useConnectionErrors.setState(errors));
      };
      sync();
      useVault.subscribe((state, previous) => {
        if (state.connections !== previous.connections) sync();
      });
    });
    void startNotchLink().catch(() => {});
    void startNativeDrop().catch(() => {});
    startHoldToTalk();
    startApprovalPopup();
    startQuickPanel();
    startNotch();
    prewarmRouter();
    void refreshBalance(true);
  }, [loaded]);

  useGlobalShortcuts(openSettings, toggleClosed);
  useExternalLinks();

  if (!loaded) return <div className="boot" />;

  return (
    <div className={`app mode-${mode}`}>
      <div className="ambient" aria-hidden="true" />
      <TopBar onOpenSettings={openSettings} onOpenClosed={toggleClosed} />
      {loadError && <div className="banner-error">Settings could not be read: {loadError}</div>}
      <div className="main-row">
        <Sidebar />
        <main className="workspace">
          <Workspace onOpenClosed={() => setClosedOpen(true)} />
        </main>
      </div>
      <OrbStage />
      <ClosedChatsDrawer open={closedOpen} onClose={closeDrawer} />
      <LockConflictModal />
      <ConfirmDeleteModal />
      <SessionPanel />
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <VoiceToast />
      <NoticeToast />
      {!onboarded && <Onboarding />}
    </div>
  );
}
