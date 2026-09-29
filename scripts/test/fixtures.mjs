// Builds realistic-shaped `gcloud run services describe` / `gcloud run
// revisions list --format=json` fixtures for testing
// cleanup-cloudrun-revisions.sh and check-revision-images.sh.
//
// NEO-309: dev's real revision-list JSON has been measured at 407KB
// (neonbinder-preprocess) and 143KB (browser) — far past Linux's per-string
// execve() limit (MAX_ARG_STRLEN, ~128KiB) that both scripts used to blow
// past by handing that JSON to python3 through an environment variable. A
// single revision's real JSON carries far more than the shape below (full
// status.conditions history, complete label/annotation sets, etc.); `padBytes`
// stands in for that verbosity so a realistic-size revision list can be
// produced without hand-writing every field GCP actually returns.
export function buildFixtures({
  project,
  service,
  count,
  servingIndex = 0,
  tagged = {},
  minScale = {},
  padBytes = 3000,
}) {
  const base = Date.parse("2026-09-01T00:00:00Z");
  const digest = (i) => `sha256:${"0".repeat(63)}${i % 10}`;
  const imageRef = (i) =>
    `us-central1-docker.pkg.dev/${project}/${service}-repo/${service}@${digest(i)}`;

  const revisions = [];
  for (let i = 0; i < count; i++) {
    // i === 0 is the newest revision — gcloud returns newest-first, and both
    // scripts depend on (or re-derive) that ordering.
    const name = `${service}-${String(count - i).padStart(5, "0")}-${i.toString(36)}`;
    const creationTimestamp = new Date(base - i * 60_000).toISOString();
    revisions.push({
      metadata: {
        name,
        creationTimestamp,
        annotations: {
          "autoscaling.knative.dev/minScale": String(minScale[i] ?? 0),
          "run.googleapis.com/client-name": "gcloud",
          // Stand-in for the rest of a real revision's metadata verbosity.
          "nb-test-padding": "x".repeat(padBytes),
        },
      },
      spec: {
        containers: [
          {
            image: imageRef(i),
            resources: { limits: { cpu: "1", memory: "512Mi" } },
          },
        ],
      },
      status: {
        imageDigest: imageRef(i),
      },
    });
  }

  const traffic = [
    { revisionName: revisions[servingIndex].metadata.name, percent: 100 },
  ];
  for (const [idxStr, tag] of Object.entries(tagged)) {
    const idx = Number(idxStr);
    traffic.push({ revisionName: revisions[idx].metadata.name, tag, percent: 0 });
  }

  return {
    revisions,
    service: { status: { traffic } },
    servingName: revisions[servingIndex].metadata.name,
    nameAt: (i) => revisions[i].metadata.name,
    imageAt: (i) => imageRef(i),
  };
}
