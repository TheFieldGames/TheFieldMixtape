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
