# NeonBinder Scanner

Feeds cards from a sheet-fed scanner into an **Add cards** run on NeonBinder
(NEO-386). Each card scans both sides at once and goes up front then back; the
screen crops, reads, pairs and matches them like dropped photos, and nothing
saves until you say yes there.

Built for Fujitsu fi-series scanners (tested on the fi-7160). Mac only for
now.

## Using it (no setup beyond the download)

1. On NeonBinder, open **Add cards**, pick the binder or box, and press
   **Use a scanner**. It shows a six-character code and two download links.
2. On the computer the scanner is plugged into, download the one for your
   Mac (Apple menu → About This Mac: "Apple M…" means Apple chip, otherwise
   Intel) and open the zip. You get **NeonBinder Scanner**.
3. Double-click **NeonBinder Scanner**. The first time, macOS says it can't
   check the app for malicious software. Open **System Settings → Privacy &
   Security**, scroll down, and press **Open Anyway** next to NeonBinder
   Scanner. You only do this once.
4. A Terminal window opens. The first time, it asks for your API key: on
   NeonBinder go to **Settings → API Keys**, make one, and paste it in. The
   app remembers it.
5. Type the code from step 1 and press Return. Load cards whenever; it waits
   for paper, and each card shows up on the screen as it feeds.
6. To stop, press **Ctrl-C** or close the window. A card it was partway
   through is reported, so feed it again. Press **Done adding photos** on
   the screen when the run is finished.

Nothing else to install: the app carries its own scanner driver.

Trouble?

- **"No Fujitsu scanner found"**: check it's on and plugged in. Running the
  app from Terminal with `--check` lists the scanners it sees.
- **It keeps asking for the key**: the key was revoked or mistyped; make a
  new one.
- **A different key**: run it with `--forget-key`.

## Developing

Run from source with Node (version in `.nvmrc`) and SANE from Homebrew
(`brew install sane-backends`; `scanimage -L` should list the scanner as
`fujitsu:…`):

```bash
npm ci
npm run scan          # or: npm run scan ABC123 -- --raw
```

Against a PR preview instead of production, put its values in `.env` (copy
`.env.example`): the preview's Convex URL and a key made on that preview.
Without `NEONBINDER_CONVEX_URL` the app asks neonbinder.io where its backend
is, so it never needs rebuilding when the deployment changes.

`npm run build` makes the packaged app (needs [Bun](https://bun.sh) and the
Homebrew SANE): `scripts/bundle-sane.sh` gathers scanimage, the Fujitsu
backend and the libraries they load, and `bun build --compile` embeds that
next to the code. CI builds it for both Mac architectures
(`.github/workflows/scanner-build.yml`) on the oldest macOS runner of each,
because the bundled libraries require at least the macOS they were built on.
main publishes the zips to the `scanner-latest` release, which the Add cards
screen links to.

## Why the settings are what they are

See the comments in `src/scanimage.ts` and `src/tone.ts`: buffer mode stays
off, the double-feed sensors are off for card stock, a loaded stack settles
before the scan, stalls are watchdogged, and scanimage is always stopped with
SIGINT so the scanner is released.
