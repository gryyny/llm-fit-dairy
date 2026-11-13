import type { User } from "firebase/auth";
import { useState } from "react";
import { readDays, useLoad, type Bound, type Day } from "./api.js";
import { addDays, dayHeading, localToday } from "./dates.js";
import { localeTag, message, useLocale, type Locale } from "./i18n.js";
import { navigate } from "./router.js";
import {
  formatAmount,
  formatIncomplete,
  formatTotal,
  nutrientLabel,
  NUTRIENTS,
  totals,
  type Total,
} from "./totals.js";
import { Empty, icons, Loaded, SourceBadge } from "./ui.js";

export function boundText(bound: Bound, unit: string, locale: Locale = "en"): string {
  let limits = "";
  if (bound.min !== undefined && bound.max !== undefined) {
    limits = `${formatAmount(bound.min, unit, locale).replace(` ${unit}`, "")}–${formatAmount(bound.max, unit, locale)}`;
  } else if (bound.min !== undefined) limits = `≥ ${formatAmount(bound.min, unit, locale)}`;
  else if (bound.max !== undefined) limits = `≤ ${formatAmount(bound.max, unit, locale)}`;
  if (bound.value === undefined) return limits;
  const exact = formatAmount(bound.value, unit, locale);
  return limits ? `${exact} (${limits})` : exact;
}

// Missing values make remaining amounts upper bounds and exceeded amounts lower bounds.
export function remainingText(
  total: Total,
  bound: Bound,
  unit: string,
  locale: Locale = "en",
): string | null {
  if (total.unknown) return null;
  const lower = bound.min ?? bound.value;
  const upper = bound.max ?? bound.value;
  const partial = total.missing > 0;
  if (upper !== undefined && total.sum > upper) {
    return message(locale, partial ? "atLeastOver" : "over", {
      amount: formatAmount(total.sum - upper, unit, locale),
    });
  }
  if (lower !== undefined && total.sum < lower) {
    return message(locale, partial ? "atMostToGo" : "toGo", {
      amount: formatAmount(lower - total.sum, unit, locale),
    });
  }
  return partial ? null : message(locale, "withinTarget");
}

function Progress({
  name,
  total,
  bound,
  unit,
  primary = false,
}: {
  name: string;
  total: Total;
  bound?: Bound;
  unit: string;
  primary?: boolean;
}) {
  const { locale, t } = useLocale();
  const reference = bound && (bound.max ?? bound.value ?? bound.min);
  const percent =
    !total.unknown && reference !== undefined && reference > 0
      ? Math.min(100, (total.sum / reference) * 100)
      : null;
  const remaining = bound && remainingText(total, bound, unit, locale);
  const minimum =
    bound?.min !== undefined && bound.max !== undefined && reference !== undefined && reference > 0
      ? Math.min(100, (bound.min / reference) * 100)
      : null;
  return (
    <div className={primary ? "calorie-progress" : "macro"} role="group" aria-label={name}>
      <div className={primary ? "energy" : "macro-heading"}>
        {primary ? (
          <>
            <span className="visually-hidden">{name}</span>
            <span className="big num">
              {total.unknown ? (
                <span className="unknown">{t("unknown")}</span>
              ) : (
                <>
                  {total.missing > 0 && <span className="ge">≥ </span>}
                  {formatAmount(total.sum, unit, locale).replace(` ${unit}`, "")}
                </>
              )}
            </span>
            {!total.unknown && <span className="unit">{unit}</span>}
          </>
        ) : (
          <>
            <span>{name}</span>
            <b className={`num${total.unknown ? " unknown" : ""}`}>
              {formatTotal(total, unit, locale)}
            </b>
          </>
        )}
      </div>
      {total.missing > 0 && !total.unknown && (
        <span className="missing">{formatIncomplete(total.missing, locale)}</span>
      )}
      {bound && (
        <>
          {percent !== null && (
            <div
              className={`bar${total.missing > 0 ? " partial" : ""}`}
              role="img"
              aria-label={t("progress", {
                name,
                amount: formatTotal(total, unit, locale),
                target: boundText(bound, unit, locale),
              })}
            >
              <i style={{ width: `${percent}%` }} />
              {minimum !== null && (
                <span className="bar-min" style={{ left: `${minimum}%` }} aria-hidden />
              )}
            </div>
          )}
          <div className="target-line num">
            <span>{t("target", { amount: boundText(bound, unit, locale) })}</span>
            {remaining && <span>{remaining}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function Totals({ day }: { day: Day }) {
  const { locale, t } = useLocale();
  const entries = day.meals.flatMap((m) => m.entries);
  const all = totals(entries);
  // An empty day has zero logged intake; entries without nutrients remain unknown.
  const totalFor = (key: keyof typeof all) =>
    entries.length === 0 ? { sum: 0, missing: 0, unknown: false } : all[key];
  return (
    <section className="card" aria-label={t("dayTotals")}>
      {entries.length === 0 && <p className="legend">{t("zeroLogged")}</p>}
      <Progress
        primary
        name={t("calories")}
        total={totalFor("energy_kcal")}
        unit="kcal"
        bound={day.target?.values.energy_kcal}
      />
      <div className="core-macros">
        {(["protein_g", "carbohydrate_g", "fat_g"] as const).map((key) => (
          <Progress
            key={key}
            name={nutrientLabel(key, locale)}
            total={totalFor(key)}
            unit="g"
            bound={day.target?.values[key]}
          />
        ))}
      </div>
      <details className="nutrient-details">
        <summary>{t("moreNutrients")}</summary>
        <dl className="nutrients num">
          {NUTRIENTS.filter(
            ([key]) => !["energy_kcal", "protein_g", "carbohydrate_g", "fat_g"].includes(key),
          ).map(([key, , unit]) => {
            const total = totalFor(key);
            const bound = day.target?.values[key];
            return (
              <div key={key} style={{ display: "contents" }}>
                <dt>{nutrientLabel(key, locale)}</dt>
                <dd className={total.unknown ? "unknown" : undefined}>
                  {formatTotal(total, unit, locale)}
                  {!total.unknown && total.missing > 0 && (
                    <small>{formatIncomplete(total.missing, locale)}</small>
                  )}
                  {bound && (
                    <small className="target">
                      {t("target", { amount: boundText(bound, unit, locale) })}
                    </small>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </details>
      {Object.values(all).some((total) => !total.unknown && total.missing > 0) && (
        <p className="legend">{t("lowerBoundLegend")}</p>
      )}
    </section>
  );
}

function Meals({ day }: { day: Day }) {
  const { locale, t } = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  return day.meals.map((meal, i) => {
    const energy = totals(meal.entries).energy_kcal;
    return (
      <section className="card meal" key={meal.id}>
        <header>
          <h3>{meal.label ?? t("mealNumber", { number: i + 1 })}</h3>
          <span className="num">{formatTotal(energy, "kcal", locale)}</span>
        </header>
        {meal.entries.map((entry) => {
          const kcal = entry.nutrients.energy_kcal;
          const expanded = open === entry.id;
          return (
            <button
              key={entry.id}
              className="entry"
              aria-expanded={expanded}
              onClick={() => {
                setOpen(expanded ? null : entry.id);
              }}
            >
              <span className="name">{entry.name}</span>
              <span className={`kcal num${kcal === undefined ? " unknown" : ""}`}>
                {kcal === undefined
                  ? "— kcal"
                  : `${entry.partial_nutrients?.includes("energy_kcal") ? "≥ " : ""}${formatAmount(kcal, "kcal", locale)}`}
              </span>
              <span className="meta">
                {new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 20 }).format(
                  entry.quantity,
                )}{" "}
                {entry.unit} <SourceBadge source={entry.source} />
              </span>
              <span />
              {expanded && (
                <span className="detail">
                  {entry.note && <span>{entry.note}</span>}
                  {entry.label && (
                    <span>
                      {t("labelBasis", {
                        amount: entry.label.basis_amount,
                        unit: entry.label.basis_unit,
                      })}
                    </span>
                  )}
                  <dl className="num">
                    {NUTRIENTS.slice(1).map(([key, , unit]) => (
                      <span key={key} style={{ display: "contents" }}>
                        <dt>{nutrientLabel(key, locale)}</dt>
                        <dd>
                          {entry.nutrients[key] === undefined
                            ? "—"
                            : `${entry.partial_nutrients?.includes(key) ? "≥ " : ""}${formatAmount(entry.nutrients[key], unit, locale)}`}
                        </dd>
                      </span>
                    ))}
                  </dl>
                </span>
              )}
            </button>
          );
        })}
        {meal.note && <p className="notice">{meal.note}</p>}
      </section>
    );
  });
}

export function DayScreen({
  user,
  profileId,
  date,
  signIn,
}: {
  user: User;
  profileId: string;
  date: string;
  signIn: () => void;
}) {
  const { locale, t } = useLocale();
  const today = localToday();
  const [load, retry] = useLoad(`${user.uid}:${profileId}:${date}`, () =>
    readDays(user, profileId, date, date).then((r) => r.days[0]),
  );
  const heading = dayHeading(date, today, locale);
  const go = (d: string) => {
    navigate(d === today ? "/" : `/day/${d}`);
  };
  return (
    <>
      <div className="daynav">
        <button
          className="iconbtn"
          aria-label={t("previousDay")}
          onClick={() => {
            go(addDays(date, -1));
          }}
        >
          {icons.left}
        </button>
        <div className="date">
          <b>{heading.title}</b>
          <span>{heading.subtitle}</span>
        </div>
        <button
          className="iconbtn"
          aria-label={t("nextDay")}
          disabled={date >= today}
          onClick={() => {
            go(addDays(date, 1));
          }}
        >
          {icons.right}
        </button>
      </div>
      <Loaded load={load} what={t("thisDay")} retry={retry} signIn={signIn}>
        {(day) =>
          !day ? (
            <Empty title={t("nothingLogged")} say={t("breakfastPrompt")} />
          ) : (
            <>
              <KindPill day={day} />
              {(day.meals.length > 0 || day.target !== null) && <Totals day={day} />}
              {day.meals.length === 0 ? (
                <Empty title={t("nothingLogged")} say={t("breakfastPrompt")} />
              ) : (
                <Meals day={day} />
              )}
              {day.weights.map((w) => (
                <section className="card split" key={w.id}>
                  <div>
                    <b>{t("weight")}</b>
                    {w.note && <div className="sub">{w.note}</div>}
                  </div>
                  <b className="num">
                    {new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 20 }).format(
                      w.value,
                    )}{" "}
                    {w.unit}
                  </b>
                </section>
              ))}
            </>
          )
        }
      </Loaded>
    </>
  );
}

function KindPill({ day }: { day: Day }) {
  const { t } = useLocale();
  return (
    <div>
      <span className={`pill${day.target_kind === "training" ? " training" : ""}`}>
        {t(day.target_kind === "training" ? "trainingDay" : "normalDay")}
      </span>
    </div>
  );
}
