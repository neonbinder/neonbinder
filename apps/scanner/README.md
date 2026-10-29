# NeonBinder scanner

Feeds cards from a sheet-fed scanner into an **Add cards** run on NeonBinder
(NEO-386). Each card scans both sides at once and goes up front then back; the
screen crops, reads, pairs and matches them like dropped photos, and nothing
saves until you say yes there.

Built for Fujitsu fi-series scanners (tested on the fi-7160) through SANE.

## Setup

1. Install SANE: `brew install sane-backends`. `scanimage -L` should list the
   scanner as `fujitsu:…`.
2. `npm ci` here (Node from `.nvmrc`).
3. Copy `.env.example` to `.env` and fill in your API key (NeonBinder →
   Settings → API Keys) and the deployment URL.

## Use

1. On NeonBinder, open **Add cards**, pick the binder or box, and press
   **Use a scanner**. It shows a six-character code.
2. Here: `npm run scan <code>`. Load cards whenever; it waits for paper.
3. Ctrl-C stops after the card in progress. **Done adding photos** on the
   screen closes the run.

`npm run scan <code> -- --raw` turns off the hardware crop and scans the full
frame with a margin, for cards the crop cuts too tight.

## Why the settings are what they are

See the comments in `src/scanimage.ts` and `src/tone.ts`: buffer mode stays
off, the double-feed sensors are off for card stock, a loaded stack settles
before the scan, stalls are watchdogged, and scanimage is always stopped with
SIGINT so the scanner is released.
