import express from "express";
import cookieSession from "cookie-session";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./src/config.js";
import { log, logError } from "./src/logger.js";
import { createLockStore } from "./src/editLock.js";
import { createAuthRouter } from "./routes/auth.js";
import { createIndexRouter } from "./routes/index.js";
import { createTracksRouter } from "./routes/tracks.js";
import { createJobsRouter } from "./routes/jobs.js";
import { createLockRouter } from "./routes/lock.js";
import { createDiagnosticsRouter } from "./routes/diagnostics.js";
import { SubmissionError, THUNDERSTORE_URL } from "./src/publish.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
// One shared lock for the whole app (see src/editLock.js) — same
// single-instance assumption as runExclusive/jobs.js. Idle auto-expiry is
// otherwise silent (nothing else observes the moment it happens), so it's
// logged here — the one place that knows both "a lock just expired" and
// has the real logger to say so.
const lockStore = createLockStore({
  onExpire: (expired) => {
    const heldForMs = Date.now() - expired.acquiredAt;
    log(`Lock auto-expired for "${expired.displayName}" after 5 min idle (held for ${(heldForMs / 1000).toFixed(0)}s)`);
  },
});

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
// Available in every view render automatically (Express merges app.locals
// into res.render's locals) — avoids threading thunderstoreUrl through
// every individual res.render call across routes/auth.js, src/auth.js, and
// routes/tracks.js.
app.locals.thunderstoreUrl = THUNDERSTORE_URL;
app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: false }));
app.use(
  cookieSession({
    name: "session",
    secret: config.sessionSecret,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: "lax",
  })
);

// Every request, so the terminal shows real activity as it happens instead
// of going silent between the startup line and (maybe) an error.
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
  });
  next();
});

app.use(createAuthRouter(lockStore));
app.use(createIndexRouter(config, lockStore));
app.use(createTracksRouter(config, lockStore));
app.use(createJobsRouter());
app.use(createLockRouter(lockStore));
app.use(createDiagnosticsRouter());

// Friendly handling for multer errors (e.g. file over the 100MB cap, or
// mp3FileFilter's SubmissionError rejecting a non-.mp3 upload) instead of a
// raw unhandled 500 — both surface here since they're thrown from inside
// multer's own middleware (upload.single), before the route handler ever
// runs, so the route's own try/catch never sees them. POST /submit's
// client-side JS always expects JSON, so this responds in kind.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    logError("Upload rejected by multer:", err.message);
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err instanceof SubmissionError) {
    logError("Upload rejected:", err.message);
    return res.status(400).json({ error: err.message });
  }
  logError("Unhandled error:", err);
  res.status(500).send("Something went wrong.");
});

app.listen(config.port, () => {
  log(`Listening on port ${config.port} (target branch: ${config.branch})`);
});
