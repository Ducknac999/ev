import { useEffect, useState } from "react";
import { gbQuit, gbSignin, gbStatus, type BrowserStatus } from "../lib/ipc";
import { openBrowserPanel } from "../services/browserPanel";
import { useVault } from "../store/vault";

/**
 * Settings → Connections: the E.V Browser — E.V's own hidden copy of Vivaldi with its own
 * logins. Signing in opens it normally (Google refuses sign-in in a browser that's being
 * controlled); once signed in, E.V uses it hidden and stays logged in.
 */
export function GideonBrowserSettings() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const routes = useVault((s) => s.recipes.length);
  const clearRoutes = useVault((s) => s.clearRecipes);

  useEffect(() => {
    const refresh = () => void gbStatus().then(setStatus, () => setStatus(null));
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const run = (what: Promise<void>, ok: string) =>
    what.then(
      () => setMessage({ ok: true, text: ok }),
      (err) => setMessage({ ok: false, text: String(err) }),
    );

  const state = !status
    ? "…"
    : !status.installed
      ? "Vivaldi isn't installed"
      : status.signingIn
        ? "Open for signing in — quit it (⌘Q) when you're done"
        : status.running
          ? status.visible
            ? "Running, on screen"
            : "Running hidden"
          : "Starts by itself when E.V needs it";

  return (
    <div className="settings-card">
      <h4>E.V Browser</h4>
      <p className="settings-intro">
        E.V's own copy of Vivaldi with its own logins — separate from your Vivaldi, which it never sees unless you say “my Vivaldi”. It runs hidden: no window, no Dock
        icon, your mouse and keyboard untouched. Inside it E.V browses, clicks, types, signs in and posts without asking; money pages and buttons, passwords, codes and
        file uploads stay blocked.
      </p>
      <div className={`status-line ${status?.running || status?.signingIn ? "ok" : ""}`}>{state}</div>
      <p className="settings-intro">
        To give it a Google account: press <b>Sign in</b>, sign into the account you made for E.V (never your personal one), then quit that window with ⌘Q. Google only lets
        you sign in while E.V isn't controlling it, so this opens it the normal way. If Google ever signs it out, do this again.
      </p>
      <div className="connection-actions">
        <button className="btn small primary" disabled={!status?.installed || status?.signingIn} onClick={() => void run(gbSignin(), "Signed-in window opened — sign in, then ⌘Q.")}>
          Sign in
        </button>
        <button className="btn small" disabled={!status?.installed || status?.signingIn} onClick={() => openBrowserPanel()}>
          Open the Browser panel
        </button>
        <button className="btn small deny" disabled={!status?.running} onClick={() => void run(gbQuit(), "Closed.")}>
          Quit
        </button>
      </div>
      {message && <div className={`status-line ${message.ok ? "ok" : "bad"}`}>{message.text}</div>}
      <p className="settings-intro">
        Learned routes: {routes} task{routes === 1 ? "" : "s"} E.V remembers how to do.{" "}
        {routes > 0 && (
          <button className="link-btn" onClick={clearRoutes}>
            Forget them
          </button>
        )}
      </p>
      {status && <p className="connection-source">Data folder: {status.profile}</p>}
    </div>
  );
}
