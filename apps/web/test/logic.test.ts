import { describe, expect, it } from "vitest";
import type { Target, Weight } from "../src/api.js";
import { chartSeries, currentTargets } from "../src/BodyScreen.js";
import { boundText, remainingText } from "../src/DayScreen.js";
import { dayHeading } from "../src/dates.js";
import { parseRoute } from "../src/router.js";
import { formatTotal, totals } from "../src/totals.js";

describe("display totals (WB-4)", () => {
  it("counts a partially known recipe as incomplete without discarding its stored contribution", () => {
    const result = totals([
      { nutrients: { energy_kcal: 150, fibre_g: 3 }, partial_nutrients: ["fibre_g"] },
      { nutrients: { fibre_g: 2 } },
    ]);
    expect(result.fibre_g).toEqual({ sum: 5, missing: 1, unknown: false });
    expect(formatTotal(result.fibre_g, "g")).toBe("≥ 5 g");
    expect(result.energy_kcal).toEqual({ sum: 150, missing: 1, unknown: false });
  });
  const items = [
    { nutrients: { energy_kcal: 228, protein_g: 8.1, salt_g: 0.01 } },
    { nutrients: { energy_kcal: 95, protein_g: 7 } },
    { nutrients: { carbohydrate_g: 11.6 } },
    { nutrients: {} },
  ];
  const all = totals(items);

  it("adds only stored values and counts the items missing each nutrient", () => {
    expect(all.energy_kcal).toEqual({ sum: 323, missing: 2, unknown: false });
    expect(all.carbohydrate_g).toEqual({ sum: 11.6, missing: 3, unknown: false });
  });

  it("keeps a nutrient no item has unknown, never zero", () => {
    expect(all.fibre_g).toEqual({ sum: 0, missing: 4, unknown: true });
    expect(formatTotal(all.fibre_g, "g")).toBe("Unknown");
  });

  it("marks partial totals as lower bounds and rounds only for display", () => {
    expect(formatTotal(all.energy_kcal, "kcal")).toBe("≥ 323 kcal");
    expect(formatTotal(all.salt_g, "g")).toBe("≥ 0 g");
    expect(formatTotal(totals([{ nutrients: { protein_g: 15.06 } }]).protein_g, "g")).toBe(
      "15.1 g",
    );
    expect(formatTotal(totals([{ nutrients: { energy_kcal: 1300.6 } }]).energy_kcal, "kcal")).toBe(
      "1,301 kcal",
    );
  });

  it("carries the lower-bound marking into target comparisons", () => {
    const range = { min: 2300, max: 2500 };
    expect(boundText(range, "kcal")).toBe("2,300–2,500 kcal");
    expect(boundText({ min: 140 }, "g")).toBe("≥ 140 g");
    expect(boundText({ value: 100, min: 90, max: 110 }, "g")).toBe("100 g (90–110 g)");
    expect(remainingText({ sum: 150, missing: 0, unknown: false }, { min: 100 }, "g")).toBe(
      "within target",
    );
    expect(remainingText({ sum: 1, missing: 0, unknown: false }, { max: 0 }, "g")).toBe("1 g over");
    expect(remainingText({ sum: 1301, missing: 1, unknown: false }, range, "kcal")).toBe(
      "at most 999 kcal to go",
    );
    expect(remainingText({ sum: 1301, missing: 0, unknown: false }, range, "kcal")).toBe(
      "999 kcal to go",
    );
    expect(remainingText({ sum: 2600, missing: 2, unknown: false }, range, "kcal")).toBe(
      "at least 100 kcal over",
    );
    expect(remainingText({ sum: 2400, missing: 0, unknown: false }, range, "kcal")).toBe(
      "within target",
    );
    expect(remainingText({ sum: 2400, missing: 1, unknown: false }, range, "kcal")).toBeNull();
    expect(remainingText({ sum: 0, missing: 3, unknown: true }, range, "kcal")).toBeNull();
  });
});

describe("routes (WB-1)", () => {
  it("parses the website's paths and refuses others", () => {
    expect(parseRoute("/")).toEqual({ name: "today" });
    expect(parseRoute("/day/2026-10-19")).toEqual({ name: "day", date: "2026-10-19" });
    expect(parseRoute("/day/2026-13-45")).toEqual({ name: "notFound" });
    expect(parseRoute("/join")).toEqual({ name: "join" });
    expect(parseRoute("/connect")).toEqual({ name: "connect" });
    expect(parseRoute("/history/extra")).toEqual({ name: "notFound" });
  });
});

describe("body helpers", () => {
  const weight = (date: string, value: number, unit: "kg" | "lb"): Weight => ({
    id: date,
    date,
    value,
    unit,
    note: null,
  });

  it("charts only the newest weigh-ins in one unit, oldest first", () => {
    const newestFirst = [
      weight("2026-10-19", 74.6, "kg"),
      weight("2026-10-18", 74.8, "kg"),
      weight("2026-10-10", 165, "lb"),
      weight("2026-10-01", 75.5, "kg"),
    ];
    expect(chartSeries(newestFirst).map((w) => w.date)).toEqual(["2026-10-18", "2026-10-19"]);
  });

  it("finds each kind's target in force and keeps the rest", () => {
    const target = (id: string, kind: "normal" | "training", from: string): Target => ({
      rationale: null,
      inputs: null,
      id,
      kind,
      effective_from: from,
      values: {},
      note: null,
    });
    const newestFirst = [
      target("future", "normal", "2026-11-01"),
      target("now", "normal", "2026-10-01"),
      target("train", "training", "2026-10-01"),
      target("old", "normal", "2026-09-01"),
    ];
    const { current, others } = currentTargets(newestFirst, "2026-10-19");
    expect(current.map((t) => t.id)).toEqual(["train", "now"]);
    expect(others.map((t) => t.id)).toEqual(["future", "old"]);
  });
});

describe("day heading (WB-2)", () => {
  it("names today and yesterday, otherwise the weekday, without repeating it", () => {
    expect(dayHeading("2026-10-19", "2026-10-19")).toEqual({
      title: "Today",
      subtitle: "Monday 19 October",
    });
    expect(dayHeading("2026-10-18", "2026-10-19")).toEqual({
      title: "Yesterday",
      subtitle: "Sunday 18 October",
    });
    expect(dayHeading("2026-10-12", "2026-10-19")).toEqual({
      title: "Monday",
      subtitle: "12 October",
    });
    expect(dayHeading("2025-12-31", "2026-10-19")).toEqual({
      title: "Wednesday",
      subtitle: "31 December 2025",
    });
  });
});
