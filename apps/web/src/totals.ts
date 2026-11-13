/** The eight diary nutrients (DA-3) with the labels and units the website shows. */
import { localeTag, message, type Locale } from "./i18n.js";

export const NUTRIENTS = [
  ["energy_kcal", "Energy", "kcal"],
  ["protein_g", "Protein", "g"],
  ["carbohydrate_g", "Carbohydrate", "g"],
  ["sugars_g", "Sugars", "g"],
  ["fat_g", "Fat", "g"],
  ["saturated_fat_g", "Saturated fat", "g"],
  ["fibre_g", "Fibre", "g"],
  ["salt_g", "Salt", "g"],
] as const;

export type NutrientKey = (typeof NUTRIENTS)[number][0];
export type Nutrients = Partial<Record<NutrientKey, number>>;

const LABEL_KEYS = {
  energy_kcal: "energy",
  protein_g: "protein",
  carbohydrate_g: "carbohydrate",
  sugars_g: "sugars",
  fat_g: "fat",
  saturated_fat_g: "saturatedFat",
  fibre_g: "fibre",
  salt_g: "salt",
} as const;
export const nutrientLabel = (key: NutrientKey, locale: Locale = "en") =>
  message(locale, LABEL_KEYS[key]);

export interface Total {
  /** Sum of the values that are stored. */
  sum: number;
  /** Entries with a missing value or an incomplete contribution. */
  missing: number;
  /** True when no item has a value: the total is unknown, not zero. */
  unknown: boolean;
}

/**
 * WB-4 display totals: adds only stored values, converts nothing and derives nothing. A total with
 * missing items is a lower bound; with no stored value at all it is unknown.
 */
export function totals(
  items: readonly { nutrients: Nutrients; partial_nutrients?: readonly NutrientKey[] }[],
): Record<NutrientKey, Total> {
  const result = {} as Record<NutrientKey, Total>;
  for (const [key] of NUTRIENTS) {
    const known = items.flatMap((i) =>
      typeof i.nutrients[key] === "number" ? [i.nutrients[key]] : [],
    );
    result[key] = {
      sum: known.reduce((a, b) => a + b, 0),
      missing: items.filter(
        (i) => i.nutrients[key] === undefined || i.partial_nutrients?.includes(key),
      ).length,
      unknown: known.length === 0,
    };
  }
  return result;
}

/** Rounds for display only: whole kcal, grams to one decimal. */
export const formatAmount = (value: number, unit: string, locale: Locale = "en") =>
  `${new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: unit === "kcal" ? 0 : 1 }).format(value)} ${unit}`;

/** "≥ 1,301 kcal" when some items lack the value, "Unknown" when none has it. */
export const formatTotal = (total: Total, unit: string, locale: Locale = "en") =>
  total.unknown
    ? message(locale, "unknown")
    : `${total.missing > 0 ? "≥ " : ""}${formatAmount(total.sum, unit, locale)}`;

export const formatIncomplete = (count: number, locale: Locale = "en") => {
  const plural = new Intl.PluralRules(localeTag(locale)).select(count);
  return message(
    locale,
    plural === "one"
      ? "incompleteEntriesOne"
      : plural === "few"
        ? "incompleteEntriesFew"
        : "incompleteEntriesMany",
    { count },
  );
};
