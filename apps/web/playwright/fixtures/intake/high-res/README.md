# High-resolution zip fixture for Add cards (NEO-446)

`bowe-50mp.zip` (about 4.3 MB): the 2014 Score Dwayne Bowe #315 scans from the
folder above (`03-bowe-front.jpg`, `04-bowe-back.jpg`), upscaled to
6000x8400 = 50.4 MP (over the old 50,000,000 px limit, under the 65,000,000
one), stamped 2400 dpi so the frame measures 2.5 x 3.5 in and the service reads
it as one card without a pixel pass (`scan_meta.is_card_sized_scan`: 200 dpi
floor, square density, 3% size tolerance). Entries are 2.4 MB and 1.9 MB, stored
with `zip -0`, far under the 32 MiB entry cap. Used by
`tests/collection/add-cards-zip-over-50mp-photos-process.spec.ts`.

Regenerate (macOS `sips`, `zip`), from `apps/web/playwright/fixtures/intake/high-res/`:

```sh
sips -z 8400 6000 -s format jpeg -s formatOptions 45 -s dpiWidth 2400 -s dpiHeight 2400 \
  ../03-bowe-front.jpg --out 01-bowe-front.jpg
sips -z 8400 6000 -s format jpeg -s formatOptions 45 -s dpiWidth 2400 -s dpiHeight 2400 \
  ../04-bowe-back.jpg --out 02-bowe-back.jpg
zip -0 -X bowe-50mp.zip 01-bowe-front.jpg 02-bowe-back.jpg
rm 01-bowe-front.jpg 02-bowe-back.jpg
```

Check: `sips -g pixelWidth -g pixelHeight -g dpiWidth 01-bowe-front.jpg` reports
6000, 8400, 2400. The two JPEGs are not committed, only the zip.
