import type { User } from "firebase/auth";
import { useState } from "react";
import {
  api,
  useLoad,
  type Page,
  type Target,
  type Weight,
  type ProfileDetail,
  type BodyContext,
} from "./api.js";
import { boundText } from "./DayScreen.js";
import { dayAndMonth, localToday, fullDate } from "./dates.js";
import { localeTag, useLocale } from "./i18n.js";
import { formatAmount, nutrientLabel, NUTRIENTS } from "./totals.js";
import { ChatAction, Loaded } from "./ui.js";

export function chartSeries(weights: Weight[]): Weight[] {
  const [latest] = weights;
  if (!latest) return [];
  const run: Weight[] = [];
  for (const weight of weights) {
    if (weight.unit !== latest.unit) break;
    run.push(weight);
  }
  return run.slice(0, 30).reverse();
}

function WeightChart({ series }: { series: Weight[] }) {
  const { locale, t } = useLocale();
  if (series.length < 2) return null;
  const first = series[0];
  const end = series[series.length - 1];
  if (!first || !end) return null;
  const w = 340;
  const h = 150;
  const pad = { l: 36, r: 10, t: 12, b: 24 };
  const values = series.map((s) => s.value);
  const lo = Math.floor(Math.min(...values) * 2) / 2 - 0.5;
  const hi = Math.ceil(Math.max(...values) * 2) / 2 + 0.5;
  const start = Date.parse(first.date);
  const span = Date.parse(end.date) - start;
  const x = (date: string) =>
    span === 0
      ? (w + pad.l - pad.r) / 2
      : pad.l + ((Date.parse(date) - start) / span) * (w - pad.l - pad.r);
  const y = (value: number) => pad.t + ((hi - value) * (h - pad.t - pad.b)) / (hi - lo);
  const points = series.map((s) => `${x(s.date).toFixed(1)},${y(s.value).toFixed(1)}`).join(" ");
  const ticks = [lo, (lo + hi) / 2, hi];
  const number = new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 });
  return (
    <svg
      className="chart"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={t("weightChart", {
        from: dayAndMonth(first.date, locale),
        to: dayAndMonth(end.date, locale),
        unit: first.unit,
      })}
    >
      {ticks.map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="var(--line)" />
          <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--ink-3)">
            {number.format(v)}
          </text>
        </g>
      ))}
      {span > 0 && (
        <>
          <polygon
            points={`${x(first.date)},${h - pad.b} ${points} ${x(end.date)},${h - pad.b}`}
            fill="var(--accent-soft)"
          />
          <polyline
            points={points}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
        </>
      )}
      {series.map((s) => (
        <circle
          key={s.id}
          cx={x(s.date)}
          cy={y(s.value)}
          r="3.5"
          fill="var(--accent)"
          stroke="var(--surface)"
          strokeWidth="2"
        >
          <title>
            {formatAmount(s.value, s.unit, locale)} · {fullDate(s.date, locale)}
          </title>
        </circle>
      ))}
      <text x={pad.l} y={h - 6} fontSize="10" fill="var(--ink-3)">
        {dayAndMonth(first.date, locale)}
      </text>
      {span > 0 && (
        <text x={w - pad.r} y={h - 6} fontSize="10" textAnchor="end" fill="var(--ink-3)">
          {dayAndMonth(end.date, locale)}
        </text>
      )}
    </svg>
  );
}

export function currentTargets(all: Target[], today: string) {
  const unique = [...new Map(all.map((target) => [target.id, target])).values()];
  const current = (["training", "normal"] as const).flatMap((kind) => {
    const inForce = unique
      .filter((target) => target.kind === kind && target.effective_from <= today)
      .reduce<Target | null>(
        (best, target) =>
          best === null || target.effective_from > best.effective_from ? target : best,
        null,
      );
    return inForce ? [inForce] : [];
  });
  const ids = new Set(current.map((target) => target.id));
  return { current, others: unique.filter((target) => !ids.has(target.id)) };
}

async function loadHistory<T>(
  read: (query: URLSearchParams) => Promise<Page<T>>,
  pages: number,
): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  let cursor: string | null = null;
  let complete = false;
  for (let page = 0; page < pages; page++) {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("cursor", cursor);
    const result = await read(query);
    items.push(...result.items);
    cursor = result.next_cursor;
    complete = result.complete;
    if (complete) break;
  }
  return { items, complete };
}

export function BodyScreen({
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
  const [kind, setKind] = useState<"normal" | "training">("normal");
  const [weightPages, setWeightPages] = useState(1);
  const [targetPages, setTargetPages] = useState(1);
  const base = `/api/v1/profiles/${profileId}`;
  const [load, retry] = useLoad(
    `${user.uid}:${profileId}:body:${today}:${weightPages}:${targetPages}`,
    async () => {
      const [weights, targets, normal, training, profile] = await Promise.all([
        loadHistory(
          (query) => api<Page<Weight>>(user, "GET", `${base}/weights?${query.toString()}`),
          weightPages,
        ),
        loadHistory(
          (query) => api<Page<Target>>(user, "GET", `${base}/targets?${query.toString()}`),
          targetPages,
        ),
        api<Page<Target>>(user, "GET", `${base}/targets?kind=normal&effective_on=${today}&limit=1`),
        api<Page<Target>>(
          user,
          "GET",
          `${base}/targets?kind=training&effective_on=${today}&limit=1`,
        ),
        api<ProfileDetail>(user, "GET", base),
      ]);
      return {
        profile,
        weights,
        targets,
        ...currentTargets([...normal.items, ...training.items, ...targets.items], today),
      };
    },
  );
  const number = new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 20 });
  return (
    <>
      <h1 className="h1">{t("body")}</h1>
      <Loaded load={load} what={t("targetsAndWeight")} retry={retry} signIn={signIn} cards={2}>
        {({ weights, targets, current, others, profile }) => {
          const latest = weights.items[0];
          const selected = current.find((target) => target.kind === kind);
          return (
            <>
              {!profile.body_context && !latest && current.length === 0 && (
                <section className="card">
                  <h3>{t("optionalSetup")}</h3>
                  <p className="notice">{t("bodySetupNote")}</p>
                </section>
              )}
              <div className="section-title">{t("bodyContext")}</div>
              <section className="card">
                {profile.body_context ? (
                  <BodyFacts facts={profile.body_context} />
                ) : (
                  <p className="notice">{t("noBodyContext")}</p>
                )}
                <ChatAction
                  label={t(profile.body_context ? "changeInChat" : "setupInChat")}
                  prompt={t("bodyPrompt", { name: profile.profile.name })}
                />
              </section>
              <div className="section-title">{t("weight")}</div>
              <section className="card">
                {latest ? (
                  <>
                    <b className="num" style={{ fontSize: "1.5rem" }}>
                      {number.format(latest.value)} {latest.unit}
                    </b>
                    <div className="sub">{fullDate(latest.date, locale)}</div>
                    <WeightChart series={chartSeries(weights.items)} />
                  </>
                ) : (
                  <p className="notice">{t("noWeights")}</p>
                )}
                <ChatAction
                  label={t("recordWeight")}
                  prompt={t("weightChatPrompt", { name: profile.profile.name })}
                />
              </section>
              <div className="section-title">{t("targets")}</div>
              <div className="seg" role="group" aria-label={t("goalVariant")}>
                {(["normal", "training"] as const).map((value) => (
                  <button
                    key={value}
                    aria-pressed={kind === value}
                    onClick={() => {
                      setKind(value);
                    }}
                  >
                    {t(value === "normal" ? "normalDay" : "trainingDay")}
                  </button>
                ))}
              </div>
              <section
                className="card"
                aria-label={t(kind === "normal" ? "normalDay" : "trainingDay")}
              >
                {selected ? (
                  <>
                    <div className="sub">
                      {t("fromDate", { date: fullDate(selected.effective_from, locale) })}
                    </div>
                    <dl className="kv num">
                      {NUTRIENTS.flatMap(([key, , unit]) => {
                        const bound = selected.values[key];
                        return bound
                          ? [
                              <div key={key} style={{ display: "contents" }}>
                                <dt>{nutrientLabel(key, locale)}</dt>
                                <dd>{boundText(bound, unit, locale)}</dd>
                              </div>,
                            ]
                          : [];
                      })}
                    </dl>
                    <GoalDetails target={selected} />
                  </>
                ) : (
                  <p className="notice">{t("noActiveTarget")}</p>
                )}
                <ChatAction
                  label={t(selected ? "changeInChat" : "setupInChat")}
                  prompt={t("goalChatPrompt", {
                    name: profile.profile.name,
                    kind: t(kind === "normal" ? "normalDay" : "trainingDay"),
                  })}
                />
              </section>
              {weights.items.length > 0 && (
                <>
                  <div className="section-title">{t("weightHistory")}</div>
                  <div className="list">
                    {weights.items.map((weight) => (
                      <div className="row" key={weight.id}>
                        <span className="l">
                          <b>{fullDate(weight.date, locale)}</b>
                          {weight.note && <span>{weight.note}</span>}
                        </span>
                        <span className="r num">
                          {number.format(weight.value)} {weight.unit}
                        </span>
                      </div>
                    ))}
                  </div>
                  {!weights.complete && (
                    <button
                      className="btn secondary"
                      onClick={() => {
                        setWeightPages((n) => n + 1);
                      }}
                    >
                      {t("moreWeights")}
                    </button>
                  )}
                </>
              )}
              {others.length > 0 && (
                <>
                  <div className="section-title">{t("targetHistory")}</div>
                  <div className="list">
                    {others.map((target) => (
                      <div className="row" key={target.id}>
                        <span className="l">
                          <b>{t(target.kind === "training" ? "trainingDay" : "normalDay")}</b>
                          <span>
                            {t(target.effective_from > today ? "startsDate" : "fromDate", {
                              date: fullDate(target.effective_from, locale),
                            })}
                          </span>
                          <GoalDetails target={target} />
                        </span>
                        <span className="r num">
                          {target.values.energy_kcal
                            ? boundText(target.values.energy_kcal, "kcal", locale)
                            : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {!targets.complete && (
                <button
                  className="btn secondary"
                  onClick={() => {
                    setTargetPages((n) => n + 1);
                  }}
                >
                  {t("moreTargets")}
                </button>
              )}
            </>
          );
        }}
      </Loaded>
    </>
  );
}

function BodyFacts({ facts }: { facts: Omit<BodyContext, "version"> }) {
  const { locale, t } = useLocale();
  const number = new Intl.NumberFormat(localeTag(locale));
  const plural = facts.age ? new Intl.PluralRules(localeTag(locale)).select(facts.age.years) : null;
  const rows = [
    [
      t("height"),
      facts.height ? `${number.format(facts.height.value)} ${facts.height.unit}` : null,
    ],
    [t("dateOfBirth"), facts.date_of_birth ? fullDate(facts.date_of_birth, locale) : null],
    [
      t("age"),
      facts.age
        ? t("ageDated", {
            years: t(plural === "one" ? "yearsOne" : plural === "few" ? "yearsFew" : "yearsMany", {
              count: number.format(facts.age.years),
            }),
            date: fullDate(facts.age.as_of, locale),
          })
        : null,
    ],
    [t("activity"), facts.activity],
    [t("overallGoal"), facts.goal],
  ].filter((row) => row[1] !== null);
  return rows.length === 0 ? (
    <p className="notice">{t("noBodyContext")}</p>
  ) : (
    <dl className="kv">
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "contents" }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function GoalDetails({ target }: { target: Target }) {
  const { locale, t } = useLocale();
  const context = target.inputs?.body_context;
  const weight = target.inputs?.weight;
  return (
    <>
      {target.rationale && (
        <details>
          <summary>{t("goalExplanation")}</summary>
          <p className="notice">{target.rationale}</p>
        </details>
      )}
      {target.inputs && (
        <details>
          <summary>{t("goalInputs")}</summary>
          {context && <BodyFacts facts={context.fields} />}{" "}
          {weight && (
            <p className="notice">
              {new Intl.NumberFormat(localeTag(locale)).format(weight.value)} {weight.unit} ·{" "}
              {fullDate(weight.date, locale)}
            </p>
          )}
        </details>
      )}
      {target.note && <p className="notice">{target.note}</p>}
    </>
  );
}
