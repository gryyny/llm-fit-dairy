import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Load, Source } from "./api.js";
import { useLocale } from "./i18n.js";

const svg = (path: ReactNode, strokeWidth = 1.8) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} aria-hidden>
    {path}
  </svg>
);

export const icons = {
  day: svg(
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>,
  ),
  history: svg(
    <>
      <path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5" />
      <path d="M4 4v4.5h4.5M12 8v4.5l3 2" />
    </>,
  ),
  foods: svg(
    <>
      <path d="M4 11h16a8 8 0 0 1-16 0Z" />
      <path d="M9 7c0-2 2-2 2-4M13 7c0-2 2-2 2-4" />
    </>,
  ),
  body: svg(
    <>
      <path d="M3 17l5-6 4 3 4-6 5 5" />
      <path d="M3 20h18" />
    </>,
  ),
  gear: svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>,
  ),
  search: svg(
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>,
    2,
  ),
  refresh: svg(
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M5.5 8a7 7 0 0 1 11.6-2L20 9M4 15l2.9 3A7 7 0 0 0 18.5 16" />
    </>,
  ),
  left: svg(<path d="M15 5l-7 7 7 7" />, 2),
  right: svg(<path d="M9 5l7 7-7 7" />, 2),
  check: svg(<path d="M5 12.5l4.5 4.5L19 7.5" />, 2),
  cross: svg(<path d="M6 6l12 12M18 6L6 18" />, 2),
  plate: svg(
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.5" />
    </>,
    1.6,
  ),
  alert: svg(
    <>
      <path d="M12 4l9 16H3Z" />
      <path d="M12 10v4M12 17v.5" />
    </>,
  ),
  google: (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.5 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8Z"
      />
      <path
        fill="#34A853"
        d="M12 23c3 0 5.5-1 7.3-2.7l-3.5-2.7c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2.1v2.8A11 11 0 0 0 12 23Z"
      />
      <path fill="#FBBC05" d="M5.7 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.1a11 11 0 0 0 0 9.8l3.6-2.8Z" />
      <path
        fill="#EA4335"
        d="M12 5.4c1.6 0 3 .6 4.2 1.6l3.1-3.1A11 11 0 0 0 2.1 7.1l3.6 2.8C6.6 7.3 9.1 5.4 12 5.4Z"
      />
    </svg>
  ),
};

export function SourceBadge({ source }: { source: Source }) {
  const { t } = useLocale();
  const label = t(source);
  return <span className={`src ${source}`}>{label}</span>;
}

export function Skeleton({ cards = 3 }: { cards?: number }) {
  const { t } = useLocale();
  return (
    <div aria-busy="true" aria-label={t("loading")} style={{ display: "contents" }}>
      {Array.from({ length: cards }, (_, i) => (
        <div className="card" key={i}>
          <div className="sk" style={{ height: "0.9rem", width: "40%" }} />
          <div
            className="sk"
            style={{ height: i === 0 ? "2.5rem" : "0.8rem", width: "70%", marginTop: "0.8rem" }}
          />
          <div className="sk" style={{ height: "0.6rem", marginTop: "0.8rem" }} />
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, text, say }: { title: string; text?: string; say?: string }) {
  return (
    <div className="card empty">
      <div className="art">{icons.plate}</div>
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {say && <div className="say">{say}</div>}
    </div>
  );
}

function ErrorState({ what, retry }: { what: string; retry: () => void }) {
  const { t } = useLocale();
  return (
    <div className="card error" role="alert">
      <div className="art">{icons.alert}</div>
      <h3>{t("loadFailed", { what })}</h3>
      <p>{t("checkConnection")}</p>
      <button className="btn primary" onClick={retry}>
        {t("retry")}
      </button>
    </div>
  );
}

function Expired({ signIn }: { signIn: () => void }) {
  const { t } = useLocale();
  return (
    <div className="banner" role="status">
      {t("expired")}
      <button onClick={signIn}>{t("signIn")}</button>
    </div>
  );
}

/** Renders a load's loading, error and expired states, and its data through `children`. */
export function Loaded<T>({
  load,
  what,
  retry,
  signIn,
  cards,
  children,
}: {
  load: Load<T>;
  what: string;
  retry: () => void;
  signIn: () => void;
  cards?: number;
  children: (data: T) => ReactNode;
}) {
  if (load.state === "loading") return <Skeleton cards={cards} />;
  if (load.state === "error") return <ErrorState what={what} retry={retry} />;
  if (load.state === "expired") return <Expired signIn={signIn} />;
  return <>{children(load.data)}</>;
}

/** A bottom sheet; the scrim or Escape closes it. */
export function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>(".sheet-close")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const controls = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              "button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary",
            ),
          ].filter((element) => element.getClientRects().length > 0);
          const first = controls[0];
          const last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <div className="grabber" />
        <div className="sheet-tools">
          <button className="iconbtn sheet-close" aria-label={t("close")} onClick={onClose}>
            {icons.cross}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Pages outside the diary tabs: the centred column with the brand linking home. */
export function Standalone({ children, busy = false }: { children?: ReactNode; busy?: boolean }) {
  const { locale } = useLocale();
  return (
    <div className="frame">
      <main className="content page" aria-busy={busy || undefined}>
        <div className="standalone-brand">
          <a className="brand" href={`/?lang=${locale}`}>
            <span className="logo">{icons.plate}</span>Food diary
          </a>
        </div>
        {children}
      </main>
    </div>
  );
}

export function ChatAction({ label, prompt }: { label: string; prompt: string }) {
  const { t } = useLocale();
  const [copy, setCopy] = useState<{ prompt: string; status: "copied" | "copyFailed" } | null>(
    null,
  );
  return (
    <details className="chat-action">
      <summary>{label}</summary>
      <p>{prompt}</p>
      <div className="chat-actions">
        <button
          className="btn secondary small"
          onClick={() => {
            Promise.resolve()
              .then(() => navigator.clipboard.writeText(prompt))
              .then(
                () => {
                  setCopy({ prompt, status: "copied" });
                },
                () => {
                  setCopy({ prompt, status: "copyFailed" });
                },
              );
          }}
        >
          {t("copyPrompt")}
        </button>
        <a
          className="btn secondary small"
          href="https://chatgpt.com/"
          target="_blank"
          rel="noreferrer"
        >
          {t("openChat")}
        </a>
      </div>
      {copy?.prompt === prompt && (
        <p className="fine" role="status">
          {t(copy.status)}
        </p>
      )}
    </details>
  );
}
