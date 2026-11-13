import type { User } from "firebase/auth";
import { useState } from "react";
import { api, useLoad, type Connection, type Me } from "./api.js";
import { fullDate } from "./dates.js";
import { navigate } from "./router.js";
import { ConsentCheckbox } from "./Approve.js";
import { useLocale, publicPath, LanguagePicker } from "./i18n.js";
import { icons, Loaded, Sheet, ChatAction } from "./ui.js";

type Pending = { kind: "leave"; connection: Connection } | { kind: "delete" } | null;

/** Profile name, ChatGPT connections that reach this profile, privacy and data deletion (WB-3). */
export function SettingsScreen({
  user,
  signIn,
  signOut,
}: {
  user: User;
  signIn: () => void;
  signOut: () => void;
}) {
  const { locale, t } = useLocale();
  const [consent, setConsent] = useState(false);
  const [load, retry] = useLoad(`${user.uid}:settings`, async () => {
    const [me, connections] = await Promise.all([
      api<Me>(user, "GET", "/api/manage/me"),
      api<{ items: Connection[] }>(user, "GET", "/api/manage/connections"),
    ]);
    return { me, connections: connections.items };
  });
  const [pending, setPending] = useState<Pending>(null);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const act = (action: () => Promise<unknown>, after: () => void) => {
    setError(null);
    action().then(after, () => {
      setError("actionFailed");
    });
  };
  const close = () => {
    setPending(null);
    setConfirm("");
    setError(null);
  };
  const failure = error && (
    <div className="banner bad" role="alert">
      {t("actionFailed")}
    </div>
  );
  return (
    <>
      <div className="daynav settings-nav">
        <button
          className="iconbtn"
          aria-label={t("back")}
          onClick={() => {
            navigate("/");
          }}
        >
          {icons.left}
        </button>
        <div className="date">
          <b>{t("settings")}</b>
        </div>
        <LanguagePicker />
      </div>
      {!pending && failure}
      <Loaded load={load} what={t("settings")} retry={retry} signIn={signIn} cards={2}>
        {({ me, connections }) => (
          <>
            <section className="card">
              <div className="brand">
                <span className="avatar">{me.profile.name.slice(0, 1).toUpperCase()}</span>
                <div style={{ minWidth: 0 }}>
                  <div>{me.user.display_name}</div>
                  <div className="sub" style={{ fontWeight: 400 }}>
                    {user.email ?? t("signedIn")}
                  </div>
                </div>
              </div>
            </section>

            <div className="section-title">{t("profileName")}</div>
            <section className="card">
              <b>{me.profile.name}</b>
              <ChatAction
                label={t("changeInChat")}
                prompt={t("renamePrompt", { name: me.profile.name })}
              />
            </section>

            <div className="section-title">{t("connections")}</div>
            {connections.length === 0 ? (
              <p className="notice">{t("notConnected")}</p>
            ) : (
              <div className="list">
                {connections.map((c) => (
                  <div className="row" key={c.connection_id}>
                    <span className="l">
                      <b>{c.connected_by_me ? t("connectedByYou") : t("joinedByLink")}</b>
                      <span>
                        {t("sinceDate", { date: fullDate(c.linked_at.slice(0, 10), locale) })}
                        {c.last_used_at
                          ? ` · ${t("lastUsedDate", { date: fullDate(c.last_used_at.slice(0, 10), locale) })}`
                          : ""}
                      </span>
                    </span>
                    <button
                      className="btn secondary small"
                      onClick={() => {
                        setError(null);
                        setPending({ kind: "leave", connection: c });
                      }}
                    >
                      {t("remove")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {me.consent_required && (
              <section className="card">
                <h3>{t("optionalConsent")}</h3>
                <ConsentCheckbox checked={consent} onChange={setConsent} />
                <button
                  className="btn primary"
                  disabled={!consent}
                  onClick={() => {
                    act(
                      () =>
                        api(user, "POST", "/api/manage/consent", {
                          version: me.consent_version,
                          consent: true,
                        }),
                      () => {
                        setConsent(false);
                        retry();
                      },
                    );
                  }}
                >
                  {t("saveConsent")}
                </button>
              </section>
            )}
            <div className="section-title">{t("privacy")}</div>
            <div className="list">
              <div className="row">
                <span className="l">
                  <b>{t("dataConsent")}</b>
                  <span>
                    {me.user.consent_at
                      ? t("givenDate", { date: fullDate(me.user.consent_at.slice(0, 10), locale) })
                      : t("consentOnConnect")}
                  </span>
                </span>
              </div>
              <a
                className="row"
                href={publicPath("privacy", locale)}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(publicPath("privacy", locale));
                }}
              >
                <span className="l">
                  <b>{t("privacyPolicy")}</b>
                </span>
                <span className="chev">›</span>
              </a>
              <a
                className="row"
                href={publicPath("terms", locale)}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(publicPath("terms", locale));
                }}
              >
                <span className="l">
                  <b>{t("terms")}</b>
                </span>
                <span className="chev">›</span>
              </a>
              <button
                className="row"
                onClick={() => {
                  setError(null);
                  setPending({ kind: "delete" });
                }}
              >
                <span className="l">
                  <b className="danger">{t("deleteMyData")}</b>
                </span>
                <span className="chev">›</span>
              </button>
            </div>
            <button className="btn secondary" onClick={signOut}>
              {t("signOut")}
            </button>

            {pending?.kind === "leave" && (
              <Sheet label={t("removeConnection")} onClose={close}>
                <h2>{t("removeConnectionQuestion")}</h2>
                <p className="notice">{t("removeConnectionNote")}</p>
                {failure}
                <button
                  className="btn danger"
                  onClick={() => {
                    act(
                      () =>
                        api(
                          user,
                          "DELETE",
                          `/api/manage/connections/${pending.connection.connection_id}`,
                        ),
                      () => {
                        close();
                        retry();
                      },
                    );
                  }}
                >
                  {t("remove")}
                </button>
                <button className="btn secondary" onClick={close}>
                  {t("cancel")}
                </button>
              </Sheet>
            )}
            {pending?.kind === "delete" && (
              <Sheet label={t("deleteMyData")} onClose={close}>
                <h2>{t("deleteQuestion")}</h2>
                <p className="notice">{t("deleteNote")}</p>
                {failure}
                <label className="field">
                  <span>{t("typeDelete")}</span>
                  <input
                    id="confirm-delete"
                    autoComplete="off"
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.target.value);
                    }}
                  />
                </label>
                <button
                  className="btn danger"
                  disabled={confirm !== "delete"}
                  onClick={() => {
                    act(
                      () => api(user, "DELETE", "/api/manage/me"),
                      () => {
                        close();
                        signOut();
                      },
                    );
                  }}
                >
                  {t("deleteEverything")}
                </button>
                <button className="btn secondary" onClick={close}>
                  {t("cancel")}
                </button>
              </Sheet>
            )}
          </>
        )}
      </Loaded>
    </>
  );
}
