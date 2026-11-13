import type { ReactNode } from "react";
import { Standalone } from "./ui.js";
import { publicPath, useLocale } from "./i18n.js";

const SUPPORT_EMAIL = "gryyny@proton.me";
function Contact() {
  return <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  const { locale, t } = useLocale();
  return (
    <Standalone>
      <article className="prose">
        <h1 className="h1">{title}</h1>
        {children}
        <p className="fine">
          <a href={`/?lang=${locale}`}>Food diary</a> ·{" "}
          <a href={publicPath("support", locale)}>{t("support")}</a> ·{" "}
          <a href={publicPath("privacy", locale)}>{t("privacy")}</a> ·{" "}
          <a href={publicPath("terms", locale)}>{t("terms")}</a>
        </p>
      </article>
    </Standalone>
  );
}
export function Landing({ children }: { children?: ReactNode }) {
  const { locale, t } = useLocale();
  return (
    <Standalone>
      <h1 className="h1" style={{ fontSize: "2rem" }}>
        {t("landingTitle")}
      </h1>
      <p className="sub" style={{ fontSize: "1rem" }}>
        {t("landingSubtitle")}
      </p>
      {children ?? (
        <a className="btn primary" href={`/?lang=${locale}`}>
          {t("signInOrSignup")}
        </a>
      )}
      <noscript>
        <p>{t("enableJs")}</p>
      </noscript>
      <p className="fine">
        {!children && (
          <>
            <a href={publicPath("privacy", locale)}>{t("privacy")}</a> ·{" "}
            <a href={publicPath("terms", locale)}>{t("terms")}</a> ·{" "}
          </>
        )}
        <a href={publicPath("support", locale)}>{t("support")}</a>
      </p>
    </Standalone>
  );
}
export function Privacy() {
  const { t } = useLocale();
  return (
    <Page title={t("privacyPolicy")}>
      <p>{t("privacyDate")}</p>
      <p>{t("privacyIntro")}</p>
      <h2>{t("privacyKeepTitle")}</h2>
      <p>{t("privacyKeep")}</p>
      <p>
        {t("privacyPurpose")} <strong>{t("privacySensitive")}</strong> {t("privacyWithdraw")}
      </p>
      <h2>{t("privacySharingTitle")}</h2>
      <p>{t("privacySharing")}</p>
      <p>{t("privacyProviders")}</p>
      <p>
        {t("privacyTransfers")}{" "}
        <a href="https://firebase.google.com/support/privacy">{t("firebasePrivacy")}</a> ·{" "}
        <a href="https://openai.com/policies/privacy-policy/">{t("openaiPrivacy")}</a>
      </p>
      <h2>{t("privacyRetentionTitle")}</h2>
      <p>{t("privacyRetention")}</p>
      <p>{t("privacyRetentionOther")}</p>
      <h2>{t("privacyRightsTitle")}</h2>
      <p>
        {t("privacyRights")} <a href="https://www.cnpd.pt/cidadaos/participacoes/">CNPD</a>.
      </p>
      <h2>{t("privacyContactTitle")}</h2>
      <p>
        {t("privacyController")} <Contact />.
      </p>
      <p>{t("privacyChanges")}</p>
    </Page>
  );
}
export function Terms() {
  const { t } = useLocale();
  return (
    <Page title={t("terms")}>
      <p>{t("termsDate")}</p>
      <p>{t("termsIntro")}</p>
      <h2>{t("termsUseTitle")}</h2>
      <p>{t("termsUse")}</p>
      <h2>{t("termsAccuracyTitle")}</h2>
      <p>{t("termsAccuracy")}</p>
      <h2>{t("termsDataTitle")}</h2>
      <p>{t("termsData")}</p>
      <p>{t("termsLinks")}</p>
    </Page>
  );
}
export function Support() {
  const { t } = useLocale();
  return (
    <Page title={t("support")}>
      <p>
        {t("needHelp")} <Contact />.
      </p>
      <p>{t("supportDetails")}</p>
      <h2>{t("quickHelp")}</h2>
      <ul>
        {(
          [
            "helpSameAccount",
            "helpPassword",
            "helpReconnect",
            "helpJoin",
            "helpMissing",
            "helpControls",
          ] as const
        ).map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
      </ul>
      <p>{t("supportPrivacy")}</p>
    </Page>
  );
}
export function NotFound() {
  const { locale, t } = useLocale();
  return (
    <Page title={t("pageNotFound")}>
      <p>
        <a href={`/?lang=${locale}`}>{t("goDiary")}</a>
      </p>
    </Page>
  );
}
