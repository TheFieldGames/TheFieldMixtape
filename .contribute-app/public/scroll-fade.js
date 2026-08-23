// Replaces a scrollable container's native scrollbar with a content-aware
// gradient hint (top/bottom) — see design/field-mixtape-design-spec.md's
// "Scroll fades" section.
//
// Exposed as window.wireScrollFade(root) rather than self-invoking on load,
// since tracks.ejs's queue-body gets replaced wholesale by a poll (see
// QUEUE_POLL_MS there) — a one-time auto-wire on script load would go
// stale for any [data-scroll-fade] wrapper created after that. The caller
// re-invokes this against the fresh root every time the DOM changes;
// re-wiring a still-live element (e.g. the very first call, right after
// this script tag runs) is a harmless no-op cost, not a correctness issue,
// since update() is idempotent.
window.wireScrollFade = function wireScrollFade(root = document) {
  function wireFade(scrollEl, topEl, bottomEl) {
    function update() {
      const atTop = scrollEl.scrollTop <= 2;
      const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;
      const scrollable = scrollEl.scrollHeight > scrollEl.clientHeight + 2;
      topEl.classList.toggle("visible", scrollable && !atTop);
      bottomEl.classList.toggle("visible", scrollable && !atBottom);
    }
    scrollEl.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    update();
  }

  root.querySelectorAll("[data-scroll-fade]").forEach((wrap) => {
    const scrollEl = wrap.querySelector("[data-scroll-fade-body]");
    const topEl = wrap.querySelector(".scroll-fade.top");
    const bottomEl = wrap.querySelector(".scroll-fade.bottom");
    if (scrollEl && topEl && bottomEl) wireFade(scrollEl, topEl, bottomEl);
  });
};
