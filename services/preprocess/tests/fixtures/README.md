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
