import { createR2Client } from "./storage.js";

const REQUIRED_ENV_VARS = [
  "APP_PASSWORD_HASH",
  "SESSION_SECRET",
  "GITHUB_PAT",
  "GIT_REPO_URL",
  "TCLI_AUTH_TOKEN",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
];

/** Pure: builds an HTTPS git remote URL with the PAT embedded for auth, per the plan's
 * "https://x-access-token:<PAT>@github.com/..." pattern (not the repo's SSH remote). */
export function injectPatIntoUrl(repoUrl, pat) {
  const url = new URL(repoUrl);
  url.username = "x-access-token";
  url.password = pat;
  return url.toString();
}

export function loadConfig(env = process.env) {
  const missing = REQUIRED_ENV_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  return {
    port: Number(env.PORT) || 3000,
    sessionSecret: env.SESSION_SECRET,
    passwordHash: env.APP_PASSWORD_HASH,
    repoUrl: injectPatIntoUrl(env.GIT_REPO_URL, env.GITHUB_PAT),
    branch: env.GIT_TARGET_BRANCH || "main",
    tcliPath: env.TCLI_PATH || "tcli",
    r2Bucket: env.R2_BUCKET_NAME,
    r2Client: createR2Client({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    }),
    // Safe-by-default: tracked/enforced everywhere (including a fresh
    // Render deploy that forgets to set anything) unless explicitly turned
    // off. Render's 5GB/month outbound cap only meters traffic leaving
    // Render's own servers — a real publish run locally can't consume any
    // of it regardless of target branch, so a local .env is the intended
    // place to opt out, not something Render itself should ever set.
    trackBandwidth: env.DISABLE_BANDWIDTH_TRACKING !== "true",
  };
}
