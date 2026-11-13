import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Compose passes unset optional variables as empty strings; those mean "not set". */
const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

/** The app's environment, validated at start. */
export const parseEnv = (env: NodeJS.ProcessEnv) =>
  z
    .object({
      DATABASE_URL: z.string().min(1),
      PORT: z.coerce.number().int().positive().default(3000),
      GIT_COMMIT: z.string().min(1).default("unknown"),
      FIREBASE_PROJECT_ID: z.string().min(1),
      PUBLIC_HOSTNAME: z.string().regex(/^[a-z0-9.-]+$/),
      OAUTH_CHATGPT_CLIENT_SECRET_SHA256: z.string().regex(/^[0-9a-f]{64}$/),
      OAUTH_CHATGPT_REDIRECT_URIS: z
        .string()
        .default("https://chatgpt.com/connector_platform_oauth_redirect")
        .transform((v) => v.split(",").map((u) => u.trim()))
        .pipe(z.array(z.url({ protocol: /^https$/ })).min(1)),
      OPENAI_APPS_CHALLENGE: optional,
      WEB_DIST: z
        .string()
        .min(1)
        .default(fileURLToPath(new URL("../../web/dist", import.meta.url))),
    })
    .parse(env);
