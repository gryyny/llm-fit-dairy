/** Diary dates are the person's local calendar days (DA-2), as YYYY-MM-DD. */
import { localeTag, message, type Locale } from "./i18n.js";

export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const formatter = (options: Intl.DateTimeFormatOptions, locale: Locale) =>
  new Intl.DateTimeFormat(localeTag(locale), { ...options, timeZone: "UTC" });

const at = (date: string) => new Date(`${date}T00:00:00Z`);
export const shortDate = (date: string, locale: Locale = "en") =>
  formatter({ weekday: "short", day: "numeric", month: "short" }, locale).format(at(date));
export const fullDate = (date: string, locale: Locale = "en") =>
  formatter({ day: "numeric", month: "short", year: "numeric" }, locale).format(at(date));
export const dayAndMonth = (date: string, locale: Locale = "en") =>
  formatter({ day: "numeric", month: "short" }, locale).format(at(date));
export const monthOf = (date: string, locale: Locale = "en") =>
  formatter({ month: "long", year: "numeric" }, locale).format(at(date));

/** A day view's heading: Today, Yesterday or the weekday, with the date beneath (WB-2). */
export function dayHeading(
  date: string,
  today: string,
  locale: Locale = "en",
): { title: string; subtitle: string } {
  const longDate = formatter({ weekday: "long", day: "numeric", month: "long" }, locale).format(
    at(date),
  );
  if (date === today) return { title: message(locale, "today"), subtitle: longDate };
  if (date === addDays(today, -1))
    return { title: message(locale, "yesterday"), subtitle: longDate };
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return {
    title: formatter({ weekday: "long" }, locale).format(at(date)),
    subtitle: formatter(
      { day: "numeric", month: "long", ...(!sameYear ? { year: "numeric" } : {}) },
      locale,
    ).format(at(date)),
  };
}
