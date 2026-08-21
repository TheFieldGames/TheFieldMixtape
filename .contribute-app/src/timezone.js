// Only used for parsing manually-entered dates (e.g. the legacy track
// attribution correction script) — the live submission flow always uses
// `new Date()` for addedAt, never a user-supplied string, so this timezone
// complexity never runs in the actual request path.

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const centralPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Converts a Y-M-D calendar date into the UTC instant for midnight on that
 * date in America/Chicago, correctly accounting for CST (UTC-6) vs CDT
 * (UTC-5) — the offset isn't fixed, so a flat "+6 hours" would be wrong for
 * roughly half the year.
 *
 * Standard offset-discovery trick (no timezone library needed, works for
 * any IANA zone Node's Intl supports): treat the target Y-M-D as if it were
 * already UTC (`guess`), ask what wall-clock time that instant reads as in
 * Chicago, then the gap between the two tells us Chicago's current offset —
 * which we add back to `guess` to land on the real target instant.
 */
export function centralMidnightToUtc(year, month, day) {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const parts = Object.fromEntries(centralPartsFormatter.formatToParts(guess).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMs = guess.getTime() - asIfUtc;
  return new Date(guess.getTime() + offsetMs);
}

/**
 * Parses a manually-entered addedAt value. A bare "YYYY-MM-DD" date is read
 * as midnight US Central time on that day (see centralMidnightToUtc above);
 * anything else (a full timestamp with an explicit "Z" or +/-HH:MM offset)
 * is parsed as-is via the Date constructor, respecting whatever zone was
 * explicitly given rather than reinterpreting it.
 */
export function parseAddedAt(input) {
  if (input == null) return null;
  if (BARE_DATE_RE.test(input)) {
    const [year, month, day] = input.split("-").map(Number);
    return centralMidnightToUtc(year, month, day);
  }
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Could not parse addedAt value: "${input}"`);
  }
  return parsed;
}
