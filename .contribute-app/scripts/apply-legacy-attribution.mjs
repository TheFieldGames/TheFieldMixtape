// One-off (but reusable) maintenance script: reads
// legacy-track-attribution.json (gitignored — real names, manually filled
// in by the maintainer, see MixTapeWebPlan.md's manifest section) and
// applies any filled-in addedBy/addedAt corrections to the real manifest.json
// in R2, in a single write. Entries left as TEMP/null are skipped entirely —
// nothing about them changes.
//
// Run with: npm run apply-legacy-attribution

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { LEGACY_ADDED_BY, applyManualCorrections } from "../src/manifest.js";
import { parseAddedAt } from "../src/timezone.js";
import { log } from "../src/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = path.join(__dirname, "..", "legacy-track-attribution.json");

async function main() {
  const raw = await fsp.readFile(INPUT_PATH, "utf8");
  const { tracks } = JSON.parse(raw);

  const corrections = tracks
    .filter((t) => t.addedBy !== LEGACY_ADDED_BY && t.addedBy != null)
    .map((t) => ({
      filename: t.filename,
      addedBy: t.addedBy,
      addedAt: parseAddedAt(t.addedAt),
    }));

  const skipped = tracks.length - corrections.length;
  log(`Applying ${corrections.length} correction(s), skipping ${skipped} still-TEMP/unfilled entr${skipped === 1 ? "y" : "ies"}...`);

  const config = loadConfig();
  const updated = await applyManualCorrections(config.r2Client, config.r2Bucket, corrections);

  log(`Done. Manifest now has ${Object.keys(updated.tracks).length} total track entries.`);
  for (const c of corrections) {
    log(`  ${c.filename} -> addedBy: ${c.addedBy}, addedAt: ${c.addedAt.toISOString()}`);
  }
}

main().catch((err) => {
  console.error("Failed to apply legacy track attribution:", err);
  process.exit(1);
});
