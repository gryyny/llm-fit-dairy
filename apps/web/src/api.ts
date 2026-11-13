import type { User } from "firebase/auth";
import { useCallback, useEffect, useState } from "react";
import type { Nutrients, NutrientKey } from "./totals.js";

/** An API refusal; `status` 401 means the website session has to be renewed. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls our API with the signed-in person's Firebase ID token: `/api/v1` reads and `/api/manage`. */
export async function api<T>(user: User, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${await user.getIdToken()}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const field = (name: string) =>
      typeof data === "object" && data !== null && name in data
        ? String((data as Record<string, unknown>)[name])
        : null;
    throw new ApiError(res.status, field("code") ?? "error", field("message") ?? res.statusText);
  }
  return data as T;
}

export type Load<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "error"; message: string }
  | { state: "expired" };

export function refreshVisibleData(): void {
  window.dispatchEvent(new Event("diary:refresh"));
}

// Results carry their key so a render cannot show the previous person's/date's data before cleanup.
export function useLoad<T>(key: string, load: () => Promise<T>): [Load<T>, () => void] {
  const [snapshot, setSnapshot] = useState<{ key: string; result: Load<T> }>({
    key,
    result: { state: "loading" },
  });
  const [attempt, setAttempt] = useState(0);
  // The key describes all inputs; language-only rerenders must not reload records.
  const run = useCallback(load, [key]);
  useEffect(() => {
    let current = true;
    let inFlight = false;
    let queued = false;
    const start = () => {
      if (!current) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      void run()
        .then(
          (data) => {
            if (current) setSnapshot({ key, result: { state: "ready", data } });
          },
          (error: unknown) => {
            if (!current) return;
            setSnapshot({
              key,
              result:
                error instanceof ApiError && error.status === 401
                  ? { state: "expired" }
                  : {
                      state: "error",
                      message: error instanceof Error ? error.message : String(error),
                    },
            });
          },
        )
        .finally(() => {
          inFlight = false;
          if (current && queued) {
            queued = false;
            start();
          }
        });
    };
    const refresh = () => {
      if (document.visibilityState === "visible") start();
    };
    setSnapshot({ key, result: { state: "loading" } });
    start();
    window.addEventListener("focus", refresh);
    window.addEventListener("diary:refresh", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      current = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("diary:refresh", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [run, attempt, key]);
  return [
    snapshot.key === key ? snapshot.result : { state: "loading" },
    () => {
      setAttempt((n) => n + 1);
    },
  ];
}

export interface Me {
  consent_version: string;
  consent_required: boolean;
  user: { display_name: string; consent_version: string | null; consent_at: string | null };
  profile: { profile_id: string; name: string; version: number };
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  complete: boolean;
}

export type Source = "label" | "dataset" | "estimate";

interface Item {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  nutrients: Nutrients;
  partial_nutrients?: NutrientKey[];
  source: Source;
  note: string;
  label: { basis_amount: number; basis_unit: string; nutrients: Nutrients } | null;
}

interface Meal {
  id: string;
  label: string | null;
  note: string | null;
  entries: Item[];
}

export interface Bound {
  value?: number;
  min?: number;
  max?: number;
}

interface BodyFields {
  height: { value: number; unit: "cm" | "in" } | null;
  date_of_birth?: string | null;
  age: { years: number; as_of: string } | null;
  activity: string | null;
  goal: string | null;
}
export interface BodyContext extends BodyFields {
  version: number;
}
export interface ProfileDetail {
  profile: Me["profile"];
  body_context: BodyContext | null;
}
interface GoalInputs {
  body_context?: { version: number; fields: BodyFields };
  weight?: { id: string; version: number; date: string; value: number; unit: "kg" | "lb" };
}
export interface Target {
  rationale: string | null;
  inputs: GoalInputs | null;
  id: string;
  kind: "normal" | "training";
  effective_from: string;
  values: Partial<Record<NutrientKey, Bound>>;
  note: string | null;
}

export interface Weight {
  id: string;
  date: string;
  value: number;
  unit: "kg" | "lb";
  note: string | null;
}

export interface Day {
  date: string;
  target_kind: "normal" | "training";
  target: Target | null;
  meals: Meal[];
  weights: Weight[];
}

interface Preparation {
  state: "as_sold" | "as_published" | "other" | "unspecified";
  description: string | null;
}
type Provenance =
  | { source: "estimate" }
  | { source: "dataset"; catalogue_record_id: number }
  | { source: "label"; label: { basis_amount: number; basis_unit: string; nutrients: Nutrients } };
export interface FoodSummary {
  type: "product" | "recipe";
  id: string;
  version: number;
  name: string;
  food_kind: "basic" | "product" | "recipe" | null;
  brand: string | null;
  variant: string | null;
  recognition_description: string | null;
  preparation: Preparation | null;
  provenance: Provenance | null;
  basis_amount: number | null;
  basis_unit: string | null;
  servings: number | null;
  energy_kcal: number | null;
  partial_nutrients?: NutrientKey[];
  last_used_at: string | null;
}

export interface Product {
  preparation: Preparation | null;
  provenance: Provenance | null;
  variant: string | null;
  recognition_description: string | null;
  id: string;
  name: string;
  brand: string | null;
  barcode: string | null;
  basis_amount: number;
  basis_unit: string;
  nutrients: Nutrients;
  note: string | null;
}

export interface Recipe {
  id: string;
  name: string;
  yield_amount: number | null;
  yield_unit: string | null;
  servings: number | null;
  nutrients: Nutrients;
  partial_nutrients?: NutrientKey[];
  note: string | null;
  ingredients: Item[];
}

export interface Connection {
  connection_id: string;
  client: string;
  connected_by_me: boolean;
  linked_at: string;
  last_used_at: string | null;
}

/** The diary days from..to, oldest first (at most 31 days per request). */
export const readDays = (user: User, profileId: string, from: string, to: string) =>
  api<{ days: Day[] }>(user, "GET", `/api/v1/profiles/${profileId}/diary?from=${from}&to=${to}`);
