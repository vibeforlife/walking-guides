# Oʻahu Walking Guide — Option C (Scripts as files)

This build uses Option C:
- `routes.json` contains `scriptFile` paths
- narration lives in `/scripts/*.txt`
- app loads the narration file on demand (cached in memory)
- audio mode supports Offline Pack (placeholder WAVs) or TTS fallback

## Fresh GitHub Upload (recommended)
1) Delete everything in your GitHub repo (or create a new repo)
2) Upload ALL files/folders from this zip to the repo root:
   - index.html
   - app.js
   - routes.json
   - scripts/
   - audio/
   - icons/

3) GitHub Pages: Settings → Pages → Deploy from branch → main → /(root)

## Verify deployment
Open on your GitHub Pages domain:
- `/routes.json` should show 4 routes with many stops
- `/scripts/iolani.txt` should load as plain text
- `/audio/packs.json` should load as JSON

## Audio
- Set Audio = **TTS only** to hear narration.
- Offline pack audio is placeholder tones. Replace WAV/MP3 files later with real narration audio.


## Offline (UI + routes + scripts)
This build registers `sw.js` and precaches the app shell, `routes.json`, and all `/scripts/*.txt` so narration text works offline after the first load. Map tiles still require internet.
