import { useState, type ReactNode } from "react";
import { icons } from "./ui.js";
import { useLocale, publicPath } from "./i18n.js";
import type { StaticMessageKey } from "./messages.js";

export function SignIn({
  heading,
  google,
  password,
  signUp,
  reset,
}: {
  heading: ReactNode;
  google: () => Promise<void>;
  password: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  reset: (email: string) => Promise<void>;
}) {
  const { locale, t } = useLocale();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StaticMessageKey | null>(null);
  const [message, setMessage] = useState<StaticMessageKey | null>(null);
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState("");
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (e: unknown) {
      const code = typeof e === "object" && e !== null && "code" in e ? e.code : "";
      switch (code) {
        case "auth/invalid-credential":
        case "auth/user-not-found":
        case "auth/wrong-password":
          setError("incorrectCredentials");
          break;
        case "auth/email-already-in-use":
          setError("accountExists");
          break;
        case "auth/weak-password":
        case "auth/password-does-not-meet-requirements":
          setError("strongerPassword");
          break;
        case "auth/too-many-requests":
          setError("tooManyAttempts");
          break;
        case "auth/invalid-email":
          setError("validEmail");
          break;
        default:
          setError("actionFailed");
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {heading}
      {error && (
        <div className="banner bad" role="alert">
          {t(error)}
        </div>
      )}
      {message && (
        <div className="banner" role="status">
          {t(message)}
        </div>
      )}
      <button className="btn google" disabled={busy} onClick={() => void run(google)}>
        {icons.google}
        {t("google")}
      </button>
      <p className="sub centered">{t("useEmail")}</p>
      <div className="seg" aria-label={t("emailAccount")}>
        <button
          type="button"
          aria-pressed={mode === "signin"}
          disabled={busy}
          onClick={() => {
            setMode("signin");
            setError(null);
            setMessage(null);
          }}
        >
          {t("signIn")}
        </button>
        <button
          type="button"
          aria-pressed={mode === "signup"}
          disabled={busy}
          onClick={() => {
            setMode("signup");
            setError(null);
            setMessage(null);
          }}
        >
          {t("createAccount")}
        </button>
      </div>
      <form
        style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "0.6rem" }}
        aria-label={t(mode === "signup" ? "createAccount" : "emailSignIn")}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => (mode === "signup" ? signUp : password)(email.trim(), secret));
        }}
      >
        <label className="field">
          {t("email")}
          <input
            id="password-email"
            type="email"
            autoComplete="username"
            required
            disabled={busy}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </label>
        <label className="field">
          {t("password")}
          <input
            id="password-secret"
            type="password"
            required
            disabled={busy}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
            }}
          />
        </label>
        <button type="submit" className="btn primary" disabled={busy || !email.trim() || !secret}>
          {t(busy ? "wait" : mode === "signup" ? "createYourAccount" : "emailSubmit")}
        </button>
        {mode === "signin" && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy || !email.trim()}
            onClick={() =>
              void run(async () => {
                await reset(email.trim());
                setMessage("resetSent");
              })
            }
          >
            {t("forgotPassword")}
          </button>
        )}
      </form>
      <p className="fine">
        {t("agreement")} <a href={publicPath("terms", locale)}>{t("terms")}</a>.{" "}
        <a href={publicPath("privacy", locale)}>{t("privacy")}</a>.
      </p>
    </>
  );
}
