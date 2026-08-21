# TheFieldMixtape — Design Spec

Reference for implementing the redesign in the actual app (github.com/TheFieldGames/TheFieldMixtape).
This consolidates the design decisions worked out in mockup iterations. Mockup HTML files
(`field-mixtape-*.html`) are visual references only — none of their code should be copied
directly, since they embed the background photo as base64 and use demo-only JS for the lock
state switcher.

## Concept

The app is themed as a physical cassette tape. This isn't decorative — it's pulled from the
existing background photo (a cassette labeled "The Field" sits in the scene), so every UI
device below has a real-world referent, not an invented motif.

- The **card** = the cassette shell.
- The **label strip** = the paper label glued to the tape, complete with the tape's actual
  color stripe (orange → red) and a printed side-letter marker.
- **"Start editing"** = pressing record. Only one person can record at a time.
- **Side A / Side B** = the live tracklist and the pending queue, literally two sides of the
  same tape.

## Design tokens

```css
:root {
  --shell: rgba(30,28,29,0.9);       /* cassette shell / card background */
  --shell-light: #46434A;             /* hub rings, secondary shell surfaces */
  --label-cream: #F2ECDD;             /* paper label background */
  --stripe-orange: #D98B3E;           /* label edge stripe, gradient start */
  --stripe-red: #B23A2E;              /* label edge stripe end; the ONE primary accent */
  --text-cream: #F5F0E6;              /* primary text on dark shell */
  --text-muted: rgba(245,240,230,0.62); /* secondary text on dark shell */
  --pending-amber: #D9A441;           /* "addition" / pending-new state */
  --pending-red: #C1554A;             /* "removal" / pending-delete state */
}
```

Only **one** accent (`--stripe-red` family) is used for primary, consequential actions
(Publish). Amber is reserved for "new/pending addition," a separate red-ish tone
(`--pending-red`, distinct from `--stripe-red`) marks "pending removal." Don't introduce
additional accent colors — the restraint is what keeps the palette readable.

## Typography

| Font | Use | Notes |
|---|---|---|
| **Kalam** (400/700) | Card titles inside the label strip ("Tracks", "Queue"); the "Side A"/"Side B" text next to the letter box | Handwritten — used sparingly, only in the label strip, so it doesn't fight legibility elsewhere |
| **Inter** (400/500/600) | All body text, buttons, form labels, helper text | Default UI face |
| **IBM Plex Mono** (400/500) | Track numbers, dates, file sizes, elapsed timers, the storage/quota gauge text | Reads like a tape counter's digital readout |
| **Archivo Black** | The single letter inside the side-marker box ("A" / "B") only | Bold/stamped look, distinct from Kalam — reads as a printed/stenciled mark rather than handwriting, matching how real cassette shells print their side letter |

Google Fonts import (adjust as needed for self-hosting):
```
Kalam:wght@400;700 | Inter:wght@400;500;600 | IBM+Plex+Mono:wght@400;500 | Archivo+Black
```

## Background photo

- Desktop: `background-image` on the outer page wrapper, `background-size: cover`,
  `background-position: center`, `background-attachment: fixed` — so it's always present
  behind every screen and doesn't scroll away.
- Mobile: drop `background-attachment: fixed` (unsupported/unreliable on iOS Safari) and use
  the separate mobile-cropped photo (`beach_mixtape_mobile-edited2.jpg` in the uploads) with
  plain `background-size: cover`.
- Two source photos exist: a landscape/desktop crop and a portrait/mobile crop. Both should
  ship as real static assets in the repo, referenced by normal relative path — the
  base64-embedding used in the mockups was only a workaround for previewing in the chat
  sandbox and should **not** be carried into the real app.

## Signature component: the cassette card

Repeats on every screen — this is the thing that makes the app recognizable.

```
[ hub ]                              [ hub ]     <- two decorative circles, top of card
┌─────────────────────────────────────────────┐
│  Title (Kalam)              Side A / [A]     │  <- label strip: cream bg, rotated ~0.4deg,
│  subtitle (Inter, muted)                     │     orange→red stripe along the bottom edge,
└─────────────────────────────────────────────┘     side-marker (Kalam text + Archivo Black
                                                      letter box) pinned to the right
```

- Card: `border-radius: 18px`, `background: var(--shell)`, `backdrop-filter: blur(6px)`,
  drop shadow.
- Hubs: two circles, `border: 3px solid var(--shell-light)`, dark fill, small inner dot —
  purely decorative, evokes tape reels.
- Label strip: `background: var(--label-cream)`, `transform: rotate(-0.4deg)`, drop shadow,
  bottom-edge gradient stripe (`linear-gradient(90deg, var(--stripe-orange) 0 70%, var(--stripe-red) 70% 100%)`).
- Label strip layout: `display: flex; justify-content: space-between; align-items: flex-start`.
  Left side = title (Kalam, larger) + subtitle. Right side = side-marker, which is itself
  `[Kalam "Side A" text] [Archivo Black letter-in-a-box]`, in that order (text before the
  box, both right-aligned as a unit).

## Screen: Side A — Tracks (editable table)

Purpose: the full live tracklist, always visible, with inline controls to mark existing
tracks for removal as part of the current batch.

- Toolbar row above the table: instruction text ("Click × to mark a track for removal") +
  a filter/search input (`<input placeholder="Filter tracks…">`) for finding a track among
  60+ without scrolling.
- **Table header sits outside the scrollable region** — it's a separate, non-scrolling grid
  row, not `position: sticky` inside the scroll container. (Earlier draft used sticky-in-scroll
  and it caused the scroll-fade gradient to visually collide with the header — see Scroll
  fades below.)
- Table body: `overflow-y: auto`, fixed `max-height`, scrollbar hidden (see below).
- Row grid: `# | Track | By | Added | action`.
- Row states:
  - **Normal**: solid border-bottom, action = small square × button (subtle border, only
    turns red-tinted on hover).
  - **Marked for removal**: `border-bottom-style: dashed`, `opacity: 0.6`, track title and
    "by" text get `text-decoration: line-through`, action button becomes an **↺ icon**
    (undo), amber-tinted border/color.
- Marking a row for removal does **not** delete it from the DOM/state — it flips a "pending
  removal" flag that's shared with the batch state (see Batch state below). This is why Side
  B's "Removing" section and Side A's dashed rows always agree with each other.

## Screen: Side B — Queue (additions + removals, both directions of the same batch)

Purpose: shows everything pending in the current batch, so a user doesn't have to scroll
Side A to see what's about to change.

- File picker (`<input type="file" multiple>`), styled with a dashed border to read as "not
  yet committed." Helper text directly below it: *"Each file must convert to under 8000KB.
  Up to 70 tracks total on the tape."* — the per-file constraint lives here because this is
  the moment a person is choosing files.
- **"+ Add to queue"** button (secondary style — outline, not filled) stages the selected
  files into the "Adding" list below. This does not touch the live mixtape.
- **Adding** section: label + count badge (amber `tag-pending` style), scrollable list of
  queued new tracks. Each row: title/artist/queued-by, a small **×** remove button (plain
  until hover, then red-tinted).
- Divider.
- **Removing** section: label + count badge (red `tag-removing` style), mirrors whatever is
  marked for removal on Side A. Each row: struck-through title/artist, an **↺** undo button
  (same icon/behavior as Side A's undo — both write to the same shared batch state, so
  clicking either place clears the mark everywhere).
- Both the Adding list and the Removing list are independently scrollable with the hidden-scrollbar
  + fade treatment described below, since either could grow long.

## Shared batch state

Additions (queued new files) and removals (marked existing tracks) are two views onto **one**
batch object — not two separate features. Conceptually:

```
batch = {
  additions: [ {file, title, artist, size}, ... ],
  removals:  [ trackId, trackId, ... ]
}
```

- Side A's × marks a track ID as a removal in the shared batch.
- Side A's ↺ (on a dashed row) clears that mark.
- Side B's "Removing" list renders directly from `batch.removals`; its ↺ does the same clear.
- Side B's "Adding" list renders from `batch.additions`; its × removes an item from that list.
- The **batch bar** (below) reads from the same object to compute the net summary and to
  gate the Publish button.

## Batch bar (sticky footer)

Always visible at the bottom of the page while a batch is open. From left to right:

1. **Quota gauge** — small horizontal bar (`width` proportional to GB used / GB cap) +
   monospace text: `"0.23"/4.5GB this month · ~18 publishes left"`. Separated from the rest
   of the bar by a hairline divider. This lives here (not in Side B) because Publish is the
   action that actually consumes the monthly quota — the number that matters should sit next
   to the button that spends it.
2. **Batch summary**, monospace: `+N additions` (amber) · `−N removals` (red) ·
   `→ M tracks after publish` (muted). Always reflects the live batch state.
3. **Publish changes** button — the *only* button in the whole system styled with
   `--stripe-red` as a fill. Disabled (dimmed, non-interactive) with a specific reason shown
   in nearby helper text when the batch can't be published (e.g., a queued track is missing
   a title) — never just grayed out with no explanation.
4. **Clear batch** — plain text/underline button, resets both additions and removals back to
   empty in one action.

## Scroll fades (Side A table body, Side B Adding/Removing lists)

Replaces the native scrollbar with a content-aware gradient hint.

- Hide the native scrollbar: `scrollbar-width: none;` (Firefox) and
  `::-webkit-scrollbar { display: none; }` (WebKit).
- Wrap the scrollable element in a `position: relative` container with two absolutely
  positioned gradient overlays (`~22–26px` tall, `pointer-events: none`):
  - top: `linear-gradient(180deg, rgba(shell, 0.85), transparent)`
  - bottom: `linear-gradient(0deg, rgba(shell, 0.85), transparent)`
- **Important:** the fade overlays must be scoped to the scrollable body only — if a column
  header sits above the scroll area, keep it *outside* the `position: relative` wrapper so
  the fade never overlaps it. (This was a bug in an earlier draft: a sticky-in-scroll header
  caused the top fade to render over the header instead of the first row.)
- JS: a small scroll listener toggles a `.visible` class (`opacity: 1`) on each fade based on
  actual scroll position — not a static CSS mask — so it's accurate as content is added or
  removed:
  ```js
  function wireFade(scrollEl, topFadeEl, bottomFadeEl) {
    function update() {
      const atTop = scrollEl.scrollTop <= 2;
      const atBottom = scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;
      const scrollable = scrollEl.scrollHeight > scrollEl.clientHeight + 2;
      topFadeEl.classList.toggle('visible', scrollable && !atTop);
      bottomFadeEl.classList.toggle('visible', scrollable && !atBottom);
    }
    scrollEl.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    update();
  }
  ```
  Apply to: Side A's track table body, Side B's Adding list, Side B's Removing list.

## Single-user lock ("recording") system

One shared lock covers the whole batch — editing Side A or Side B both require holding it.

### Deck bar (persistent, above both cassette cards)

Three states, driven by one status bar:

- **Idle** (nobody editing): hollow rec-dot icon, text *"Nobody's recording"*, a
  **"● Start editing"** button (outline style, `--stripe-red` border/text) that acquires the
  lock. Locking is **explicit** — there is no implicit lock-on-first-edit.
- **You hold the lock**: filled + pulsing rec-dot (`animation` on `opacity`, ~1.3s cycle),
  text *"You're recording"*, a live elapsed timer (`MM:SS`, monospace), a **"Stop editing"**
  button (outline, neutral) that releases the lock manually.
- **Someone else holds the lock**: filled rec-dot, **not pulsing** (steady fill — the one
  visual difference from "you," so it reads as "active but not yours" at a glance), their
  name in the status text, no action button on your end.

### Disabling edit controls when not holding the lock

When lock state is `idle` or `other`, every control that mutates the batch or the live
tracklist goes inert together: Side A's × buttons, Side B's file picker / "+ Add to queue" /
× / ↺ buttons, and the batch bar's Publish/Clear buttons. Implementation approach: set a
`data-lock-state="idle|you|other"` attribute on `<body>` (or a top-level wrapper) and use
attribute-selector CSS to apply `opacity: 0.38; pointer-events: none;` to the relevant
controls whenever the state isn't `you`. A short italic hint line near the disabled controls
points back at the deck bar (e.g. *"Press 'Start editing' above to add or remove tracks."*).
Browsing the live tracklist and using the filter/search box remain fully functional
regardless of lock state, since neither mutates shared data.

### Auto-expiry (idle timeout)

- Lock auto-releases after **5 minutes of inactivity** while held.
- At the **4:30 mark** (30 seconds before the cutoff), show an inline warning in the deck bar:
  *"Still there? Recording stops soon from inactivity."* with an **"I'm still here"** button
  that resets the idle timer.
- If ignored, the session ends automatically at 5:00 — same effect as the user pressing "Stop
  editing" themselves (back to the `idle` state, lock released for others).
- "Inactivity" should be defined server/session-side as no batch-mutating action (add,
  remove, undo) and probably no explicit heartbeat — exact signal is an implementation
  decision for Claude Code, but the UI contract above (30s warning, 5min cutoff) should hold
  regardless of how activity is detected.

### Open question (not yet resolved)

Whether "Dan is recording" should show an estimate of *remaining* safe wait time, or just
elapsed time as it does now. Flagged for a follow-up decision — not blocking implementation
of the rest of this spec.

## Icons

- Undo: **↺** (single Unicode character), sized/boxed to match the neighboring × button —
  not a text label. Include a `title="Undo removal"` attribute for accessibility/tooltip.
- Remove: **×**, plain square icon button, subtle border, only tints red on hover.

## Reference files

The following mockups were produced during design iteration and can be opened in a browser
for visual reference. They are not production code (background photo is base64-embedded for
preview purposes only, and the lock demo switcher is mockup-only scaffolding):

- `field-mixtape-redesign.html` — initial cassette-shell redesign of the original single-track
  add form and tracklist.
- `field-mixtape-queue.html` — first pass at the queue/publish split (Side A / Side B as
  separate concerns).
- `field-mixtape-batch-v3.html` — current reference for Side A/B batch editing, scroll fades,
  side-marker styling, and the file-size/quota disclaimer placement. **This is the most
  complete visual reference** — closest to this spec.
- `field-mixtape-lock.html` — the single-user lock / deck bar concept, with a 3-state demo
  switcher (Idle / You / Dan) at the top of the page.
