# NeonBinder Scanner

Feeds cards from a sheet-fed scanner into an **Add cards** run on NeonBinder
(NEO-386). Each card scans both sides at once and goes up front then back; the
screen crops, reads, pairs and matches them like dropped photos, and nothing
saves until you say yes there.

Works with sheet-fed scanners that scan both sides in one pass:

- **Fujitsu / Ricoh fi-series**: tested (on the fi-7160).
- **Canon imageFORMULA** (DR and P models) and **Epson** (ES, DS and
  other models with a feeder): should work, **not tested yet**. The app
  says so when it starts, and asks you to watch the first few cards.

Mac only for now, macOS 15 (Sequoia) or later.

## Using it (no setup beyond the download)

1. On NeonBinder, open **Add cards**, pick the binder or box, and press
   **Use a scanner**. It shows a six-character code and two download links.
2. On the Mac the scanner is plugged into, download the one for that Mac.
   To tell which: Apple menu → About This Mac. If it shows **Chip**, choose
   Apple chip; if it shows **Processor … Intel**, choose Intel chip. Open the
   zip. You get **NeonBinder Scanner**.
3. Double-click **NeonBinder Scanner**. The first time, macOS says it can't
   check the app for malicious software. Open **System Settings → Privacy &
   Security**, scroll down, and press **Open Anyway** next to NeonBinder
   Scanner. You only do this once.
4. A Terminal window opens. The first time, it asks for your API key: on
   NeonBinder go to **Profile → API Keys**, make one, and paste it in. The
   app remembers it. Your clipboard still has the key after that, so go back
   and copy the code again before the next step.
5. Type or paste the code from step 1 (the **Copy code** button copies it)
   and press Return. Load cards whenever; it waits
   for paper, and each card shows up on the screen as it feeds.
6. When the run is finished, press **D** here or **Done adding photos** on the
   screen; either one stops the scanner and finishes the run. Cards already
   scanned still go up first when you press D. Any card that couldn't be sent
   is reported, so put it back in the stack.
7. The app then waits for the next run's code, so you can leave it open and
   go back to step 1 on the screen. To quit, press **Ctrl-C** or close the
   window. That leaves the run open.

Nothing else to install: the app carries its own scanner driver.

Trouble?

- **"No scanner found that this app can drive"**: check the scanner is on
  and its USB cable is plugged into this Mac, then open the app again.
  Network-only (Wi-Fi) connections aren't used; plug it in with USB.
- **To see which scanners the app can find**: open Terminal (Applications →
  Utilities), drag **NeonBinder Scanner** into its window, type a space and
  `--check`, and press Return.
- **It keeps asking for the key**: the key was revoked or mistyped. Make a
  new one under **Profile → API Keys** and paste that.
- **To use a different key**: as above, but type `--forget-key` instead of
  `--check`. It asks for a key again.

## Developing

Run from source with Node (version in `.nvmrc`) and SANE from Homebrew
(`brew install sane-backends`; `scanimage -L` should list the scanner as
`fujitsu:…`, `canon_dr:…`, `epsonds:…` or `epson2:…`):

```bash
npm ci
npm run scan          # or: npm run scan ABC123 -- --raw
```

Against a PR preview instead of production, put its values in `.env` (copy
`.env.example`): the preview's Convex URL and a key made on that preview.
Without `NEONBINDER_CONVEX_URL` the app asks neonbinder.io where its backend
is, so it never needs rebuilding when the deployment changes.

`npm run build` makes the packaged app (needs [Bun](https://bun.sh) and the
Homebrew SANE): `scripts/bundle-sane.sh` gathers scanimage, the four
backends above and the libraries they load, and `bun build --compile` embeds that
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

The Fujitsu settings are fixed and proven. For Canon and Epson the app first
asks the scanner which options it has (`scanimage -A`) and sets only those,
because scanimage refuses an option a model doesn't have and every model
reports a different set: Canon gets its double-feed checks (thickness,
length) turned off and hardware or software crop; Epson gets skew correction
and crop where offered (its SANE backend never turns double-feed detection
on). A scanner with no readable hopper sensor (Epson) is simply tried, and
an empty feeder means a wait before the next try.
