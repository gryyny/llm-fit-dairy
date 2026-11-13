import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { en, uk, type MessageArgs, type MessageKey, type Translate } from "./messages.js";

export type Locale = "en" | "uk";
export const localeTag = (locale: Locale) => (locale === "uk" ? "uk-UA" : "en-GB");
const STORAGE_KEY = "food-diary.language";
const isLocale = (value: string | null): value is Locale => value === "en" || value === "uk";

export function resolveLocale(
  stored: string | null,
  languages: readonly string[],
  entry?: string | null,
): Locale {
  if (entry !== undefined && entry !== null && isLocale(entry)) return entry;
  if (isLocale(stored)) return stored;
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0] ?? "";
    if (isLocale(base)) return base;
  }
  return "en";
}

export function message<K extends MessageKey>(
  locale: Locale,
  key: K,
  ...args: MessageArgs<K>
): string {
  const values = args[0] as Record<string, string | number> | undefined;
  return (locale === "uk" ? uk[key] : en[key]).replace(/\{(\w+)\}/g, (_, name: string) =>
    String(values?.[name] ?? `{${name}}`),
  );
}

const translator =
  (locale: Locale): Translate =>
  <K extends MessageKey>(key: K, ...args: MessageArgs<K>) =>
    message(locale, key, ...args);

export const publicPath = (page: "privacy" | "terms" | "support", locale: Locale) =>
  `${locale === "uk" ? "/uk" : ""}/${page}`;
const publicLocale = (path: string): Locale | null =>
  /^\/uk\/(privacy|terms|support)$/.test(path)
    ? "uk"
    : /^\/(privacy|terms|support)$/.test(path)
      ? "en"
      : null;

function browserLocale(): Locale {
  if (typeof window === "undefined") return "en";
  const fixed = publicLocale(window.location.pathname);
  if (fixed) return fixed;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage may be blocked.
  }
  return resolveLocale(
    stored,
    navigator.languages,
    new URLSearchParams(window.location.search).get("lang"),
  );
}

interface Language {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}
const LanguageContext = createContext<Language>({
  locale: "en",
  setLocale: () => undefined,
  t: translator("en"),
});

export function LocaleProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, update] = useState(initialLocale ?? browserLocale);
  const setLocale = useCallback((next: Locale) => {
    update(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Keep the in-memory choice.
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const entry = new URLSearchParams(window.location.search).get("lang");
    if (isLocale(entry) && !publicLocale(window.location.pathname)) setLocale(entry);
  }, [setLocale]);
  useEffect(() => {
    const sync = () => {
      const fixed = publicLocale(window.location.pathname);
      if (fixed) update(fixed);
    };
    window.addEventListener("app:navigate", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("app:navigate", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);
  const value = useMemo(() => ({ locale, setLocale, t: translator(locale) }), [locale, setLocale]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export const useLocale = () => useContext(LanguageContext);
export function LanguagePicker() {
  const { locale, setLocale, t } = useLocale();
  return (
    <span className="language-control">
      <select
        className="language-picker"
        aria-label={t("language")}
        value={locale}
        onChange={(event) => {
          const next = event.target.value;
          if (isLocale(next)) setLocale(next);
        }}
      >
        <option value="en" lang="en">
          English
        </option>
        <option value="uk" lang="uk">
          Українська
        </option>
      </select>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}
