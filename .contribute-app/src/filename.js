const ILLEGAL_CHARS = /[\/\\:*?"<>|]/g;

export function sanitizeNamePart(part) {
  const trimmed = part.trim().replace(ILLEGAL_CHARS, "");
  if (!trimmed) {
    throw new Error("Name part is empty after sanitization");
  }
  return trimmed;
}

export function buildTrackFilename(title, artist) {
  return `${sanitizeNamePart(title)} - ${sanitizeNamePart(artist)}.ogg`;
}

/** Extension only, not a content/mimetype check — matches the trust level
 * of the rest of this app (a small trusted friend group, not an
 * adversarial upload target). Case-insensitive since OS file pickers don't
 * normalize case. */
export function isMp3Filename(filename) {
  return /\.mp3$/i.test(filename || "");
}
