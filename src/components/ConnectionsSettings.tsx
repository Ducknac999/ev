import { useEffect, useState } from "react";
import { create } from "zustand";
import { connectionForgetSecrets, connectionSetSecret, connectionsCatalog, openExternal, passphraseCheck, type ConnectionInfo } from "../lib/ipc";
import { runningConnections } from "../providers/agent/connections";
import { refreshPassphraseStatus } from "../services/voiceApproval";
import { useVault } from "../store/vault";
import { Icon } from "./Icon";

/** Why a switched-on connection couldn't start, by id (set by the background sync). */
export const useConnectionErrors = create<Record<string, string>>(() => ({}));

/**
 * Settings → Connections. Every checked, free connection, each with its own Connect button.
 * Not connected = E.V has no access at all. Connecting or disconnecting needs the passphrase;
 * account keys go straight to the Keychain and are never shown again.
 */
export function ConnectionsSettings() {
  const connected = useVault((s) => s.connections);
  const loaded = useVault((s) => s.loaded);
  const errors = useConnectionErrors();
  const [catalog, setCatalog] = useState<ConnectionInfo[]>([]);
  const [phrase, setPhrase] = useState("");
  const [hasPassphrase, setHasPassphrase] = useState<boolean | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; ok: boolean; text: string } | null>(null);
  const [, tick] = useState(0);

  const refresh = () => connectionsCatalog().then(setCatalog, () => setCatalog([]));
  useEffect(() => {
    void refresh();
    void refreshPassphraseStatus().then(setHasPassphrase);
    // Starting a connection can take a while the first time (it downloads): keep the status fresh.
    const timer = window.setInterval(() => {
      tick((n) => n + 1);
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const confirmPassphrase = async (id: string): Promise<boolean> => {
    if (!hasPassphrase) {
      setMessage({ id, ok: false, text: "Set your passphrase first (Settings → Voice) — connecting needs it." });
      return false;
    }
    if (!(await passphraseCheck(phrase).catch(() => false))) {
      setMessage({ id, ok: false, text: "That's not your passphrase." });
      return false;
    }
    return true;
  };

  const connect = async (c: ConnectionInfo) => {
    setMessage(null);
    if (!(await confirmPassphrase(c.id))) return;
    setBusy(c.id);
    try {
      for (const s of c.secrets) {
        const value = secrets[`${c.id}:${s.env}`]?.trim();
        if (value) await connectionSetSecret(c.id, s.env, value);
        else if (!s.saved) throw new Error(`Enter the ${s.label} first.`);
      }
      setSecrets((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(`${c.id}:`))));
      useConnectionErrors.setState({ [c.id]: "" });
      useVault.getState().setConnection(c.id, true);
      setPhrase("");
      setMessage({ id: c.id, ok: true, text: "Connecting… the first start can take a minute while it downloads." });
    } catch (err) {
      setMessage({ id: c.id, ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const disconnect = async (c: ConnectionInfo, forget: boolean) => {
    setMessage(null);
    if (!(await confirmPassphrase(c.id))) return;
    useVault.getState().setConnection(c.id, false);
    if (forget) await connectionForgetSecrets(c.id).catch(() => {});
    setPhrase("");
    setMessage({ id: c.id, ok: true, text: forget ? "Disconnected and its keys deleted from the Keychain." : "Disconnected. E.V has no access to it now." });
    void refresh();
  };

  if (!loaded) return <div className="settings-card"><div className="status-line bad">Connections are stored with your memory, which couldn't be opened.</div></div>;

  const live = new Set(runningConnections());
  return (
    <div className="settings-card connections-settings">
      <h4>Connections</h4>
      <p className="settings-intro">
        Free, checked services E.V can use. Nothing here is connected until you press <b>Connect</b> — and anything not connected is never started, so no AI
        can reach it. Every connected tool follows your approval rules: reading is free, changes ask, sending and deleting show a preview, money is never
        allowed.
      </p>
      <label className="field">
        <span>Your passphrase — needed to connect or disconnect</span>
        <input type="password" autoComplete="off" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="Type your passphrase" />
      </label>

      <div className="connection-list">
        {catalog.map((c) => {
          const on = connected.includes(c.id);
          const running = live.has(c.id);
          const error = errors[c.id];
          const status = !on ? "Not connected" : running ? "Connected" : error ? `Couldn't start: ${error}` : "Starting…";
          return (
            <div key={c.id} className={`connection${on ? " on" : ""}`}>
              <div className="connection-head">
                <span className={`status-line ${on && running ? "ok" : on && error ? "bad" : ""}`}>
                  <Icon name={on && running ? "check" : on && error ? "alert" : "link"} size={13} />
                  <b>{c.name}</b>
                </span>
                <span className="connection-state">{status}</span>
              </div>
              <p className="connection-desc">{c.description}</p>
              {c.account && (
                <p className="connection-account">
                  <b>Needs:</b> {c.account}{" "}
                  {c.setupUrl && (
                    <button className="link-btn" onClick={() => void openExternal(c.setupUrl!)}>
                      How to set it up
                    </button>
                  )}
                </p>
              )}
              {!on &&
                c.secrets.map((s) => (
                  <label key={s.env} className="field">
                    <span>
                      {s.label}
                      {s.saved ? " · saved in Keychain" : ""}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder={s.saved ? "Saved — type to replace" : `Paste the ${s.label}`}
                      value={secrets[`${c.id}:${s.env}`] ?? ""}
                      onChange={(e) => setSecrets((all) => ({ ...all, [`${c.id}:${s.env}`]: e.target.value }))}
                    />
                  </label>
                ))}
              {!c.runnable && <p className="connection-account bad">Needs {c.id === "google" ? "uv (brew install uv)" : "Node.js (nodejs.org)"} on this Mac.</p>}
              <div className="connection-actions">
                <span className="connection-source">{c.source}</span>
                {on ? (
                  <>
                    {c.secrets.length > 0 && (
                      <button className="btn small" onClick={() => void disconnect(c, true)}>
                        Disconnect and delete keys
                      </button>
                    )}
                    <button className="btn small deny" onClick={() => void disconnect(c, false)}>
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button className="btn small primary" disabled={busy === c.id || !c.runnable} onClick={() => void connect(c)}>
                    {busy === c.id ? "Connecting…" : "Connect"}
                  </button>
                )}
              </div>
              {message?.id === c.id && <div className={`status-line ${message.ok ? "ok" : "bad"}`}>{message.text}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
