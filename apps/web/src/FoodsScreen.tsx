import type { User } from "firebase/auth";
import { useEffect, useState } from "react";
import { api, useLoad, type Page, type Product, type Recipe, type FoodSummary } from "./api.js";
import { formatAmount, NUTRIENTS, nutrientLabel } from "./totals.js";
import { useLocale, localeTag } from "./i18n.js";
import type { Translate } from "./messages.js";
import { Empty, icons, Loaded, Sheet, SourceBadge } from "./ui.js";

type Kind = "all" | "basic" | "product" | "recipe" | "unclassified";

export function FoodsScreen({
  user,
  profileId,
  signIn,
}: {
  user: User;
  profileId: string;
  signIn: () => void;
}) {
  const { locale, t } = useLocale();
  const [kind, setKind] = useState<Kind>("all");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState(1);
  const [open, setOpen] = useState<FoodSummary | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(typed.trim());
      setPages(1);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [typed]);
  const [load, retry] = useLoad(
    `${user.uid}:${profileId}:${kind}:${sort}:${query}:${String(pages)}`,
    async () => {
      const items: FoodSummary[] = [];
      let cursor: string | null = null;
      let complete = false;
      for (let i = 0; i < pages; i++) {
        const params = new URLSearchParams({ limit: "50", food_kind: kind, sort });
        if (query) params.set("q", query);
        if (cursor) params.set("cursor", cursor);
        const page = await api<Page<FoodSummary>>(
          user,
          "GET",
          `/api/v1/profiles/${profileId}/foods?${params.toString()}`,
        );
        items.push(...page.items);
        cursor = page.next_cursor;
        complete = page.complete;
        if (complete) break;
      }
      return { items, complete };
    },
  );
  return (
    <>
      <h1 className="h1">{t("foods")}</h1>
      <div className="seg food-types" role="group" aria-label={t("foodType")}>
        {(["all", "basic", "product", "recipe", "unclassified"] as const).map((value) => (
          <button
            key={value}
            aria-pressed={kind === value}
            onClick={() => {
              setKind(value);
              setPages(1);
            }}
          >
            {t(
              (
                {
                  all: "allFoods",
                  basic: "basicFoods",
                  product: "packagedFoods",
                  recipe: "recipes",
                  unclassified: "unclassifiedFoods",
                } as const
              )[value],
            )}
          </button>
        ))}
      </div>
      <label className="search">
        {icons.search}
        <span className="visually-hidden">{t("searchFoods")}</span>
        <input
          type="search"
          placeholder={t("searchFoods")}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
          }}
        />
      </label>
      <label className="food-sort">
        {t("sortFoods")}{" "}
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value === "name" ? "name" : "recent");
            setPages(1);
          }}
        >
          <option value="recent">{t("recent")}</option>
          <option value="name">{t("byName")}</option>
        </select>
      </label>
      <Loaded load={load} what={t("foods")} retry={retry} signIn={signIn} cards={1}>
        {({ items, complete }) =>
          items.length === 0 ? (
            query ? (
              <Empty title={t("noMatches")} text={t("noFoodMatches", { query })} />
            ) : (
              <Empty title={t("noFoods")} say={t("usualPrompt")} />
            )
          ) : (
            <>
              <div className="list">
                {items.map((item) => (
                  <button
                    className="row"
                    key={`${item.type}:${item.id}`}
                    onClick={() => {
                      setOpen(item);
                    }}
                  >
                    <span className="l">
                      <b>{item.name}</b>
                      <span>{summary(item, t, locale)}</span>
                    </span>
                    <span className="r num">
                      {item.energy_kcal === null ? (
                        <span className="unknown">— kcal</span>
                      ) : (
                        `${item.partial_nutrients?.includes("energy_kcal") ? "≥ " : ""}${formatAmount(item.energy_kcal, "kcal", locale)}`
                      )}
                    </span>
                  </button>
                ))}
              </div>
              {!complete && (
                <button
                  className="btn secondary"
                  onClick={() => {
                    setPages((n) => n + 1);
                  }}
                >
                  {t("showMore")}
                </button>
              )}
            </>
          )
        }
      </Loaded>
      {open && (
        <Sheet
          label={open.name}
          onClose={() => {
            setOpen(null);
          }}
        >
          <FoodDetail user={user} profileId={profileId} food={open} signIn={signIn} />
        </Sheet>
      )}
    </>
  );
}

function summary(
  item: Pick<
    FoodSummary,
    "type" | "basis_amount" | "basis_unit" | "servings" | "brand" | "variant"
  >,
  t: Translate,
  locale: "en" | "uk",
) {
  const amount =
    item.basis_amount === null
      ? null
      : `${new Intl.NumberFormat(localeTag(locale)).format(item.basis_amount)} ${item.basis_unit ?? ""}`.trim();
  if (item.type === "recipe") {
    const count = item.servings;
    const plural = count === null ? null : new Intl.PluralRules(localeTag(locale)).select(count);
    const servings =
      count === null
        ? null
        : t(plural === "one" ? "servingsOne" : plural === "few" ? "servingsFew" : "servingsMany", {
            count: new Intl.NumberFormat(localeTag(locale)).format(count),
          });
    return [servings, amount].filter(Boolean).join(" · ") || t("wholeRecipe");
  }
  return [item.brand, item.variant, amount ? t("perBasis", { amount }) : null]
    .filter(Boolean)
    .join(" · ");
}

function FoodDetail({
  user,
  profileId,
  food,
  signIn,
}: {
  user: User;
  profileId: string;
  food: FoodSummary;
  signIn: () => void;
}) {
  const { locale, t } = useLocale();
  const [load, retry] = useLoad(`${user.uid}:${profileId}:${food.type}:${food.id}`, async () => {
    const found = await api<{ product?: Product; recipe?: Recipe }>(
      user,
      "GET",
      `/api/v1/profiles/${profileId}/${food.type === "product" ? "products" : "recipes"}/${food.id}`,
    );
    const item = found.product ?? found.recipe;
    if (!item) throw new Error("food missing");
    return item;
  });
  return (
    <Loaded load={load} what={t("foodDetails")} retry={retry} signIn={signIn} cards={1}>
      {(item) => (
        <>
          <h2>{item.name}</h2>
          <p className="sub">
            {summary(
              "ingredients" in item
                ? {
                    type: "recipe",
                    basis_amount: item.yield_amount,
                    basis_unit: item.yield_unit,
                    servings: item.servings,
                    brand: null,
                    variant: null,
                  }
                : { ...item, type: "product", servings: null },
              t,
              locale,
            )}
          </p>
          {"ingredients" in item ? null : (
            <p className="sub">
              {item.preparation?.description ??
                (item.preparation
                  ? t(
                      item.preparation.state === "other"
                        ? "otherPreparation"
                        : item.preparation.state === "unspecified"
                          ? "unspecifiedPreparation"
                          : item.preparation.state,
                    )
                  : t("notRecorded"))}
              {item.provenance && (
                <>
                  {" "}
                  · <SourceBadge source={item.provenance.source} />
                </>
              )}
            </p>
          )}
          <dl className="kv num">
            {NUTRIENTS.map(([key, , unit]) => (
              <div key={key} style={{ display: "contents" }}>
                <dt>{nutrientLabel(key, locale)}</dt>
                <dd className={item.nutrients[key] === undefined ? "unknown" : undefined}>
                  {item.nutrients[key] === undefined
                    ? t("notRecorded")
                    : `${"partial_nutrients" in item && item.partial_nutrients?.includes(key) ? "≥ " : ""}${formatAmount(item.nutrients[key], unit, locale)}`}
                </dd>
              </div>
            ))}
          </dl>
          {"ingredients" in item && item.ingredients.length > 0 && (
            <div className="list">
              {item.ingredients.map((i) => (
                <div className="row" key={i.id}>
                  <span className="l">
                    <b>{i.name}</b>
                    <span>
                      {new Intl.NumberFormat(localeTag(locale)).format(i.quantity)} {i.unit}
                    </span>
                  </span>
                  <SourceBadge source={i.source} />
                </div>
              ))}
            </div>
          )}
          {item.note && <p className="notice">{item.note}</p>}
          <p className="fine">{t("savedFoodNote")}</p>
        </>
      )}
    </Loaded>
  );
}
