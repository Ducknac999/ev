import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../store/settings";
import { openSettingsAt, useUi } from "../store/ui";
import { latestRelease, releasesToShow, type WhatsNewCard, type WhatsNewPicture, type WhatsNewRelease } from "../whatsNew";

/**
 * "What's new": opens once by itself after an update (never on a fresh install — setup covers
 * that), or from Settings → Updates. One card per bigger change, then the smaller fixes.
 */

type Slide = { kind: "card"; release: WhatsNewRelease; card: WhatsNewCard } | { kind: "smaller"; release: WhatsNewRelease };

function slidesOf(releases: WhatsNewRelease[]): Slide[] {
  return releases.flatMap((release) => [
    ...release.cards.map((card) => ({ kind: "card" as const, release, card })),
    ...(release.smaller.length ? [{ kind: "smaller" as const, release }] : []),
  ]);
}

function formatDate(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

/** A small drawing of a Settings page with one spot circled. */
function SettingsPicture({ page, children }: { page: "Backups" | "Updates"; children: React.ReactNode }) {
  return (
    <div className="wn-pic wn-settings" aria-hidden="true">
      <div className="wn-dots">
        <i />
        <i />
        <i />
      </div>
      <div className="wn-settings-row">
        <div className="wn-nav">
          <span className="wn-nav-title">Settings</span>
          <span className="wn-nav-group">App</span>
          <span className="wn-nav-item">General</span>
          <span className={`wn-nav-item${page === "Backups" ? " on" : ""}`}>Backups</span>
          <span className={`wn-nav-item${page === "Updates" ? " on" : ""}`}>Updates</span>
        </div>
        <div className="wn-page">
          <span className="wn-page-title">{page}</span>
          {children}
        </div>
      </div>
    </div>
  );
}

function Picture({ kind }: { kind: WhatsNewPicture }) {
  if (kind === "restored") {
    return (
      <div className="wn-pic wn-app" aria-hidden="true">
        <div className="wn-dots">
          <i />
          <i />
          <i />
        </div>
        <div className="wn-banner wn-spot">E.V closed unexpectedly last time. Your chats and sessions were restored as they were. <b>OK</b></div>
        <div className="wn-app-row">
          <div className="wn-side">
            <span className="on">Trip planning</span>
            <span>Claude · website</span>
            <span>Codex · api</span>
            <span>Terminal</span>
          </div>
          <div className="wn-panes">
            <div className="wn-pane">
              <span className="wn-line w80" />
              <span className="wn-line w60" />
              <span className="wn-line w70 accent" />
            </div>
            <div className="wn-pane term">
              <span className="wn-line w50" />
              <span className="wn-line w70" />
              <span className="wn-line w40" />
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (kind === "backups") {
    return (
      <SettingsPicture page="Backups">
        <span className="wn-label">Backup folder</span>
        <span className="wn-code">~/Documents/E.V Backups</span>
        <span className="wn-label">How often</span>
        <div className="wn-chips wn-spot">
          <span>Off</span>
          <span>Every hour</span>
          <span className="on">Every day</span>
          <span>Every week</span>
          <span>Custom</span>
        </div>
        <div className="wn-check">
          <i /> Keep deleted chats in the backup
        </div>
        <div className="wn-check">
          <i /> Never delete old backups
        </div>
      </SettingsPicture>
    );
  }
  if (kind === "secrets") {
    return (
      <SettingsPicture page="Backups">
        <span className="wn-label">What's kept</span>
        <div className="wn-check">
          <i /> Include Claude Code and Codex conversations
        </div>
        <div className="wn-row wn-spot">
          <span>
            <b>Include API keys and the memory key</b>
            <small>Locked with your backup password</small>
          </span>
          <span className="wn-btn">Set password</span>
        </div>
        <span className="wn-code">••••••••••</span>
      </SettingsPicture>
    );
  }
  if (kind === "deleted") {
    return (
      <SettingsPicture page="Backups">
        <span className="wn-label">Deleted chats kept in the backup</span>
        <div className="wn-row wn-spot">
          <span>
            <b>Recipe ideas</b>
            <small>Deleted yesterday 6:40 PM</small>
          </span>
          <span className="wn-btn">Bring back</span>
        </div>
        <div className="wn-row">
          <span>
            <b>Old notes</b>
            <small>Deleted Mon 9:12 AM</small>
          </span>
          <span className="wn-btn">Bring back</span>
        </div>
      </SettingsPicture>
    );
  }
  return (
    <SettingsPicture page="Updates">
      <span className="wn-label">What's new</span>
      <span className="wn-small">What changed in this version, with a picture of where each thing is.</span>
      <span className="wn-btn wn-spot">Show what's new</span>
      <span className="wn-label">Updates</span>
      <span className="wn-small">E.V is up to date.</span>
    </SettingsPicture>
  );
}

export function WhatsNew() {
  const open = useUi((s) => s.whatsNewOpen);
  const onboarded = useSettings((s) => s.settings.onboarded);
  const [version, setVersion] = useState("");
  const [auto, setAuto] = useState<WhatsNewRelease[] | null>(null);
  const [index, setIndex] = useState(0);
  const nextRef = useRef<HTMLButtonElement>(null);

  // After an update: once, by itself.
  useEffect(() => {
    void getVersion()
      .then((current) => {
        setVersion(current);
        if (!useSettings.getState().settings.onboarded) return;
        const releases = releasesToShow(current, useSettings.getState().settings.whatsNewSeen);
        if (releases.length) setAuto(releases);
        else if (useSettings.getState().settings.whatsNewSeen !== current) void markSeen(current);
      })
      .catch(() => {});
  }, []);

  const releases = useMemo(() => (open ? latestRelease(version) : (auto ?? [])), [open, auto, version]);
  const slides = useMemo(() => slidesOf(releases), [releases]);
  const visible = onboarded && slides.length > 0 && (open || auto !== null);

  useEffect(() => setIndex(0), [open, auto]);
  useEffect(() => {
    if (visible) nextRef.current?.focus();
  }, [visible, index]);

  const close = () => {
    setAuto(null);
    useUi.setState({ whatsNewOpen: false });
    if (version) void markSeen(version);
  };

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.stopPropagation(), close());
      else if (e.key === "ArrowRight") (e.stopPropagation(), setIndex((i) => Math.min(slides.length - 1, i + 1)));
      else if (e.key === "ArrowLeft") (e.stopPropagation(), setIndex((i) => Math.max(0, i - 1)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  if (!visible) return null;
  const slide = slides[Math.min(index, slides.length - 1)];
  const last = index >= slides.length - 1;
  const versions = releases.map((r) => r.version);
  const title = versions.length > 1 ? `What's new since E.V ${versions[versions.length - 1]}` : `What's new in E.V ${slide.release.version}`;

  return (
    <div className="modal-backdrop wn-backdrop">
      <div className="wn" role="dialog" aria-modal="true" aria-labelledby="wn-title">
        <header className="wn-head">
          <div>
            <h2 id="wn-title">{title}</h2>
            <p>
              Version {slide.release.version} · {formatDate(slide.release.date)}
            </p>
          </div>
          <button className="icon-btn ghost" title="Close" aria-label="Close" onClick={close}>
            ✕
          </button>
        </header>

        <section className="wn-body" key={index}>
          {slide.kind === "card" ? (
            <>
              <Picture kind={slide.card.picture} />
              <div className="wn-text">
                <span className={`wn-tag tag-${slide.card.tag.toLowerCase()}`}>{slide.card.tag}</span>
                <h3>{slide.card.title}</h3>
                <p>{slide.card.text}</p>
                {slide.card.show && (
                  <button
                    className="btn"
                    onClick={() => {
                      const show = slide.card.show!;
                      close();
                      openSettingsAt(show.page, show.anchor);
                    }}
                  >
                    Show me
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="wn-text wn-smaller">
              <span className="wn-tag tag-fix">Fix</span>
              <h3>Smaller fixes</h3>
              <ul>
                {slide.release.smaller.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <footer className="wn-foot">
          <button className="btn ghost" disabled={index === 0} onClick={() => setIndex(index - 1)}>
            Back
          </button>
          <div className="wn-pager" aria-label={`${index + 1} of ${slides.length}`}>
            {slides.map((_, i) => (
              <button key={i} className={i === index ? "on" : ""} aria-label={`Go to ${i + 1}`} onClick={() => setIndex(i)} />
            ))}
          </div>
          <button ref={nextRef} className="btn neon" onClick={() => (last ? close() : setIndex(index + 1))}>
            {last ? "Got it" : "Next"}
          </button>
        </footer>
      </div>
    </div>
  );
}

async function markSeen(version: string): Promise<void> {
  const s = useSettings.getState();
  if (s.settings.whatsNewSeen === version) return;
  await s.save({ ...s.settings, whatsNewSeen: version }).catch(() => {});
}
