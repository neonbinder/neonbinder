# High-resolution zip fixture for Add cards (NEO-446)

`bowe-50mp.zip` (4,325,531 bytes): the 2014 Score Dwayne Bowe #315 scans from the
folder above (`03-bowe-front.jpg`, `04-bowe-back.jpg`), upscaled to
6000x8400 = 50.4 MP (over the old 50,000,000 px limit, under the 65,000,000
one), stamped 2400 dpi so the frame measures 2.5 x 3.5 in and the service reads
it as one card without a pixel pass (`scan_meta.is_card_sized_scan`: 200 dpi
floor, square density, 3% size tolerance). Entries are 2.4 MB and 1.9 MB, stored
with `zip -0`, far under the 32 MiB entry cap. Used by
`tests/collection/add-cards-zip-over-50mp-photos-process.spec.ts`.

## The JFIF unit byte must be 1

`sips` writes the density (2400) but leaves the JFIF density UNIT byte at 0
("aspect ratio only"). `_trustworthy_dpi` in
`services/preprocess/app/cropper/scan_meta.py` treats unit 0 as no physical
size at all, so such a photo is not taken as a card by its resolution, goes down
the pixel cascade, can decline and escalates to the heavy service (43-60 s).
`sips -g dpiWidth` reports 2400 either way, so it does not show the defect. The
unit is byte offset 13 of the file (the APP0 segment: `ff d8 ff e0 00 10 'JFIF' 00
01 01 <unit> <x density> <y density>`), and the repair below sets it to 1 (dots
per inch) without touching a pixel.

Regenerate (macOS `sips`, `python3`, `zip`), from
`apps/web/playwright/fixtures/intake/high-res/`:

```sh
sips -z 8400 6000 -s format jpeg -s formatOptions 45 -s dpiWidth 2400 -s dpiHeight 2400 \
  ../03-bowe-front.jpg --out 01-bowe-front.jpg
sips -z 8400 6000 -s format jpeg -s formatOptions 45 -s dpiWidth 2400 -s dpiHeight 2400 \
  ../04-bowe-back.jpg --out 02-bowe-back.jpg
# Repair: JFIF density unit 0 -> 1 (dots per inch). Byte patch, no re-encode.
python3 -I - <<'PY'
for name in ("01-bowe-front.jpg", "02-bowe-back.jpg"):
    data = bytearray(open(name, "rb").read())
    assert data[2:4] == b"\xff\xe0" and data[6:11] == b"JFIF\x00", name
    data[13] = 1
    open(name, "wb").write(data)
PY
zip -0 -X bowe-50mp.zip 01-bowe-front.jpg 02-bowe-back.jpg
rm 01-bowe-front.jpg 02-bowe-back.jpg
```

Check, on the JPEGs before zipping (or after `unzip`), by reading the bytes, not
with `sips`: `xxd -s 13 -l 5 01-bowe-front.jpg` must print `01 09 60 09 60`
(unit 1, x density 0x0960 = 2400, y density 2400); `sips -g pixelWidth -g
pixelHeight` reports 6000 and 8400. The two JPEGs are not committed, only the zip.
