// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dayHeading, shortDate } from "../src/dates.js";
import { LanguagePicker, LocaleProvider, resolveLocale, message } from "../src/i18n.js";
import { App } from "../src/App.js";
import { en, uk, type MessageKey } from "../src/messages.js";
import { SignIn } from "../src/SignIn.js";
import { formatAmount, totals } from "../src/totals.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/connect?code=synthetic");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("language", () => {
  it("resolves manual, device and browser choices in order, falling back to English", () => {
    expect(resolveLocale("en", ["uk-UA"], "uk")).toBe("uk");
    expect(resolveLocale("uk", ["en-US"])).toBe("uk");
    expect(resolveLocale(null, ["fr", "uk-UA", "en"])).toBe("uk");
    expect(resolveLocale(null, ["en-AU", "uk"])).toBe("en");
    expect(resolveLocale("invalid", ["de"])).toBe("en");
    expect(resolveLocale(null, [], "ua")).toBe("en");
  });

  it("has identical keys and placeholders in both catalogues", () => {
    expect(Object.keys(uk).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(uk[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("changes formatting without changing diary dates or nutrient values", () => {
    const amount = totals([{ nutrients: { protein_g: 12.35 } }]).protein_g.sum;
    expect(formatAmount(amount, "g", "uk")).toBe("12,4 g");
    expect(formatAmount(amount, "g", "en")).toBe("12.4 g");
    expect(amount).toBe(12.35);
    expect(dayHeading("2026-10-20", "2026-10-20", "uk").title).toBe("Сьогодні");
    expect(shortDate("2026-10-20", "uk")).toContain("20");
  });

  it("uses Ukrainian plural forms for one, few and many including 11 and 21", () => {
    const expected = ["1 порція", "2 порції", "5 порцій", "11 порцій", "21 порція", "22 порції"];
    for (const [i, count] of [1, 2, 5, 11, 21, 22].entries()) {
      const category = new Intl.PluralRules("uk-UA").select(count);
      expect(
        message(
          "uk",
          category === "one" ? "servingsOne" : category === "few" ? "servingsFew" : "servingsMany",
          { count },
        ),
      ).toBe(expected[i]);
    }
  });

  it("opens localized public pages without Firebase and respects their fixed URL language", () => {
    window.localStorage.setItem("food-diary.language", "en");
    window.history.replaceState(null, "", "/uk/privacy");
    act(() => {
      root.render(<App auth={null} />);
    });
    expect(container.textContent).toContain("Політика конфіденційності");
    expect(document.documentElement.lang).toBe("uk");
    expect(container.querySelector('a[href="/uk/terms"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Мова"]')).toBeNull();
    window.history.replaceState(null, "", "/privacy?lang=uk");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(container.textContent).toContain("Privacy policy");
    expect(document.documentElement.lang).toBe("en");
  });

  it("remembers a manual choice when the application is reopened", () => {
    act(() => {
      root.render(
        <LocaleProvider>
          <LanguagePicker />
        </LocaleProvider>,
      );
    });
    const picker = container.querySelector("select");
    if (!picker) throw new Error("Missing language selector");
    act(() => {
      picker.value = "uk";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(window.localStorage.getItem("food-diary.language")).toBe("uk");
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    act(() => {
      root.render(
        <LocaleProvider>
          <LanguagePicker />
        </LocaleProvider>,
      );
    });
    expect(container.querySelector("select")?.value).toBe("uk");
  });

  it("uses browser language when reading browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["uk-UA", "en"]);
    act(() => {
      root.render(
        <LocaleProvider>
          <LanguagePicker />
        </LocaleProvider>,
      );
    });
    expect(container.querySelector("select")?.value).toBe("uk");
  });

  it("keeps form input, account mode and OAuth query intact on a language switch, including blocked storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    act(() => {
      root.render(
        <LocaleProvider initialLocale="en">
          <LanguagePicker />
          <SignIn
            heading={null}
            google={() => Promise.resolve()}
            password={() => Promise.resolve()}
            signUp={() => Promise.resolve()}
            reset={() => Promise.resolve()}
          />
        </LocaleProvider>,
      );
    });
    const email = container.querySelector<HTMLInputElement>("#password-email");
    const secret = container.querySelector<HTMLInputElement>("#password-secret");
    if (!email || !secret) throw new Error("Missing sign-in form");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        email,
        "person@example.test",
      );
      email.dispatchEvent(new Event("input", { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        secret,
        "synthetic-password",
      );
      secret.dispatchEvent(new Event("input", { bubbles: true }));
      const create = [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Create account",
      );
      create?.click();
    });
    const picker = container.querySelector("select");
    if (!picker) throw new Error("Missing language selector");
    await act(async () => {
      picker.value = "uk";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.documentElement.lang).toBe("uk");
    expect(container.textContent).toContain("Продовжити з Google");
    expect(email.value).toBe("person@example.test");
    expect(secret.value).toBe("synthetic-password");
    expect(secret.autocomplete).toBe("new-password");
    expect(window.location.search).toBe("?code=synthetic");
  });
});
