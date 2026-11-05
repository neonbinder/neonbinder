# Zip fixtures for Add cards (NEO-446)

`over-64mp-and-a-note.zip` (about 790 KB): two flat 8200x8200 JPEGs
(67.24 MP, over the 65,000,000 px limit, 395 KB each) and a `notes.txt`, stored
with `zip -0`. Used by `tests/collection/add-cards-zip-all-rejected-explains.spec.ts`:
nothing in it can be used, and the failure is mixed (two photos too big, one
file that is no photo). Every entry is under 1 MiB, the size below which the
service skips its 100:1 expansion guard (`RATIO_CHECK_MIN_BYTES`), and a stored
entry expands 1:1 anyway.

Regenerate from `apps/web/playwright/fixtures/intake/zip/`
(needs `cjpeg` from libjpeg-turbo and `zip`; the working folder is a scratch
folder, not the repo):

```sh
python3 -I -c "
import sys
w = h = 8200
sys.stdout.buffer.write(b'P6\n%d %d\n255\n' % (w, h))
row = bytes([90, 90, 90]) * w
for _ in range(h): sys.stdout.buffer.write(row)
" > flat.ppm
cjpeg -quality 50 -optimize -sample 2x2 flat.ppm > huge-1.jpg
cp huge-1.jpg huge-2.jpg
printf 'Two photos over 64 megapixels and a note. Add cards turns the photos away.\n' > notes.txt
zip -0 -X over-64mp-and-a-note.zip huge-1.jpg huge-2.jpg notes.txt
```

A flat photo is the smallest way to reach 67 MP; macOS `sips` alone cannot
make one under 1 MiB (about one byte per 8x8 block).
