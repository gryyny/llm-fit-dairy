import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export interface VerifiedUser {
  uid: string;
  name: string | null;
  /** Firebase `sign_in_provider`, such as `google.com` or `password` (ID-3). */
  provider: string;
}

/** Firebase Authentication as the service uses it; stubbed in tests (OP-5). */
export interface FirebaseVerifier {
  /** Resolves null when the ID token is not acceptable. */
  verify(idToken: string): Promise<VerifiedUser | null>;
  /** ID-4: removes the person's Firebase sign-in when they delete their data. */
  deleteUser(uid: string): Promise<void>;
}

export const FIREBASE = Symbol("FIREBASE");

const authErrorCode = (error: unknown) =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;

/** AC-5: `verifyIdToken(token, true)` also rejects disabled users and revoked sessions. */
export function firebaseAdminVerifier(projectId: string): FirebaseVerifier {
  const auth = getAuth(initializeApp({ projectId, credential: applicationDefault() }));
  return {
    async verify(idToken) {
      try {
        const decoded = await auth.verifyIdToken(idToken, true);
        const name: unknown = decoded.name;
        return {
          uid: decoded.uid,
          name: typeof name === "string" && name !== "" ? name : null,
          provider: decoded.firebase.sign_in_provider,
        };
      } catch (error) {
        if (authErrorCode(error)?.startsWith("auth/")) return null;
        throw error;
      }
    },
    async deleteUser(uid) {
      try {
        await auth.deleteUser(uid);
      } catch (error) {
        if (authErrorCode(error) !== "auth/user-not-found") throw error;
      }
    },
  };
}
