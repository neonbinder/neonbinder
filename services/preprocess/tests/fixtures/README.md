# Fixture images

Binary images are stored in GCS — they're 22–26 MB phone-camera shots and
would bloat the git repo. Only the `.yaml` sidecars live in git; the
sidecars declare expected orient + classify outputs per image. See
`tests/integration/_loader.py` for the sidecar schema.

## Bucket

`gs://neonbinder-dev-preprocess-fixtures` — provisioned by the infrastructure
repo, dev project only. All commands below run from `services/preprocess/`.
Access:

- `developer_emails` (from `dev.tfvars`): `roles/storage.objectAdmin`
  (upload + read + delete)
- `preprocess_runtime` SA: `roles/storage.objectViewer`
- `preprocess_deployer` SA: `roles/storage.objectViewer`

Versioning is on; fixture replacements are auditable.

## Fetching images (first run on a new machine)

```bash
gcloud auth application-default login   # one-time per machine
python scripts/fetch_fixtures.py
```

The script reads every `.yaml` sidecar and downloads the matching image
(tries `.jpg`, `.jpeg`, `.png`, `.webp` in that order) if not already
present locally.

Flags:

- `--force` — re-download even when the local image already exists
- `--dry-run` — print what would be fetched without downloading

## Adding a new fixture

1. Drop the new image into `tests/fixtures/` (any of `.jpg`, `.jpeg`,
   `.png`, `.webp`).
2. Run `python scripts/label_fixtures.py --fixture <name>.jpg` to bootstrap
   a sidecar from a real pipeline run.
3. Review the generated sidecar. Loosen `equals:` to `contains:` on
   `player`/`team` where Haiku drift is expected. Delete fields you don't
   want to assert. `card_number` stays exact per project policy.
4. `python scripts/push_fixtures.py --only <name>` to upload the image.
5. `git add tests/fixtures/<name>.yaml && git commit` — only the sidecar is
   tracked.
6. `RUN_INTEGRATION_TESTS=1 pytest tests/integration -v` to confirm the
   sidecar's assertions pass against the deployed pipeline.

## Replacing an existing fixture

Versioning is on, so overwriting is safe — the previous version stays in
the bucket as a non-current copy for up to a year. Workflow:

```bash
# swap the local file
cp /path/to/new/image.jpg tests/fixtures/<name>.jpg
python scripts/push_fixtures.py --only <name>
# regenerate the sidecar if classify results differ
python scripts/label_fixtures.py --fixture <name>.jpg --force
```

## Crop fixtures (NEO-191)

A sidecar that declares a `crop:` block joins the **deployed crop matrix** in
`tests/functional/` — the suite that asserts what the cascade actually did with
a real card, against a real Cloud Run revision.

```yaml
orient:
  rotation_degrees: 90        # optional; asserted by both suites

crop:
  category: pre-cropped-scan / dark border, back   # free text, for readability
  source: scan_metadata                            # expected cropped_source
  identity: true                                   # input returned untouched
  # when identity is false, geometry is asserted instead:
  # aspect: 0.714
  # aspect_tolerance: 0.04
  # min_area_fraction: 0.10
  # max_area_fraction: 0.45
```

`identity: true` is the load-bearing assertion. For an already-tight scan,
returning the upload untouched is the *only* correct answer, so
`cropped_image_b64 is None` is what catches a border shave. `identity: false`
switches to measuring the returned crop, which covers deskewing too — a card
that gets cropped but not straightened fails the aspect check.

Fetch just these (the repo carries older sidecars whose images were never
uploaded, and the script exits non-zero on any absence):

```bash
python scripts/fetch_fixtures.py --crop
```

### Calibrating a new crop fixture

Numbers in a sidecar should come from a measured run, never a guess — a wrong
band is a red gate on somebody else's PR. Point the suite at a deployed
revision and read the values off it:

```bash
export SMOKE_TARGET_URL=https://pr-<N>---<host>          # or the dev service
export SMOKE_INTERNAL_KEY=$(gcloud secrets versions access latest \
  --secret=internal-api-key --project=neonbinder-dev)
export SMOKE_ID_TOKEN=$(gcloud auth print-identity-token \
  --impersonate-service-account=neonbinder-preprocess-runtime@neonbinder-dev.iam.gserviceaccount.com \
  --audiences=https://<base-host>)
pytest tests/functional -v
```

Leave the area band roughly ±50% around the measured fraction. BiRefNet is not
bit-deterministic, and a band tight enough to flake is worse than no band —
but keep it far enough from a border shave (which lands near 0.87 of source on
an already-tight scan) that a regression still falls outside.

### Known gap: no landscape / EXIF-rotated fixture

Every scan and phone photo on hand is portrait with EXIF orientation `1`, so
nothing here exercises a landscape source or the `apply_exif_orientation`
transpose path — including the resolution-swap that path performs for NEO-191.
`scan-dark-textured-front` covers a 270-degree upright rotation, which is the
nearest available substitute. Add a real sideways scan when one exists; the
legacy `landscape.yaml` sidecar records the intent but has no image in the
bucket.
