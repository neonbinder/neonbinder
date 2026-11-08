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

## one-photo-one-too-big.zip (about 720 KB)

One ordinary card photo and one photo over the limit, stored with `zip -0 -X`:
`01-bowe-front.jpg` (the 2014 Score Bowe front from the folder above, JFIF
density stamped 398 dpi so its 996x1388 px measures one card and the service
reads it without the heavy model) and `02-flat-67mp.jpg` (the flat 67 MP photo
from `../over-limit/`). Used by
`tests/collection/add-cards-zip-partly-accepted-explains.spec.ts`; its
assertions do not depend on the photo being read.

```sh
sips -s dpiWidth 398 -s dpiHeight 398 ../03-bowe-front.jpg --out 01-bowe-front.jpg
# sips leaves the JFIF density unit byte (offset 13) at 0, which the service
# ignores; set it to 1 (dots per inch). Check: xxd -s 13 -l 5 01-bowe-front.jpg -> 01 01 8e 01 8e
python3 -I -c "
b = bytearray(open('01-bowe-front.jpg', 'rb').read())
assert b[6:11] == b'JFIF\\x00'
b[13] = 1
open('01-bowe-front.jpg', 'wb').write(b)
"
cp ../over-limit/flat-67mp.jpg 02-flat-67mp.jpg
zip -0 -X one-photo-one-too-big.zip 01-bowe-front.jpg 02-flat-67mp.jpg
rm 01-bowe-front.jpg 02-flat-67mp.jpg
```
