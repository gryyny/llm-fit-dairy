// ID-3: `node dist/admin.js provision-password-user <email> --name <display name>`, run by hand.
// Prints only the new password on stdout, so the operator can redirect it into a root-only file.
import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { name: { type: "string" } },
});
const args = z
  .object({
    command: z.literal("provision-password-user"),
    email: z.email(),
    name: z.string().trim().min(1).max(60),
  })
  .safeParse({ command: positionals[0], email: positionals[1], name: values.name });
if (!args.success) {
  console.error("Usage: admin provision-password-user <email> --name <display name>");
  process.exit(2);
}
const { email, name } = args.data;

const env = z.object({ FIREBASE_PROJECT_ID: z.string().min(1) }).parse(process.env);
const auth = getAuth(
  initializeApp({ projectId: env.FIREBASE_PROJECT_ID, credential: applicationDefault() }),
);
const password = randomBytes(18).toString("base64url");
const existing = await auth.getUserByEmail(email).catch((error: unknown) => {
  if (error instanceof Error && "code" in error && error.code === "auth/user-not-found")
    return null;
  throw error;
});
if (existing) {
  await auth.updateUser(existing.uid, { password, displayName: name, emailVerified: true });
} else {
  await auth.createUser({ email, password, displayName: name, emailVerified: true });
}

console.error("Review account ready; the new password is on stdout.");
console.log(password);
