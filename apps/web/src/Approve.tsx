import type { User } from "firebase/auth";
import { useState, type ReactNode } from "react";
import { api, ApiError, useLoad } from "./api.js";
import { useLocale, publicPath } from "./i18n.js";
import { icons } from "./ui.js";

/** Sends the browser on (back to ChatGPT); replaced in tests. */
export type Leave = (url: string) => void;

function Header({ title }: { title: string }) {
  return (
    <>
      <div className="connect-head">
        <span className="gpt" aria-hidden>
          AI
        </span>
        <span className="dots" aria-hidden>
          •••
        </span>
        <span className="logo">{icons.plate}</span>
      </div>
      <h1 className="h1 centered" style={{ fontSize: "1.5rem" }}>
        {title}
      </h1>
    </>
  );
}

function Who({ user, onSwitch }: { user: User; onSwitch: () => void }) {
  const { t } = useLocale();
  return (
    <section className="card split" style={{ padding: "0.75rem 0.9rem" }}>
      <div className="brand" style={{ fontSize: "0.95rem", minWidth: 0 }}>
        <span className="avatar">
          {(user.displayName ?? user.email ?? "?").slice(0, 1).toUpperCase()}
        </span>
        <div style={{ minWidth: 0 }}>
          {user.displayName ?? t("signedIn")}
          <div className="sub" style={{ fontWeight: 400, fontSize: "0.8rem" }}>
            {user.email}
          </div>
        </div>
      </div>
      <button className="btn secondary small" onClick={onSwitch}>
        {t("switchAccount")}
      </button>
    </section>
  );
}

export function ConsentCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { locale, t } = useLocale();
  return (
    <label className="check">
      <input
        id="consent"
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          onChange(e.target.checked);
        }}
      />
      <span>
        {t("consentText")} <a href={publicPath("privacy", locale)}>{t("privacyPolicy")}</a> ·{" "}
        <a href={publicPath("support", locale)}>{t("support")}</a>
      </span>
    </label>
  );
}

/** Who is signed in, what is allowed, the health-data consent when still needed, and the two answers. */
function Decide({
  user,
  title,
  permissions,
  consentRequired,
  allowLabel,
  onSwitch,
  decide,
}: {
  user: User;
  title: string;
  permissions: ReactNode;
  consentRequired: boolean;
  allowLabel: string;
  onSwitch: () => void;
  decide: (approve: boolean, consent: boolean) => Promise<void>;
}) {
  const { t } = useLocale();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (approve: boolean) => {
    setBusy(true);
    setError(null);
    decide(approve, consent).catch(() => {
      setBusy(false);
      setError("actionFailed");
    });
  };
  return (
    <>
      <Header title={title} />
      <Who user={user} onSwitch={onSwitch} />
      <section className="card" style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {permissions}
      </section>
      {consentRequired && <ConsentCheckbox checked={consent} onChange={setConsent} />}
      {error && (
        <div className="banner bad" role="alert">
          {t("actionFailed")}
        </div>
      )}
      <button
        className="btn primary"
        disabled={busy || (consentRequired && !consent)}
        onClick={() => {
          answer(true);
        }}
      >
        {allowLabel}
      </button>
      <button
        className="btn secondary"
        disabled={busy}
        onClick={() => {
          answer(false);
        }}
      >
        {t("cancel")}
      </button>
    </>
  );
}

const Perm = ({ ok, children }: { ok: boolean; children: ReactNode }) => (
  <div className="perm">
    {ok ? icons.check : icons.cross}
    <span>{children}</span>
  </div>
);

function Gone({ title, text }: { title: string; text: string }) {
  const { locale, t } = useLocale();
  return (
    <div className="card error" role="alert">
      <div className="art">{icons.alert}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      <a className="btn secondary" href={`/?lang=${locale}`}>
        {t("openDiary")}
      </a>
    </div>
  );
}

function Done({ title, text }: { title: string; text: string }) {
  return (
    <div className="card empty">
      <div className="art" style={{ background: "var(--data-soft)", color: "var(--data)" }}>
        {icons.check}
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

const notFound = (e: unknown) => e instanceof ApiError && e.status === 404;

/** OA-3: approving ChatGPT's connection request started by `/oauth/authorize` in this browser. */
export function ConnectScreen({
  user,
  onSwitch,
  leave,
}: {
  user: User;
  onSwitch: () => void;
  leave: Leave;
}) {
  const { t } = useLocale();
  const [load, retry] = useLoad(`connect:${user.uid}`, () =>
    api<{ consent_required: boolean }>(user, "GET", "/api/manage/oauth/request").catch(
      (e: unknown) => {
        if (notFound(e)) return null;
        throw e;
      },
    ),
  );
  const [leaving, setLeaving] = useState(false);
  if (leaving) return <Done title={t("returningChat")} text={t("closeIfNeeded")} />;
  if (load.state === "loading") return <Header title={t("connectTitle")} />;
  if (load.state === "error" || load.state === "expired") {
    return (
      <>
        <Gone title={t("requestLoadFailed")} text={t("checkConnection")} />
        <button className="btn primary" onClick={retry}>
          {t("retry")}
        </button>
      </>
    );
  }
  if (load.data === null) {
    return <Gone title={t("requestExpired")} text={t("restartConnect")} />;
  }
  return (
    <Decide
      user={user}
      title={t("connectQuestion")}
      consentRequired={load.data.consent_required}
      allowLabel={t("allow")}
      onSwitch={onSwitch}
      permissions={
        <>
          <b>{t("chatCan")}</b>
          <Perm ok>{t("diaryPermission")}</Perm>
          <Perm ok>{t("invitePermission")}</Perm>
          <Perm ok={false}>{t("noOtherPermission")}</Perm>
        </>
      }
      decide={async (approve, consent) => {
        const { redirect_to } = await api<{ redirect_to: string }>(
          user,
          "POST",
          "/api/manage/oauth/decision",
          {
            approve,
            ...(approve ? { consent } : {}),
          },
        );
        setLeaving(true);
        leave(redirect_to);
      }}
    />
  );
}

interface JoinInfo {
  join: { requested_by: string; already_joined: boolean };
  consent_required: boolean;
}

/** ID-4: adding this person's own profile to someone's ChatGPT connection from a one-time link. */
export function JoinScreen({
  user,
  code,
  onSwitch,
}: {
  user: User;
  code: string;
  onSwitch: () => void;
}) {
  const { t } = useLocale();
  const [load, retry] = useLoad(`join:${user.uid}:${code}`, () =>
    api<JoinInfo>(user, "GET", `/api/manage/join?code=${encodeURIComponent(code)}`).catch(
      (e: unknown) => {
        if (notFound(e) || (e instanceof ApiError && e.status === 400)) return null;
        throw e;
      },
    ),
  );
  const [result, setResult] = useState<"joined" | "declined" | null>(null);
  if (result === "joined") {
    return <Done title={t("joined")} text={t("returnUseDiary")} />;
  }
  if (result === "declined") return <Done title={t("notJoined")} text={t("nothingShared")} />;
  if (load.state === "loading") return <Header title={t("joinTitleLong")} />;
  if (load.state === "error" || load.state === "expired") {
    return (
      <>
        <Gone title={t("linkLoadFailed")} text={t("checkConnection")} />
        <button className="btn primary" onClick={retry}>
          {t("retry")}
        </button>
      </>
    );
  }
  if (load.data === null) {
    return <Gone title={t("linkExpired")} text={t("askNewLink")} />;
  }
  if (load.data.join.already_joined) {
    return <Done title={t("alreadyJoined")} text={t("alreadyAccess")} />;
  }
  const by = load.data.join.requested_by;
  return (
    <Decide
      user={user}
      title={t("joinQuestion", { name: by })}
      consentRequired={load.data.consent_required}
      allowLabel={t("join")}
      onSwitch={onSwitch}
      permissions={
        <>
          <b>{t("theirChatCan", { name: by })}</b>
          <Perm ok>{t("diaryPermission")}</Perm>
          <Perm ok={false}>{t("noDeletePermission")}</Perm>
          <p className="notice">{t("removeAnytime")}</p>
        </>
      }
      decide={async (approve, consent) => {
        await api(user, "POST", "/api/manage/join", {
          code,
          approve,
          ...(approve ? { consent } : {}),
        });
        setResult(approve ? "joined" : "declined");
      }}
    />
  );
}
