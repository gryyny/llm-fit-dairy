import type { User } from "firebase/auth";
import { useState } from "react";
import { readDays, useLoad, type Day } from "./api.js";
import { addDays, localToday, monthOf, shortDate } from "./dates.js";
import { navigate } from "./router.js";
import { formatIncomplete, formatTotal, totals } from "./totals.js";
import { localeTag, useLocale, type Locale } from "./i18n.js";
import { Empty, Loaded } from "./ui.js";

const WINDOW = 31;

/** Logged days newest first, loaded in 31-day windows (the read limit) going back on request. */
export function HistoryScreen({
  user,
  profileId,
  signIn,
}: {
  user: User;
  profileId: string;
  signIn: () => void;
}) {
  const { locale, t } = useLocale();
  const today = localToday();
  const [windows, setWindows] = useState(1);
  const [load, retry] = useLoad(
    `${user.uid}:${profileId}:${today}:${String(windows)}`,
    async () => {
      const pages = await Promise.all(
        Array.from({ length: windows }, (_, i) => {
          const to = addDays(today, -i * WINDOW);
          return readDays(user, profileId, addDays(to, -(WINDOW - 1)), to);
        }),
      );
      return pages
        .flatMap((p) => p.days)
        .filter((d) => d.meals.length > 0)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
    },
  );
  const earliest = addDays(today, -(windows * WINDOW - 1));
  return (
    <>
      <h1 className="h1">{t("history")}</h1>
      <Loaded load={load} what={t("history")} retry={retry} signIn={signIn} cards={2}>
        {(days) => (
          <>
            {days.length === 0 ? (
              <Empty
                title={t("noMealsInPeriod")}
                text={t("nothingSince", { date: shortDate(earliest, locale) })}
              />
            ) : (
              byMonth(days, locale).map(([month, list]) => (
                <section key={month} style={{ display: "contents" }}>
                  <div className="section-title">{month}</div>
                  <div className="list">
                    {list.map((day) => (
                      <HistoryRow key={day.date} day={day} />
                    ))}
                  </div>
                </section>
              ))
            )}
            <button
              className="btn secondary"
              onClick={() => {
                setWindows((n) => n + 1);
              }}
            >
              {t("beforeDate", { date: shortDate(earliest, locale) })}
            </button>
          </>
        )}
      </Loaded>
    </>
  );
}

function byMonth(days: Day[], locale: Locale): [string, Day[]][] {
  const groups = new Map<string, Day[]>();
  for (const day of days) {
    const key = monthOf(day.date, locale);
    groups.set(key, [...(groups.get(key) ?? []), day]);
  }
  return [...groups];
}

function HistoryRow({ day }: { day: Day }) {
  const { locale, t } = useLocale();
  const energy = totals(day.meals.flatMap((m) => m.entries)).energy_kcal;
  const mealsRule = new Intl.PluralRules(localeTag(locale)).select(day.meals.length);
  return (
    <button
      className="row"
      onClick={() => {
        navigate(day.date === localToday() ? "/" : `/day/${day.date}`);
      }}
    >
      <span className="l">
        <b>{shortDate(day.date, locale)}</b>
        <span>
          {t(
            mealsRule === "one"
              ? "mealCountOne"
              : mealsRule === "few"
                ? "mealCountFew"
                : "mealCountMany",
            { count: day.meals.length },
          )}{" "}
          · {t(day.target_kind === "training" ? "trainingDay" : "normalDay")}
        </span>
      </span>
      <span className="r num">
        <span className={energy.unknown ? "unknown" : undefined}>
          {formatTotal(energy, "kcal", locale)}
        </span>
        {energy.missing > 0 && <small>{formatIncomplete(energy.missing, locale)}</small>}
      </span>
    </button>
  );
}
