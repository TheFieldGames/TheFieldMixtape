// Shared by every page with lock-gated controls (currently the queue page
// and the tracks page) — see views/partials/deck-bar.ejs for the markup
// and src/editLock.js for the server-side lock semantics.
(function () {
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
  const WARNING_BEFORE_MS = 30 * 1000;
  const POLL_MS = 4000;

  const deckBar = document.getElementById("deck-bar");
  if (!deckBar) return;

  const recDot = document.getElementById("rec-dot");
  const deckText = document.getElementById("deck-text");
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
      deckText.textContent = "Nobody's editing";
      deckTimer.textContent = "";
      idleWarning.hidden = true;
      startButton.hidden = false;
      stopButton.hidden = true;
    } else if (currentState.state === "you") {
      recDot.className = "rec-dot filled pulsing";
      deckText.textContent = "You're editing";
      deckTimer.textContent = formatElapsed(now - currentState.acquiredAt);
      const remaining = IDLE_TIMEOUT_MS - (now - currentState.lastActivityAt);
      idleWarning.hidden = remaining > WARNING_BEFORE_MS;
      startButton.hidden = true;
      stopButton.hidden = false;
    } else if (currentState.state === "other") {
      recDot.className = "rec-dot filled";
      deckText.textContent = `${currentState.displayName} is editing`;
      deckTimer.textContent = "";
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
  setInterval(poll, POLL_MS);
  setInterval(render, 1000);
})();
