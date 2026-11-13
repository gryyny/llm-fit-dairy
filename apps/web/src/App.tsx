import { onIdTokenChanged, signOut, type Auth, type User } from "firebase/auth";
import { useEffect, useState } from "react";
import { api, refreshVisibleData, useLoad, type Me } from "./api.js";
import { ConnectScreen, JoinScreen, type Leave } from "./Approve.js";
import { BodyScreen } from "./BodyScreen.js";
import { localToday } from "./dates.js";
import { DayScreen } from "./DayScreen.js";
import {
  completeRedirect,
  resetPassword,
  signIn,
  signInByRedirect,
  signInWithPassword,
  signUpWithPassword,
} from "./firebase.js";
import { FoodsScreen } from "./FoodsScreen.js";
import { HistoryScreen } from "./HistoryScreen.js";
import { Landing, NotFound, Privacy, Support, Terms } from "./Pages.js";
import { navigate, useRoute, type Route } from "./router.js";
import { SettingsScreen } from "./SettingsScreen.js";
import { SignIn } from "./SignIn.js";
import { icons, Loaded, Skeleton, Standalone } from "./ui.js";
import { LocaleProvider, useLocale } from "./i18n.js";

const TABS = [
  ["today", "/", "today", icons.day],
  ["history", "/history", "history", icons.history],
  ["foods", "/foods", "foods", icons.foods],
  ["body", "/body", "body", icons.body],
] as const;

export function App({
  auth,
  leave = (url) => {
    window.location.assign(url);
  },
}: {
  auth: Auth | null;
  leave?: Leave;
}) {
  return (
    <LocaleProvider>
      <AppContent auth={auth} leave={leave} />
    </LocaleProvider>
  );
}

function AppContent({ auth, leave }: { auth: Auth | null; leave: Leave }) {
  const { t } = useLocale();
  const route = useRoute();
  if (route.name === "privacy") return <Privacy />;
  if (route.name === "terms") return <Terms />;
  if (route.name === "support") return <Support />;
  if (route.name === "notFound") return <NotFound />;
  if (!auth) {
    return (
      <Standalone>
        <p className="sub">{t("unavailable")}</p>
      </Standalone>
    );
  }
  return <Site auth={auth} leave={leave} route={route} />;
}

function Site({ auth, leave, route }: { auth: Auth; leave: Leave; route: Route }) {
  const { locale, t } = useLocale();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    completeRedirect(auth).catch(() => {
      setError("signInFailed");
    });
    return onIdTokenChanged(auth, setUser);
  }, [auth]);
  useEffect(() => {
    auth.languageCode = locale;
  }, [auth, locale]);
  const out = () => void signOut(auth);

  if (user === undefined) {
    return (
      <Standalone busy>
        <Skeleton cards={2} />
      </Standalone>
    );
  }

  if (route.name === "connect" || route.name === "join") {
    const code = new URLSearchParams(window.location.search).get("code") ?? "";
    return (
      <Standalone>
        {user === null ? (
          <SignIn
            heading={
              <>
                <h1 className="h1 centered" style={{ fontSize: "1.5rem" }}>
                  {t(route.name === "connect" ? "connectTitle" : "joinTitle")}
                </h1>
                <p className="sub centered">{t("signInOrCreate")}</p>
                {error && <p className="banner bad">{t("signInFailed")}</p>}
              </>
            }
            google={() => signInByRedirect(auth)}
            password={(email, password) => signInWithPassword(auth, email, password)}
            signUp={(email, password) => signUpWithPassword(auth, email, password)}
            reset={(email) => resetPassword(auth, email)}
          />
        ) : route.name === "connect" ? (
          <ConnectScreen key={user.uid} user={user} onSwitch={out} leave={leave} />
        ) : (
          <JoinScreen key={user.uid} user={user} code={code} onSwitch={out} />
        )}
      </Standalone>
    );
  }

  if (user === null) {
    return (
      <>
        {error && <p className="banner bad">{t("signInFailed")}</p>}
        <Landing>
          <SignIn
            heading={null}
            google={() => signIn(auth)}
            password={(email, password) => signInWithPassword(auth, email, password)}
            signUp={(email, password) => signUpWithPassword(auth, email, password)}
            reset={(email) => resetPassword(auth, email)}
          />
        </Landing>
      </>
    );
  }
  return <Shell key={user.uid} user={user} route={route} signOut={out} />;
}

/** Signed-in diary screens; keyed by the person so nothing carries over when the account changes. */
export function Shell({ user, route, signOut }: { user: User; route: Route; signOut: () => void }) {
  const { t } = useLocale();
  const [me, retry] = useLoad(`${user.uid}:me`, () => api<Me>(user, "GET", "/api/manage/me"));
  const tab = route.name === "day" ? "today" : route.name;
  if (route.name === "settings") {
    return (
      <div className="frame">
        <main className="content page">
          <SettingsScreen user={user} signIn={signOut} signOut={signOut} />
        </main>
      </div>
    );
  }
  return (
    <div className="frame">
      <header className="topbar">
        <div className="who">
          <span className="avatar">
            {(me.state === "ready" ? me.data.profile.name : (user.displayName ?? "?"))
              .slice(0, 1)
              .toUpperCase()}
          </span>
          <b>{me.state === "ready" ? me.data.profile.name : (user.displayName ?? "")}</b>
        </div>
        <button className="iconbtn" aria-label={t("refresh")} onClick={refreshVisibleData}>
          {icons.refresh}
        </button>
        <button
          className="iconbtn"
          aria-label={t("settings")}
          onClick={() => {
            navigate("/settings");
          }}
        >
          {icons.gear}
        </button>
      </header>
      <main className="content">
        <Loaded load={me} what={t("yourProfile")} retry={retry} signIn={signOut}>
          {({ profile }) => {
            const props = { user, profileId: profile.profile_id, signIn: signOut };
            switch (route.name) {
              case "history":
                return <HistoryScreen {...props} />;
              case "foods":
                return <FoodsScreen {...props} />;
              case "body":
                return <BodyScreen {...props} />;
              default:
                return (
                  <DayScreen {...props} date={route.name === "day" ? route.date : localToday()} />
                );
            }
          }}
        </Loaded>
      </main>
      <nav className="tabbar" aria-label={t("sections")}>
        {TABS.map(([id, path, label, icon]) => (
          <button
            key={id}
            className="tab"
            aria-current={tab === id ? "page" : undefined}
            onClick={() => {
              navigate(path);
            }}
          >
            {icon}
            <span>{t(label)}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
