import { Router } from "express";

import { requireAuth } from "../src/auth.js";
import * as jobs from "../src/jobs.js";
import { THUNDERSTORE_URL } from "../src/publish.js";

/**
 * Backs the progress modal: POST /tracks/publish (the only route that
 * actually touches git/tcli) kicks a job off and returns {jobId}
 * immediately instead of awaiting the whole pipeline inline. These three
 * routes are what the client streams/acts on afterward — see
 * public/progress-modal.js for the browser side.
 */
export function createJobsRouter() {
  const router = Router();

  // Server-Sent Events: one-way server->browser stream of stage progress.
  // Plain HTTP, no new dependency — matches the app's minimal-dependency
  // philosophy (see MixTapeWebPlan.md's loading-bar design discussion for
  // why SSE was chosen over WebSocket/polling).
  router.get("/jobs/:jobId/events", requireAuth, (req, res) => {
    const job = jobs.getJob(req.params.jobId);
    if (!job) return res.status(404).end();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    // Declared before `send` (and assigned before subscribing) since
    // jobs.subscribe() calls `send` synchronously with an initial snapshot
    // — if that snapshot is already "done" (e.g. a client connecting after
    // a fast job already finished), `send` needs a real `unsubscribe` to
    // call immediately, not one still mid-assignment.
    let unsubscribe = () => {};
    const send = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      // Proactively end the response once the job is actually done, rather
      // than leaving the connection open indefinitely waiting on the
      // browser's own source.close() (belt-and-suspenders — the client
      // closes its side too, but a non-browser client, or one slow to
      // react, would otherwise hold the connection open forever).
      if (event.type === "done") {
        unsubscribe();
        res.end();
      }
    };
    unsubscribe = jobs.subscribe(req.params.jobId, send);
    req.on("close", unsubscribe);
  });

  // Requests cancellation. Always accepted (never a hard error even if
  // it's too late to take effect) — see jobs.requestCancel's own comment
  // for why: the UI needs an honest "requested but couldn't stop it"
  // signal, not a confusing failure response.
  router.post("/jobs/:jobId/cancel", requireAuth, (req, res) => {
    const result = jobs.requestCancel(req.params.jobId);
    if (!result.found) return res.status(404).json(result);
    res.json(result);
  });

  // Renders the same result.ejs the old synchronous flow used, once a job
  // has actually finished — the client navigates here after its SSE stream
  // sends a "done" event.
  router.get("/jobs/:jobId/result", requireAuth, (req, res) => {
    const job = jobs.getJob(req.params.jobId);
    if (!job) {
      return res.status(404).render("result", {
        success: false,
        error: "This job's result is no longer available (it may have expired) — try again.",
        committedButNotPublished: false,
        dryRun: false,
        thunderstoreUrl: THUNDERSTORE_URL,
      });
    }

    if (job.status === "running") {
      // Shouldn't normally happen (the client waits for "done" before
      // navigating here), but handle gracefully rather than 500.
      return res.status(202).send("Still running — try again shortly.");
    }

    if (job.status === "succeeded") {
      return res.render("result", {
        success: true,
        error: null,
        committedButNotPublished: false,
        ...job.result,
      });
    }

    // "failed" or "cancelled"
    res.status(job.status === "cancelled" ? 200 : 500).render("result", {
      success: false,
      error: job.error?.message || "Something went wrong.",
      committedButNotPublished: job.error?.committedButNotPublished || false,
      dryRun: job.dryRun,
      thunderstoreUrl: THUNDERSTORE_URL,
    });
  });

  return router;
}
