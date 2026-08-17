# Adding a song

No git or coding knowledge needed — just your browser.

1. Open the [`my mixtape`](../my%20mixtape) folder on GitHub.
2. Click **Add file** → **Upload files**.
3. Drag in your `.ogg` file. Name it `Song Title - Artist.ogg` (that filename becomes the tracklist entry, so match the existing style).
4. Scroll down. Under "Commit changes," pick **"Create a new branch for this commit and start a pull request"** — not "Commit directly to the main branch."
5. Click **Propose changes**, then **Create pull request**.

That's it. The tracklist in `README.md` updates itself automatically once you upload. A maintainer reviews and merges your pull request, and the mixtape mod republishes with your track included.

A couple of things to know:
- Browser uploads are capped at 25MB per file — a normal `.ogg` track (a few MB) is well under that.
- Only `.ogg` files belong in `my mixtape/` — other formats won't get picked up.
