# Over-the-limit photo for Add cards (NEO-446)

`flat-67mp.jpg` (395 KB): a flat 8200x8200 JPEG, 67.24 MP, over the 65,000,000 px
limit on the old 50 MP and the new 65 MP preprocess service alike. Used loose by
`tests/collection/add-cards-photo-over-limit-says-too-big.spec.ts`, and inside
`../zip/one-photo-one-too-big.zip`. Generation (needs `cjpeg`, libjpeg-turbo):

```sh
python3 -I -c "
import sys
w = h = 8200
sys.stdout.buffer.write(b'P6\n%d %d\n255\n' % (w, h))
row = bytes([90, 90, 90]) * w
for _ in range(h): sys.stdout.buffer.write(row)
" > flat.ppm
cjpeg -quality 50 -optimize -sample 2x2 flat.ppm > flat-67mp.jpg
rm flat.ppm
```
