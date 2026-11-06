import { useEffect, useState } from "react";
import { moveFromPersonal, moveFromPersonalAvailable } from "../lib/ipc";
import { useSettings } from "../store/settings";

/**
 * Settings → General: when another (personal) E.V is on this Mac, bring everything from it into
 * this app once — keys, chats, memory, settings and running sessions. Its data is copied, never
 * removed, so the old app keeps working as a backup.
 */
export function MoveInCard() {
  const moved = useSettings((s) => s.settings.movedFromPersonal);
  const [available, setAvailable] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void moveFromPersonalAvailable().then(setAvailable).catch(() => {});
  }, []);
  if (!available || moved) return null;
  return (
    <div className="settings-card">
      <h4>Move my E.V into this app</h4>
      <p className="settings-intro">
        Another E.V is on this Mac. Bring everything from it here — API keys, chats, memory, learned tasks, passphrase and settings. Open Claude and terminal
        sessions keep running. E.V restarts once, then asks for the macOS permissions again (they belong to each app). The other app isn't changed, so it
        stays as a backup.
      </p>
      {confirm ? (
        <div className="update-actions">
          <button className="btn neon" onClick={() => void moveFromPersonal().catch((e) => setError(String(e)))}>
            Move everything and restart
          </button>
          <button className="btn ghost" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn" onClick={() => setConfirm(true)}>
          Move my E.V into this app…
        </button>
      )}
      {error && <p className="ob-error">{error}</p>}
    </div>
  );
}
