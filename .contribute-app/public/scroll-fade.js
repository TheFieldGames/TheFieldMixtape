// Replaces a scrollable container's native scrollbar with a content-aware
// gradient hint (top/bottom) — see design/field-mixtape-design-spec.md's
// "Scroll fades" section. Auto-wires any [data-scroll-fade] wrapper found
// on the page, so new scrollable lists don't need their own JS.
(function () {
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

  document.querySelectorAll("[data-scroll-fade]").forEach((wrap) => {
    const scrollEl = wrap.querySelector("[data-scroll-fade-body]");
    const topEl = wrap.querySelector(".scroll-fade.top");
    const bottomEl = wrap.querySelector(".scroll-fade.bottom");
    if (scrollEl && topEl && bottomEl) wireFade(scrollEl, topEl, bottomEl);
  });
})();
