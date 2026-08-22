// Shared by every page with lock-gated controls (currently the queue page
// and the tracks page) — see views/partials/deck-bar.ejs for the markup
// and src/editLock.js for the server-side lock semantics.
(function () {
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const WARNING_BEFORE_MS = 30 * 1000;
  const POLL_MS = 4000;
  // How long with no page interaction before we stop polling the server at
  // all — distinct from IDLE_TIMEOUT_MS above, which is the server-side
  // lock's own idle timeout for someone actively recording.
  const POLL_IDLE_AFTER_MS = 30 * 1000;

  const deckBar = document.getElementById("deck-bar");
  if (!deckBar) return;

  const recDot = document.getElementById("rec-dot");
  const deckText = document.getElementById("deck-text");
  const deckSub = document.getElementById("deck-sub");
  const deckTimer = document.getElementById("deck-timer");
  const idleWarning = document.getElementById("idle-warning");
  const startButton = document.getElementById("start-editing-button");
  const stopButton = document.getElementById("stop-editing-button");
  const stillHereButton = document.getElementById("still-here-button");

  // Server-rendered initial state avoids a flash of "idle" (and gated
  // controls briefly looking enabled) while the first poll is in flight.
  let currentState = window.INITIAL_LOCK_STATE || { state: "idle" };

  function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  function render() {
    const now = Date.now();
    document.body.dataset.lockState = currentState.state;

    if (currentState.state === "idle") {
      recDot.className = "rec-dot";
      deckText.textContent = "Nobody's recording";
      deckSub.textContent = "Anyone can start a session to add or remove tracks.";
      deckTimer.textContent = "";
      idleWarning.hidden = true;
      startButton.hidden = false;
      stopButton.hidden = true;
    } else if (currentState.state === "you") {
      recDot.className = "rec-dot filled pulsing";
      deckText.textContent = currentState.isDemo ? "You're recording (demo)" : "You're recording";
      deckSub.textContent = "Editing is unlocked for you. Ends automatically after 5 minutes idle.";
      deckTimer.textContent = formatElapsed(now - currentState.acquiredAt);
      const remaining = IDLE_TIMEOUT_MS - (now - currentState.lastActivityAt);
      idleWarning.hidden = remaining > WARNING_BEFORE_MS;
      startButton.hidden = true;
      stopButton.hidden = false;
    } else if (currentState.state === "other") {
      recDot.className = "rec-dot filled";
      deckText.textContent = currentState.isDemo
        ? `${currentState.displayName} is recording (demo)`
        : `${currentState.displayName} is recording`;
      deckSub.textContent = `Browsing is fine, but editing is locked until ${currentState.displayName} finishes or goes idle.`;
      // Elapsed time only, deliberately not an estimate of remaining safe
      // wait time — decided against showing a prediction we can't actually
      // back (the idle timer resets on activity we can't see from here).
      deckTimer.textContent = formatElapsed(now - currentState.acquiredAt);
      idleWarning.hidden = true;
      startButton.hidden = true;
      stopButton.hidden = true;
    }
  }

  async function poll() {
    try {
      const response = await fetch("/lock/status");
      currentState = await response.json();
      render();
    } catch (err) {
      // Transient network hiccup — leave the UI as-is, try again next poll.
    }
  }

  // Skip /lock/status polling while nobody's touching the page (e.g. a tab
  // left open in the background) — cheap to detect, and it's the bulk of
  // the endpoint's traffic. lastInteractionAt starts "now" so a freshly
  // loaded page isn't immediately treated as idle.
  let lastInteractionAt = Date.now();
  let pausedForIdle = false;

  function onUserActivity() {
    lastInteractionAt = Date.now();
    if (pausedForIdle) {
      // Coming back from idle: poll right away instead of waiting for the
      // next scheduled tick, so the UI catches up without a visible lag.
      pausedForIdle = false;
      poll();
    }
  }

  ["mousemove", "mousedown", "touchstart", "keydown", "scroll", "click"].forEach((type) => {
    window.addEventListener(type, onUserActivity, { passive: true });
  });

  function scheduledPoll() {
    if (Date.now() - lastInteractionAt >= POLL_IDLE_AFTER_MS) {
      pausedForIdle = true;
      return;
    }
    poll();
  }

  startButton.addEventListener("click", async () => {
    startButton.disabled = true;
    try {
      const response = await fetch("/lock/acquire", { method: "POST" });
      const data = await response.json();
      if (!data.ok) {
        alert(`${data.heldBy} is already editing.`);
      }
      await poll();
    } finally {
      startButton.disabled = false;
    }
  });

  stopButton.addEventListener("click", async () => {
    stopButton.disabled = true;
    try {
      await fetch("/lock/release", { method: "POST" });
      await poll();
    } finally {
      stopButton.disabled = false;
    }
  });

  stillHereButton.addEventListener("click", async () => {
    await fetch("/lock/heartbeat", { method: "POST" });
    await poll();
  });

  render();
  poll();
  setInterval(scheduledPoll, POLL_MS);
  setInterval(render, 1000);
})();
