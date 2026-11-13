import pg from "pg";
import { firebaseAdminVerifier } from "./access/firebase.js";
import { createApp } from "./app.js";
import { parseEnv } from "./config.js";
import { createDb, runMigrations } from "./db/client.js";

const env = parseEnv(process.env);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
await runMigrations(createDb(pool));
const app = await createApp({
  pool,
  commit: env.GIT_COMMIT,
  webDist: env.WEB_DIST,
  issuer: `https://${env.PUBLIC_HOSTNAME}`,
  oauth: {
    clients: [
      {
        id: "chatgpt",
        secretSha256: env.OAUTH_CHATGPT_CLIENT_SECRET_SHA256,
        redirectUris: env.OAUTH_CHATGPT_REDIRECT_URIS,
      },
    ],
    appsChallenge: env.OPENAI_APPS_CHALLENGE,
  },
  firebase: firebaseAdminVerifier(env.FIREBASE_PROJECT_ID),
});
app.enableShutdownHooks();
await app.listen(env.PORT, "0.0.0.0");
