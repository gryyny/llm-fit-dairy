// @vitest-environment jsdom
import type { User } from "firebase/auth";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectScreen, JoinScreen } from "../src/Approve.js";
import { Shell } from "../src/App.js";
import { DayScreen } from "../src/DayScreen.js";
import { SettingsScreen } from "../src/SettingsScreen.js";
import { FoodsScreen } from "../src/FoodsScreen.js";
import { LocaleProvider, LanguagePicker } from "../src/i18n.js";
import { ChatAction } from "../src/ui.js";
import { BodyScreen } from "../src/BodyScreen.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** A signed-in Firebase user as far as the website uses it. */
const userFor = (uid: string, name = "Synthetic Alice") =>
  ({
    uid,
    displayName: name,
    email: `${uid}@example.test`,
    getIdToken: () => Promise.resolve(`id:${uid}`),
  }) as unknown as User;

interface Call {
  method: string;
  path: string;
  token: string;
  body: unknown;
}
type Handler = (call: Call) => Response;

let container: HTMLDivElement;
let root: Root;
let calls: Call[];
let routes: Record<string, Handler>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  calls = [];
  routes = {};
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: input instanceof Request ? input.url : input.toString(),
      token: new Headers(init?.headers).get("Authorization") ?? "",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => `${call.method} ${call.path}`.startsWith(k));
    const handler = key ? routes[key] : undefined;
    return Promise.resolve(
      handler ? handler(call) : Response.json({ code: "not_found" }, { status: 404 }),
    );
  };
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

const render = (node: ReactNode) => {
  act(() => {
    root.render(node);
  });
};
const text = () => container.textContent;

async function until(condition: () => boolean) {
  for (let i = 0; i < 100 && !condition(); i++) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 5)));
  }
  expect(condition()).toBe(true);
}

const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === label,
  );
  if (!found) throw new Error(`no button ${label}`);
  return found;
};
const click = (label: string) => {
  act(() => {
    button(label).click();
  });
};

const entry = (name: string, nutrients: Record<string, number>) => ({
  id: name,
  name,
  quantity: 1,
  unit: "serving",
  nutrients,
  source: "estimate",
  note: "synthetic",
  label: null,
});
const DAY = {
  date: "2026-10-19",
  target_kind: "training",
  target: {
    id: "t",
    kind: "training",
    effective_from: "2026-10-01",
    values: { energy_kcal: { min: 2300, max: 2500 } },
    note: null,
  },
  meals: [
    {
      id: "m1",
      label: "Breakfast",
      note: null,
      entries: [entry("Rolled oats", { energy_kcal: 228, protein_g: 8.1 }), entry("Espresso", {})],
    },
    {
      id: "m2",
      label: "Lunch",
      note: null,
      entries: [entry("Chicken rice bowl", { energy_kcal: 1073 })],
    },
  ],
  weights: [{ id: "w", date: "2026-10-19", value: 74.6, unit: "kg", note: "Morning" }],
};
const dayScreen = (user = userFor("uid-a")) => (
  <DayScreen user={user} profileId="p-a" date="2026-10-19" signIn={() => undefined} />
);

describe("day view (WB-2, WB-4)", () => {
  it.each(["en", "uk"] as const)(
    "keeps partial recipe values visible in %s totals and entry details",
    async (locale) => {
      routes["GET /api/v1/profiles/p-a/diary"] = () =>
        Response.json({
          days: [
            {
              ...DAY,
              meals: [
                {
                  id: "recipe-meal",
                  label: "Synthetic recipe",
                  note: null,
                  entries: [
                    {
                      ...entry("Partial portion", { energy_kcal: 150, protein_g: 8, fibre_g: 3 }),
                      partial_nutrients: ["energy_kcal", "protein_g", "fibre_g"],
                    },
                  ],
                },
              ],
            },
          ],
        });
      render(<LocaleProvider initialLocale={locale}>{dayScreen()}</LocaleProvider>);
      await until(() => text().includes("Partial portion"));
      expect(text()).toContain("≥ 150");
      expect(text()).toContain("≥ 8 g");
      expect(text()).toContain(locale === "en" ? "1 incomplete entry" : "1 неповний запис");
      expect(text()).not.toContain(locale === "en" ? "1 missing" : "1 без значення");
      const portion = container.querySelector<HTMLButtonElement>("button.entry");
      if (!portion) throw new Error("portion missing");
      act(() => {
        portion.click();
      });
      expect(text()).toContain("≥ 3 g");
      expect(calls.every((call) => call.method === "GET")).toBe(true);
    },
  );
  it("shows saved meals with lower-bound totals and an honest target comparison", async () => {
    routes["GET /api/v1/profiles/p-a/diary"] = () => Response.json({ days: [DAY] });
    render(dayScreen());
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    await until(() => text().includes("Rolled oats"));
    expect(text()).toContain("≥ 1,301kcal");
    expect(text()).toContain("1 incomplete entry");
    expect(text()).toContain("at most 999 kcal to go");
    expect(text()).toContain("Training day");
    expect(text()).toContain("74.6 kg");
    expect(calls[0]?.token).toBe("Bearer id:uid-a");
  });

  it("shows an empty state that says what to tell ChatGPT", async () => {
    routes["GET /api/v1/profiles/p-a/diary"] = () =>
      Response.json({ days: [{ ...DAY, meals: [], weights: [] }] });
    render(dayScreen());
    await until(() => text().includes("Nothing logged yet"));
    expect(text()).toContain("I had porridge with milk for breakfast.");
  });

  it("offers a retry after an error and a sign-in after an expired session", async () => {
    let fail = true;
    routes["GET /api/v1/profiles/p-a/diary"] = () =>
      fail
        ? Response.json({ code: "internal_error" }, { status: 500 })
        : Response.json({ days: [DAY] });
    render(dayScreen());
    await until(() => text().includes("Couldn't load this day"));
    fail = false;
    click("Try again");
    await until(() => text().includes("Rolled oats"));

    routes["GET /api/v1/profiles/p-a/diary"] = () =>
      Response.json({ code: "invalid_credential" }, { status: 401 });
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    render(dayScreen());
    await until(() => text().includes("Your sign-in expired"));
  });
});

describe("core progress (UX-19/20/25)", () => {
  it("groups four metrics and respects minimum, maximum and ranged targets", async () => {
    routes["GET /api/v1/profiles/p-a/diary"] = () =>
      Response.json({
        days: [
          {
            ...DAY,
            target: {
              ...DAY.target,
              values: {
                energy_kcal: { value: 100 },
                protein_g: { min: 50 },
                carbohydrate_g: { min: 20, max: 40 },
                fat_g: { max: 10 },
              },
            },
            meals: [
              {
                ...DAY.meals[0],
                entries: [
                  entry("Synthetic meal", {
                    energy_kcal: 150,
                    protein_g: 70,
                    carbohydrate_g: 30,
                    fat_g: 5,
                  }),
                ],
              },
            ],
          },
        ],
      });
    render(dayScreen());
    await until(() => text().includes("Synthetic meal"));
    const groups = [...container.querySelectorAll('[aria-label="Day totals"] [role="group"]')];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "Calories",
      "Protein",
      "Carbohydrate",
      "Fat",
    ]);
    expect(groups.map((g) => g.querySelector<HTMLElement>('[role="img"] i')?.style.width)).toEqual([
      "100%",
      "100%",
      "75%",
      "50%",
    ]);
    expect(groups[1]?.textContent).toContain("within target");
    expect(groups[1]?.textContent).not.toContain("over");
    expect(groups[2]?.textContent).toContain("20–40 g");
    expect(groups[2]?.querySelector<HTMLElement>(".bar-min")?.style.left).toBe("50%");
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("More nutrients");
    expect(details?.textContent).toContain("Sugars");
    expect(details?.textContent).toContain("Fibre");
  });

  it("marks partial macros and never draws a numeric bar for entirely unknown values", async () => {
    routes["GET /api/v1/profiles/p-a/diary"] = () =>
      Response.json({
        days: [
          {
            ...DAY,
            target: {
              ...DAY.target,
              values: { protein_g: { value: 100 }, carbohydrate_g: { value: 100 } },
            },
            meals: [
              {
                ...DAY.meals[0],
                entries: [entry("Known", { protein_g: 25 }), entry("Unknown", {})],
              },
            ],
          },
        ],
      });
    render(dayScreen());
    await until(() => text().includes("Known"));
    const protein = container.querySelector('[role="group"][aria-label="Protein"]');
    const carbs = container.querySelector('[role="group"][aria-label="Carbohydrate"]');
    expect(protein?.textContent).toContain("≥ 25 g");
    expect(protein?.textContent).toContain("1 incomplete entry");
    expect(protein?.textContent).toContain("at most 75 g to go");
    expect(protein?.querySelector('[role="img"]')?.classList.contains("partial")).toBe(true);
    expect(carbs?.querySelector("b")?.textContent).toBe("Unknown");
    expect(carbs?.querySelector('[role="img"]')).toBeNull();
  });

  it("handles known zero, zero bounds and missing targets without invented percentages", async () => {
    routes["GET /api/v1/profiles/p-a/diary"] = () =>
      Response.json({
        days: [
          {
            ...DAY,
            target: { ...DAY.target, values: { energy_kcal: { value: 0 }, protein_g: { max: 0 } } },
            meals: [
              {
                ...DAY.meals[0],
                entries: [entry("Zero", { energy_kcal: 0, protein_g: 0, fat_g: 2 })],
              },
            ],
          },
        ],
      });
    render(dayScreen());
    await until(() => text().includes("Zero"));
    const card = container.querySelector('[aria-label="Day totals"]');
    expect(card?.querySelectorAll('[role="img"]').length).toBe(0);
    expect(card?.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector('[role="group"][aria-label="Protein"]')?.textContent).toContain(
      "0 g",
    );
    const fat = container.querySelector('[role="group"][aria-label="Fat"]');
    expect(fat?.textContent).toContain("2 g");
    expect(fat?.textContent).not.toContain("Target");
  });

  it("shows saved goals and zero logged intake before the first meal", async () => {
    routes["GET /api/v1/profiles/p-a/diary"] = () =>
      Response.json({ days: [{ ...DAY, meals: [], weights: [] }] });
    render(dayScreen());
    await until(() => text().includes("Nothing logged yet"));
    expect(text()).toContain("0 logged");
    expect(text()).toContain("Target 2,300–2,500 kcal");
    expect(text()).toContain("2,300 kcal to go");
    expect(
      container.querySelector('[aria-label="Day totals"] [role="img"] i')?.getAttribute("style"),
    ).toContain("width: 0%");
  });

  it("localizes the summary without translating saved meal text", async () => {
    routes["GET /api/v1/profiles/p-a/diary"] = () => Response.json({ days: [DAY] });
    render(<LocaleProvider initialLocale="uk">{dayScreen()}</LocaleProvider>);
    await until(() => text().includes("Rolled oats"));
    expect(text()).toContain("Білки");
    expect(text()).toContain("≥ 8,1 g");
    expect(text()).toContain("1 неповний запис");
    expect(text()).toContain("Тренувальний день");
    expect(text()).toContain("Breakfast");
  });
});

describe("complete body history (UX-24)", () => {
  it("loads current targets independently of future history and exposes later pages", async () => {
    const current = [
      {
        id: "active-normal",
        kind: "normal",
        effective_from: "2020-01-01",
        values: { energy_kcal: { value: 1900 } },
        note: "Active normal",
      },
      {
        id: "active-training",
        kind: "training",
        effective_from: "2020-01-01",
        values: { energy_kcal: { value: 2200 } },
        note: "Active training",
      },
    ];
    const future = Array.from({ length: 60 }, (_, i) => ({
      id: `future-${i}`,
      kind: "normal",
      effective_from: `2099-03-${String((i % 28) + 1).padStart(2, "0")}`,
      values: { energy_kcal: { value: 2000 + i } },
      note: null,
    }));
    const targets = [...future, ...current];
    const weights = Array.from({ length: 61 }, (_, i) => ({
      id: `w-${i}`,
      date: new Date(Date.UTC(2026, 0, 61 - i)).toISOString().slice(0, 10),
      value: 80 - i / 10,
      unit: "kg",
      note: `sample-${i}`,
    }));
    routes["GET /api/v1/profiles/p-a/targets"] = (call) => {
      const query = new URL(call.path, "https://diary.test").searchParams;
      if (query.has("kind")) {
        return Response.json({
          items: current.filter((target) => target.kind === query.get("kind")),
          next_cursor: null,
          complete: true,
        });
      }
      const offset = query.has("cursor") ? 50 : 0;
      return Response.json({
        items: targets.slice(offset, offset + 50),
        next_cursor: offset ? null : "target-next",
        complete: offset > 0,
      });
    };
    routes["GET /api/v1/profiles/p-a/weights"] = (call) => {
      const offset = new URL(call.path, "https://diary.test").searchParams.has("cursor") ? 50 : 0;
      return Response.json({
        items: weights.slice(offset, offset + 50),
        next_cursor: offset ? null : "weight-next",
        complete: offset > 0,
      });
    };
    routes["GET /api/v1/profiles/p-a"] = () =>
      Response.json({
        profile: { profile_id: "p-a", name: "Synthetic Alice", version: 1 },
        body_context: null,
      });
    render(<BodyScreen user={userFor("uid-a")} profileId="p-a" signIn={() => undefined} />);
    await until(() => text().includes("Active normal"));
    click("Training day");
    await until(() => text().includes("Active training"));
    click("Normal day");
    expect(text()).toContain("Active normal");
    expect(calls.filter((call) => call.path.includes("effective_on="))).toHaveLength(2);
    expect(text()).not.toContain("sample-60");
    click("More weigh-ins");
    await until(() => text().includes("sample-60"));
    click("More targets");
    await until(
      () =>
        calls.some((call) => call.path.includes("cursor=target-next")) &&
        text().includes("Active normal"),
    );
    expect(container.querySelectorAll('[aria-label="Normal day"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Training day"]')).toHaveLength(0);
    expect(calls.some((call) => call.path.includes("cursor=weight-next"))).toBe(true);
  });

  it.each([false, true])("spaces chart dates safely (same day: %s)", async (sameDay) => {
    routes["GET /api/v1/profiles/p-a/targets"] = () =>
      Response.json({ items: [], next_cursor: null, complete: true });
    const dates = sameDay
      ? ["2026-01-01", "2026-01-01"]
      : ["2026-01-11", "2026-01-02", "2026-01-01"];
    routes["GET /api/v1/profiles/p-a/weights"] = () =>
      Response.json({
        items: dates.map((date, i) => ({
          id: `w-${i}`,
          date,
          value: 70 + i,
          unit: "kg",
          note: null,
        })),
        next_cursor: null,
        complete: true,
      });
    routes["GET /api/v1/profiles/p-a"] = () =>
      Response.json({
        profile: { profile_id: "p-a", name: "Synthetic Alice", version: 1 },
        body_context: null,
      });
    render(<BodyScreen user={userFor("uid-a")} profileId="p-a" signIn={() => undefined} />);
    await until(() => container.querySelector("svg.chart") !== null);
    const chart = container.querySelector("svg.chart");
    expect(chart?.innerHTML).not.toMatch(/NaN|Infinity/);
    const points = [...(chart?.querySelectorAll("circle") ?? [])].map((circle) =>
      Number(circle.getAttribute("cx")),
    );
    if (sameDay) {
      expect(chart?.querySelector("polyline")).toBeNull();
      expect(points[0]).toBe(points[1]);
    } else {
      const [first = 0, middle = 0, last = 0] = points;
      expect((middle - first) / (last - first)).toBeCloseTo(0.1, 3);
    }
  });
});

describe("shell (WB-2)", () => {
  it("shows only the signed-in person's profile when the person changes", async () => {
    routes["GET /api/manage/me"] = (call) =>
      Response.json({
        user: { display_name: "x", consent_version: null, consent_at: null },
        profile: {
          profile_id: call.token.endsWith("uid-a") ? "p-a" : "p-b",
          name: call.token.endsWith("uid-a") ? "Profile of A" : "Profile of B",
        },
      });
    routes["GET /api/v1/profiles/p-a/diary"] = () => Response.json({ days: [DAY] });
    routes["GET /api/v1/profiles/p-b/diary"] = () =>
      Response.json({ days: [{ ...DAY, meals: [], weights: [] }] });
    const shell = (uid: string) => (
      <Shell key={uid} user={userFor(uid)} route={{ name: "today" }} signOut={() => undefined} />
    );
    render(shell("uid-a"));
    await until(() => text().includes("Profile of A") && text().includes("Rolled oats"));
    expect(container.querySelector(".language-picker")).toBeNull();
    // Person B signs in (for example in another tab) without A signing out first.
    render(shell("uid-b"));
    await until(() => text().includes("Profile of B") && text().includes("Nothing logged yet"));
    expect(text()).not.toContain("Profile of A");
    expect(text()).not.toContain("Rolled oats");
  });
});

describe("connecting ChatGPT (OA-3)", () => {
  it("needs consent before allowing, then sends the browser back to ChatGPT", async () => {
    const left: string[] = [];
    routes["GET /api/manage/oauth/request"] = () =>
      Response.json({
        request: { client: "chatgpt" },
        consent_required: true,
        consent_version: "1",
      });
    routes["POST /api/manage/oauth/decision"] = (call) =>
      Response.json({
        redirect_to: (call.body as { approve: boolean }).approve
          ? "https://chatgpt.test/cb?code=fdc_x"
          : "https://chatgpt.test/cb?error=access_denied",
      });
    render(
      <ConnectScreen
        user={userFor("uid-a")}
        onSwitch={() => undefined}
        leave={(u) => left.push(u)}
      />,
    );
    await until(() => text().includes("Connect your diary to ChatGPT?"));
    expect(button("Allow").disabled).toBe(true);
    act(() => {
      container.querySelector<HTMLInputElement>("#consent")?.click();
    });
    expect(button("Allow").disabled).toBe(false);
    click("Allow");
    await until(() => left.length === 1);
    expect(left).toEqual(["https://chatgpt.test/cb?code=fdc_x"]);
    expect(calls.at(-1)?.body).toEqual({ approve: true, consent: true });
  });

  it("sends a refusal back when the person cancels, and explains an expired request", async () => {
    const left: string[] = [];
    routes["GET /api/manage/oauth/request"] = () =>
      Response.json({
        request: { client: "chatgpt" },
        consent_required: false,
        consent_version: "1",
      });
    routes["POST /api/manage/oauth/decision"] = () =>
      Response.json({ redirect_to: "https://chatgpt.test/cb?error=access_denied" });
    render(
      <ConnectScreen
        user={userFor("uid-a")}
        onSwitch={() => undefined}
        leave={(u) => left.push(u)}
      />,
    );
    await until(() => text().includes("Connect your diary"));
    expect(button("Allow").disabled).toBe(false);
    click("Cancel");
    await until(() => left.length === 1);
    expect(calls.at(-1)?.body).toEqual({ approve: false });

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    delete routes["GET /api/manage/oauth/request"];
    render(
      <ConnectScreen
        user={userFor("uid-b")}
        onSwitch={() => undefined}
        leave={(u) => left.push(u)}
      />,
    );
    await until(() => text().includes("This request expired"));
  });
});

describe("joining by link (ID-4)", () => {
  it("names who asked and joins only on the person's approval", async () => {
    routes["GET /api/manage/join"] = () =>
      Response.json({
        join: { requested_by: "Synthetic Alice", already_joined: false },
        consent_required: true,
        consent_version: "1",
      });
    routes["POST /api/manage/join"] = () => Response.json({ joined: true });
    render(
      <JoinScreen
        user={userFor("uid-b", "Synthetic Bob")}
        code="fdj_code"
        onSwitch={() => undefined}
      />,
    );
    await until(() => text().includes("Join Synthetic Alice's ChatGPT food diary?"));
    expect(button("Join").disabled).toBe(true);
    act(() => {
      container.querySelector<HTMLInputElement>("#consent")?.click();
    });
    click("Join");
    await until(() => text().includes("You joined"));
    expect(calls.at(-1)?.body).toEqual({ code: "fdj_code", approve: true, consent: true });
  });

  it("explains a used or expired link", async () => {
    render(<JoinScreen user={userFor("uid-b")} code="fdj_old" onSwitch={() => undefined} />);
    await until(() => text().includes("This link no longer works"));
  });
});

describe("settings (WB-3)", () => {
  it.each(["remove", "delete"] as const)(
    "shows a failed %s inside its confirmation and permits a retry",
    async (action) => {
      let linked = true;
      let attempts = 0;
      let signedOut = false;
      routes["GET /api/manage/me"] = () =>
        Response.json({
          user: { display_name: "Synthetic Alice", consent_at: null },
          profile: { profile_id: "p-a", name: "Synthetic Alice" },
        });
      routes["GET /api/manage/connections"] = () =>
        Response.json({
          items: linked
            ? [{ connection_id: "g1", connected_by_me: true, linked_at: "2026-10-20T10:00:00Z" }]
            : [],
        });
      routes[`DELETE ${action === "remove" ? "/api/manage/connections/g1" : "/api/manage/me"}`] =
        () => {
          attempts++;
          if (attempts === 1) return Response.json({ code: "unavailable" }, { status: 503 });
          linked = false;
          return Response.json({ deleted: true });
        };
      render(
        <SettingsScreen
          user={userFor("uid-a")}
          signIn={() => undefined}
          signOut={() => {
            signedOut = true;
          }}
        />,
      );
      await until(() => text().includes("Synthetic Alice"));
      const trigger = [...container.querySelectorAll("button")].find((button) =>
        action === "remove"
          ? button.textContent.trim() === "Remove"
          : button.textContent.includes("Delete my data"),
      );
      if (!trigger) throw new Error("action missing");
      act(() => {
        trigger.click();
      });
      const confirm = container.querySelector<HTMLButtonElement>(".sheet .btn.danger");
      if (!confirm) throw new Error("confirmation missing");
      if (action === "delete") {
        const input = container.querySelector<HTMLInputElement>("#confirm-delete");
        act(() => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
            input,
            "delete",
          );
          input?.dispatchEvent(new Event("input", { bubbles: true }));
        });
      }
      act(() => {
        confirm.click();
      });
      await until(() => container.querySelector("[role=alert]") !== null);
      expect(container.querySelector(".sheet [role=alert]")).not.toBeNull();
      expect(confirm.disabled).toBe(false);
      act(() => {
        confirm.click();
      });
      await until(() => container.querySelector(".sheet") === null);
      expect(attempts).toBe(2);
      expect(signedOut).toBe(action === "delete");
      expect(container.querySelector("[role=alert]")).toBeNull();
    },
  );

  it("removes this profile from a connection after confirmation", async () => {
    let linked = true;
    routes["GET /api/manage/me"] = () =>
      Response.json({
        user: {
          display_name: "Synthetic Alice",
          consent_version: "1",
          consent_at: "2026-10-12T10:00:00Z",
        },
        profile: { profile_id: "p-a", name: "Synthetic Alice" },
      });
    routes["GET /api/manage/connections"] = () =>
      Response.json({
        items: linked
          ? [
              {
                connection_id: "g1",
                client: "chatgpt",
                connected_by_me: false,
                linked_at: "2026-10-12T10:00:00Z",
                last_used_at: null,
              },
            ]
          : [],
      });
    routes["DELETE /api/manage/connections/g1"] = () => {
      linked = false;
      return Response.json({ removed: { connection_id: "g1" } });
    };
    render(
      <SettingsScreen user={userFor("uid-a")} signIn={() => undefined} signOut={() => undefined} />,
    );
    await until(() => text().includes("ChatGPT, joined by link"));
    click("Remove");
    await until(() => text().includes("Remove this connection?"));
    const confirm = [...container.querySelectorAll(".sheet button")].find(
      (b) => b.textContent === "Remove",
    );
    act(() => {
      (confirm as HTMLButtonElement).click();
    });
    await until(() => text().includes("Not connected."));
    expect(
      calls.some((c) => c.method === "DELETE" && c.path === "/api/manage/connections/g1"),
    ).toBe(true);
  });
});

it("keeps Foods filters and an open detail sheet while switching language", async () => {
  const food = {
    type: "product",
    id: "food-1",
    version: 1,
    name: "Synthetic oats",
    food_kind: "basic",
    brand: null,
    variant: null,
    recognition_description: null,
    preparation: { state: "as_published", description: null },
    provenance: { source: "dataset", catalogue_record_id: 1 },
    basis_amount: 100,
    basis_unit: "g",
    servings: null,
    energy_kcal: 370,
    last_used_at: null,
  };
  routes["GET /api/v1/profiles/p1/foods"] = () =>
    Response.json({ items: [food], complete: true, next_cursor: null });
  routes["GET /api/v1/profiles/p1/products/food-1"] = () =>
    Response.json({
      product: {
        ...food,
        barcode: null,
        nutrients: { energy_kcal: 370, protein_g: 12.5 },
        note: null,
      },
    });
  render(
    <LocaleProvider initialLocale="en">
      <LanguagePicker />
      <FoodsScreen user={userFor("uid-a")} profileId="p1" signIn={() => undefined} />
    </LocaleProvider>,
  );
  await until(() => text().includes("Synthetic oats"));
  click("Basics");
  await until(() => calls.some((c) => c.path.includes("food_kind=basic")));
  const sort = container.querySelector<HTMLSelectElement>(".food-sort select");
  if (!sort) throw new Error("sort missing");
  act(() => {
    sort.value = "name";
    sort.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(() => calls.some((c) => c.path.includes("sort=name")));
  const row = container.querySelector<HTMLButtonElement>(".row");
  if (!row) throw new Error("food row missing");
  act(() => {
    row.click();
  });
  await until(() => text().includes("12.5 g"));
  expect(container.querySelector(".sheet .language-picker")).toBeNull();
  const language = container.querySelector<HTMLSelectElement>(".language-picker");
  if (!language) throw new Error("language missing");
  act(() => {
    language.value = "uk";
    language.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(() => text().includes("12,5 g"));
  expect(sort.value).toBe("name");
  expect(container.querySelector("button[aria-pressed=true]")?.textContent).toBe("Базові");
  expect(container.querySelector(".sheet")?.textContent).toContain("Synthetic oats");
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});

it.each(["product", "recipe"] as const)(
  "refreshes the open %s's basis together with its nutrients",
  async (type) => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let basis = 100;
    const summary = () => ({
      type,
      id: "food-1",
      name: "Synthetic food",
      brand: null,
      variant: null,
      basis_amount: basis,
      basis_unit: "g",
      servings: null,
      energy_kcal: basis * 2,
    });
    routes["GET /api/v1/profiles/p1/foods"] = () =>
      Response.json({ items: [summary()], complete: true, next_cursor: null });
    routes[`GET /api/v1/profiles/p1/${type === "product" ? "products" : "recipes"}/food-1`] = () =>
      Response.json({
        [type]: {
          ...summary(),
          yield_amount: basis,
          yield_unit: "g",
          nutrients: { energy_kcal: basis * 2 },
          ...(type === "recipe" ? { ingredients: [] } : { preparation: null, provenance: null }),
        },
      });
    render(<FoodsScreen user={userFor("uid-a")} profileId="p1" signIn={() => undefined} />);
    await until(() => text().includes("Synthetic food"));
    const row = container.querySelector<HTMLButtonElement>(".row");
    if (!row) throw new Error("food row missing");
    act(() => {
      row.click();
    });
    await until(() => container.querySelector(".sheet")?.textContent.includes("200 kcal") === true);
    expect(container.querySelector(".sheet")?.textContent).toContain("100 g");
    basis = 250;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await until(() => container.querySelector(".sheet")?.textContent.includes("500 kcal") === true);
    expect(container.querySelector(".sheet")?.textContent).toContain("250 g");
    expect(container.querySelector(".sheet")?.textContent).not.toContain("100 g");
  },
);

it("lets the signed-in owner review current consent without reconnecting", async () => {
  let required = true;
  routes["GET /api/manage/me"] = () =>
    Response.json({
      user: {
        display_name: "Synthetic Alice",
        consent_version: required ? "3" : "4",
        consent_at: null,
      },
      profile: { profile_id: "p1", name: "Synthetic Alice", version: 1 },
      consent_required: required,
      consent_version: "4",
    });
  routes["GET /api/manage/connections"] = () => Response.json({ items: [] });
  routes["POST /api/manage/consent"] = (call) => {
    expect(call.body).toEqual({ version: "4", consent: true });
    required = false;
    return Response.json({ consent_version: "4" });
  };
  render(
    <LocaleProvider initialLocale="en">
      <SettingsScreen user={userFor("uid-a")} signIn={() => undefined} signOut={() => undefined} />
    </LocaleProvider>,
  );
  await until(() => text().includes("Optional body and goals"));
  expect(container.querySelectorAll(".language-picker")).toHaveLength(1);
  expect(button("Save consent").disabled).toBe(true);
  const checkbox = container.querySelector<HTMLInputElement>("#consent");
  const language = container.querySelector<HTMLSelectElement>(".language-picker");
  if (!checkbox || !language) throw new Error("consent controls missing");
  act(() => {
    checkbox.click();
    language.value = "uk";
    language.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(checkbox.checked).toBe(true);
  click("Зберегти згоду");
  await until(() => !required && !container.querySelector("#consent"));
  expect(calls.filter((c) => c.method !== "GET").map((c) => c.path)).toEqual([
    "/api/manage/consent",
  ]);
});

it("keeps profile/body changes in chat and displays saved context and goal explanations", async () => {
  routes["GET /api/manage/me"] = () =>
    Response.json({
      user: { display_name: "Synthetic Google name", consent_version: "4", consent_at: null },
      profile: { profile_id: "p1", name: "Synthetic saved name", version: 2 },
      consent_required: false,
      consent_version: "4",
    });
  routes["GET /api/manage/connections"] = () => Response.json({ items: [] });
  render(
    <SettingsScreen user={userFor("uid-a")} signIn={() => undefined} signOut={() => undefined} />,
  );
  await until(() => text().includes("Synthetic saved name"));
  expect(container.querySelector("#profile-name")).toBeNull();
  expect(container.querySelector("form")).toBeNull();
  const rename = container.querySelector("details.chat-action");
  expect(rename?.textContent).toContain("Change the saved profile name for Synthetic saved name");
  const context = {
    height: { value: 180, unit: "cm" },
    age: { years: 31, as_of: "2026-10-01" },
    activity: "Synthetic cycling",
    goal: "Synthetic maintenance",
  };
  routes["GET /api/v1/profiles/p1/weights"] = () =>
    Response.json({
      items: [{ id: "w1", date: "2026-10-01", value: 80, unit: "kg", note: null }],
      complete: true,
      next_cursor: null,
    });
  routes["GET /api/v1/profiles/p1/targets"] = () =>
    Response.json({
      items: [
        {
          id: "t1",
          kind: "normal",
          effective_from: "2026-01-01",
          values: { energy_kcal: { value: 2000 } },
          rationale: "Synthetic agreed explanation",
          inputs: { body_context: { version: 1, fields: context } },
          note: null,
        },
      ],
      complete: true,
      next_cursor: null,
    });
  routes["GET /api/v1/profiles/p1"] = () =>
    Response.json({
      profile: { profile_id: "p1", name: "Synthetic saved name", version: 2 },
      body_context: {
        version: 2,
        ...context,
        date_of_birth: "1988-02-29",
        activity: "Synthetic walking",
      },
    });
  render(
    <LocaleProvider initialLocale="uk">
      <BodyScreen user={userFor("uid-a")} profileId="p1" signIn={() => undefined} />
    </LocaleProvider>,
  );
  await until(() => text().includes("Synthetic walking"));
  expect(text()).toContain("Synthetic agreed explanation");
  expect(text()).toContain("Synthetic cycling");
  expect(text()).toContain("31 рік");
  expect(text()).toContain("станом на");
  const ageLabel = [...container.querySelectorAll("dt")].find(
    (element) => element.textContent === "Вік",
  );
  expect(ageLabel?.nextElementSibling?.textContent).toContain("2026");
  const birthLabel = [...container.querySelectorAll("dt")].find(
    (element) => element.textContent === "Дата народження",
  );
  expect(birthLabel?.nextElementSibling?.textContent).toContain("1988");
  routes["GET /api/v1/profiles/p1"] = () =>
    Response.json({
      profile: { profile_id: "p1", name: "Synthetic saved name", version: 2 },
      body_context: {
        version: 3,
        ...context,
        date_of_birth: "1988-02-29",
        activity: "Synthetic swimming",
      },
    });
  await act(() => window.dispatchEvent(new Event("focus")));
  await until(() => text().includes("Synthetic swimming"));
  expect(text()).not.toContain("Synthetic walking");
  expect(text()).toContain("Synthetic agreed explanation");
  expect(text()).toContain("Synthetic cycling");
  expect(text()).toContain("1988");
  expect(container.querySelector("input,textarea")).toBeNull();
  expect(calls.every((c) => c.method === "GET")).toBe(true);
});

it("does not claim a changed goal prompt has already been copied", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => Promise.resolve() },
  });
  try {
    render(<ChatAction label="Change in chat" prompt="Synthetic normal goals" />);
    click("Copy prompt");
    await until(() => text().includes("Copied"));
    render(<ChatAction label="Change in chat" prompt="Synthetic training goals" />);
    expect(text()).not.toContain("Copied");
    expect(text()).toContain("Synthetic training goals");
  } finally {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
