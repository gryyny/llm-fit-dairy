import { initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  type Auth,
} from "firebase/auth";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/** Null when the website was built without the public Firebase web configuration. */
export const auth: Auth | null = Object.values(config).every(
  (v) => typeof v === "string" && v !== "",
)
  ? getAuth(initializeApp(config))
  : null;

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";

/**
 * AC-6: popup first; when Safari blocks or cannot open popups, fall back to the redirect flow,
 * whose result `completeRedirect` collects on return (authDomain is our own hostname).
 */
export async function signIn(auth: Auth): Promise<void> {
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    const code = errorCode(error);
    if (
      code === "auth/popup-blocked" ||
      code === "auth/operation-not-supported-in-this-environment"
    ) {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw error;
  }
}

/**
 * OA-3: `/connect` and `/join` run inside ChatGPT's sign-in browser or a link's browser, where popups
 * are unreliable, so they always use the redirect flow (AC-6 option 3) and return to the same page.
 */
export async function signInByRedirect(auth: Auth): Promise<void> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  await signInWithRedirect(auth, provider);
}

/** Firebase owns password credentials; the API receives only the verified ID token. */
export async function signInWithPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function completeRedirect(auth: Auth): Promise<void> {
  await getRedirectResult(auth);
}

export async function signUpWithPassword(
  auth: Auth,
  email: string,
  password: string,
): Promise<void> {
  await createUserWithEmailAndPassword(auth, email, password);
}

export async function resetPassword(auth: Auth, email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(auth, email);
  } catch (error) {
    // Keep the response the same when Firebase reports an unknown address.
    if (errorCode(error) !== "auth/user-not-found") throw error;
  }
}
