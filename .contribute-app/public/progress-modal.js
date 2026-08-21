// Shared by the upload page (add) and the tracks page (delete) — see
// views/partials/progress-modal.ejs for the modal HTML and the embedded
// window.PROGRESS_SEGMENTS data (server-computed, see src/stageWeights.js).
(function () {
  // .container has backdrop-filter set, which (per spec) creates a new
  // containing block for `position: fixed` descendants — meaning the modal
  // would end up "fixed" relative to that (often very tall, e.g. the
  // 60-row tracks page) container instead of the actual viewport, landing
  // it visually far below the fold. Moving it to a direct child of <body>
  // (which has no such ancestor) sidesteps that entirely.
  const overlay = document.getElementById("progress-modal");
  if (overlay && overlay.parentElement !== document.body) {
    document.body.appendChild(overlay);
  }

  const STAGE_LABELS = {
    "check-target-branch": "Checking configuration",
    "check-bandwidth-lock": "Checking this month's publish budget",
    "check-duplicate": "Checking for a duplicate track",
    "check-track-limit": "Checking the track limit",
    "check-exists": "Checking the track exists",
    clone: "Fetching the current mixtape",
    convert: "Converting audio to .ogg",
    "check-file-size": "Checking file size",
    "upload-to-r2": "Uploading track",
    "delete-from-r2": "Removing track",
    "regenerate-readme": "Updating the tracklist",
    commit: "Committing changes",
    "compute-version": "Computing next version",
    "push-branch": "Pushing changes",
    "push-tag": "Tagging release",
    "download-all-tracks": "Downloading full track library",
    "tcli-build": "Building package",
    "check-track-limit-pre-publish": "Final safety check",
    "tcli-publish": "Publishing to Thunderstore",
    "record-manifest": "Recording track info",
    "record-bandwidth": "Recording bandwidth usage",
    cleanup: "Cleaning up",
  };

  function friendlyLabel(stage) {
    return STAGE_LABELS[stage] || stage;
  }

  // A single bar-wide fill div (not one per segment) — the diagonal stripe
  // pattern tiles from that one element's own local origin, so it's
  // structurally impossible for it to look "out of sync with itself" the
  // way separate per-segment fills did (each one's stripes reset to their
  // own local 0,0, so adjacent segments' patterns never lined up at the
  // boundary even when their timing was perfectly in phase). `segments`
  // and each one's cumulative starting offset are kept here purely as data
  // for computing width targets — nothing about the DOM is per-segment.
  let segments = [];
  let cumulativeOffsets = [];

  function renderBar(newSegments) {
    const bar = document.getElementById("progress-bar");
    bar.innerHTML = "";
    const fill = document.createElement("div");
    fill.className = "progress-bar-fill";
    bar.appendChild(fill);

    segments = newSegments;
    cumulativeOffsets = [];
    let running = 0;
    for (const seg of segments) {
      cumulativeOffsets.push(running);
      running += seg.percent;
    }
  }

  // Below this, a stage doesn't get a slow gradual-fill animation at all —
  // real timing for a stage this short varies by a large fraction of its
  // own reference weight run to run (e.g. "commit" measured 0.2s once,
  // 0.6s another time), so animating it over its exact reference duration
  // just means it frequently gets yanked forward mid-animation the moment
  // the real next stage arrives, which reads as jerky/inaccurate. Ticking
  // it off quickly instead avoids ever starting an animation that has to
  // be interrupted.
  const MIN_ANIMATED_SECONDS = 2;

  // A linear fill that targets a stage's full share by its reference
  // duration will ALWAYS look finished early whenever the real stage
  // happens to run longer than its (necessarily approximate) weight — no
  // reference number can guarantee it's never too short, and a
  // cubic-bezier easing curve doesn't fix this either (a CSS transition
  // always reaches its target value exactly at the end of the specified
  // duration regardless of timing-function shape). So the animated fill
  // only ever advances to this fraction of the current stage's own share
  // while it's still actually running — the remainder is only ever filled
  // in once the real next-stage/done event confirms the stage is over. A
  // long-running stage just sits there (still visibly "not quite done")
  // for however long it actually takes, instead of looking misleadingly
  // complete.
  const ANIMATED_FILL_CAP_FRACTION = 0.9;

  // How long the "catch-up" snap (finishing up to the start of the new
  // current stage) takes. The stage's own fill deliberately waits this
  // long before starting — otherwise the two animate at once, which looks
  // like progress into the new stage already started before the previous
  // one actually finished ("tail starting before head finishes").
  const CATCHUP_MS = 150;

  // Guards against a stale, already-superseded startCurrentFill() callback
  // firing after a newer stage event has already moved things on (possible
  // if a real stage happens to complete in well under CATCHUP_MS).
  let latestRequestedStage = null;

  // Advances the one shared fill bar in two steps: first a quick snap up
  // to the cumulative width of every stage strictly before `stage` (in
  // case the real previous stage finished faster than its reference
  // weight expected — the bar shouldn't sit behind where we actually are),
  // then — only once that catch-up has actually finished — a gradual
  // animation covering `stage`'s own share, capped at
  // ANIMATED_FILL_CAP_FRACTION of it, over roughly that stage's own
  // expected duration.
  function updateBarForStage(stage) {
    latestRequestedStage = stage;
    const idx = segments.findIndex((s) => s.stage === stage);
    if (idx === -1) return;

    const fill = document.getElementById("progress-bar").querySelector(".progress-bar-fill");
    const stageStart = cumulativeOffsets[idx];
    const stagePercent = segments[idx].percent;
    const seconds = segments[idx].seconds;
    const animatedTarget = stageStart + stagePercent * ANIMATED_FILL_CAP_FRACTION;

    fill.style.transitionDuration = `${CATCHUP_MS}ms`;
    fill.style.width = `${stageStart}%`;

    const startCurrentFill = () => {
      // A newer stage event superseded this one while we were waiting —
      // let that call's own sequencing take over instead.
      if (latestRequestedStage !== stage) return;
      fill.style.transitionDuration = `${seconds >= MIN_ANIMATED_SECONDS ? seconds : 0.2}s`;
      fill.style.width = `${animatedTarget}%`;
    };

    setTimeout(startCurrentFill, CATCHUP_MS);
  }

  window.openProgressModal = function ({ jobId, type, dryRun }) {
    const overlay = document.getElementById("progress-modal");
    const title = document.getElementById("progress-modal-title");
    const stageLabel = document.getElementById("progress-modal-stage");
    const note = document.getElementById("progress-modal-note");
    const cancelButton = document.getElementById("progress-cancel-button");

    const segments = window.PROGRESS_SEGMENTS[dryRun ? "dryRun" : "real"];
    renderBar(segments);

    const verb = type === "delete" ? "Removing track" : "Adding track";
    title.textContent = dryRun ? `${verb} (dry run)` : verb;
    stageLabel.textContent = "Starting…";
    note.textContent = "";
    cancelButton.hidden = false;
    cancelButton.disabled = false;
    cancelButton.textContent = "Cancel";

    overlay.hidden = false;
    document.body.style.overflow = "hidden";

    let cancelable = true;

    const source = new EventSource(`/jobs/${jobId}/events`);

    source.onmessage = (ev) => {
      const event = JSON.parse(ev.data);

      if (event.type === "snapshot" || event.type === "stage") {
        if (typeof event.cancelable === "boolean") cancelable = event.cancelable;
        cancelButton.hidden = !cancelable;
        if (event.stage) {
          stageLabel.textContent = `${friendlyLabel(event.stage)}…`;
          updateBarForStage(event.stage);
        }
      } else if (event.type === "cancel-requested") {
        cancelable = event.cancelable;
        cancelButton.disabled = true;
        cancelButton.textContent = cancelable ? "Cancelling…" : "Cancel requested";
        note.textContent = cancelable
          ? "Stopping before the next step."
          : "This step can't be safely interrupted once started — letting it finish.";
      } else if (event.type === "done") {
        const fill = document.getElementById("progress-bar").querySelector(".progress-bar-fill");
        if (fill) {
          fill.style.transitionDuration = "0.15s";
          fill.style.width = "100%";
        }
        source.close();
        document.body.style.overflow = "";
        window.location.href = `/jobs/${jobId}/result`;
      }
    };

    // A dropped connection doesn't mean the job died — it keeps running
    // server-side regardless. The browser's built-in EventSource
    // auto-reconnect handles a transient network blip on its own; nothing
    // extra to do here.
    source.onerror = () => {};

    cancelButton.addEventListener("click", () => {
      if (!cancelable || cancelButton.disabled) return;
      cancelButton.disabled = true;
      cancelButton.textContent = "Cancelling…";
      fetch(`/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => {});
    });

    // Deliberately no backdrop-click-to-close and no Escape handler — the
    // only way to dismiss this modal is Cancel (while it's still possible)
    // or the job actually finishing.
  };
})();
