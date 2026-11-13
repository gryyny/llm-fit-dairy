// @vitest-environment jsdom
import type { Auth } from "firebase/auth";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { SignIn } from "../src/SignIn.js";

vi.mock("firebase/auth", async (original) => ({
  ...(await original<typeof import("firebase/auth")>()),
  onIdTokenChanged: (_auth: Auth, listener: (user: null) => void) => {
    listener(null);
    return () => undefined;
  },
}));
vi.mock("../src/firebase.js", () => ({
  completeRedirect: () => Promise.resolve(),
  signIn: vi.fn(() => Promise.resolve()),
  signInByRedirect: vi.fn(() => Promise.resolve()),
  signInWithPassword: vi.fn(() => Promise.resolve()),
  signUpWithPassword: vi.fn(() => Promise.resolve()),
  resetPassword: vi.fn(() => Promise.resolve()),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});
const click = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
};
const fill = (id: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Missing input: ${id}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("public authentication", () => {
  it.each(["/", "/settings", "/connect", "/join?code=synthetic"])(
    "shows both methods immediately at %s",
    async (path) => {
      window.history.replaceState(null, "", path);
      await act(async () => {
        root.render(<App auth={{} as Auth} />);
        await Promise.resolve();
      });
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector(".language-picker")).toBeNull();
      expect(container.querySelector("#password-email")).not.toBeNull();
      expect(container.querySelector("#password-secret")).not.toBeNull();
      expect(container.textContent).toContain("Continue with Google");
      expect(container.textContent).toContain("Create account");
      expect(container.textContent).not.toContain("Only for accounts we created");
    },
  );

  it("routes sign-in, open sign-up and password reset to their own actions", async () => {
    const google = vi.fn(() => Promise.resolve());
    const password = vi.fn(() => Promise.resolve());
    const signUp = vi.fn(() => Promise.resolve());
    const reset = vi.fn(() => Promise.resolve());
    act(() => {
      root.render(<SignIn heading={<h1>Welcome</h1>} {...{ google, password, signUp, reset }} />);
    });
    fill("password-email", "synthetic@example.test");
    fill("password-secret", "synthetic-test-password");
    await click("Sign in with email");
    expect(password).toHaveBeenCalledWith("synthetic@example.test", "synthetic-test-password");
    expect(signUp).not.toHaveBeenCalled();
    await click("Create account");
    expect(container.querySelector("#password-secret")?.getAttribute("autocomplete")).toBe(
      "new-password",
    );
    await click("Create your account");
    expect(signUp).toHaveBeenCalledWith("synthetic@example.test", "synthetic-test-password");
    await click("Sign in");
    await click("Forgot password?");
    expect(reset).toHaveBeenCalledWith("synthetic@example.test");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "If an account exists",
    );
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).not.toBe(
      true,
    );
    await click("Continue with Google");
    expect(google).toHaveBeenCalledOnce();
  });

  it("explains an existing account and permits retry without exposing Firebase errors", async () => {
    const signUp = vi
      .fn()
      .mockRejectedValueOnce({ code: "auth/email-already-in-use" })
      .mockResolvedValue(undefined);
    act(() => {
      root.render(
        <SignIn
          heading={null}
          google={() => Promise.resolve()}
          password={() => Promise.resolve()}
          signUp={signUp}
          reset={() => Promise.resolve()}
        />,
      );
    });
    fill("password-email", "synthetic@example.test");
    fill("password-secret", "synthetic-test-password");
    await click("Create account");
    await click("Create your account");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Sign in or reset your password",
    );
    expect(container.textContent).not.toContain("auth/email-already-in-use");
    await click("Create your account");
    expect(signUp).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
