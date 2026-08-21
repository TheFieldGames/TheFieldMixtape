import express from "express";
import cookieSession from "cookie-session";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./src/config.js";
import { log, logError } from "./src/logger.js";
import authRoutes from "./routes/auth.js";
import { createIndexRouter } from "./routes/index.js";
import { THUNDERSTORE_URL, MAX_TRACKS, MAX_TRACK_FILE_SIZE_KB } from "./src/publish.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = loadConfig();

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
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

app.use(authRoutes);
app.use(createIndexRouter(config));

// Friendly handling for multer errors (e.g. file over the 100MB cap)
// instead of a raw unhandled 500.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    logError("Upload rejected by multer:", err.message);
    return res.status(400).render("upload", {
      displayName: req.session?.displayName,
      isAdmin: req.session?.isAdmin === true,
      error: `Upload error: ${err.message}`,
      usageInfo: null,
      thunderstoreUrl: THUNDERSTORE_URL,
      maxTracks: MAX_TRACKS,
      maxTrackFileSizeKb: MAX_TRACK_FILE_SIZE_KB,
    });
  }
  logError("Unhandled error:", err);
  res.status(500).send("Something went wrong.");
});

app.listen(config.port, () => {
  log(`Listening on port ${config.port} (target branch: ${config.branch})`);
});
