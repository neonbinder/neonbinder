---
name: bundler-plugin-disable-drops-cleanup
description: Gating a bundler plugin with its `disable` option also drops its cleanup, so tie the build output to the same gate
metadata:
  type: reference
---

Gating a bundler plugin (for example the Sentry Vite plugin) with `disable` turns off ALL of it, including cleanup such as `filesToDeleteAfterUpload`. If the build still emits what the plugin used to upload and delete (`build.sourcemap: true`), a gate miss on a hosted build ships public `.map` files with a green build.

**How to apply:** tie the output setting to the same gate (`build.sourcemap: uploadToSentry`) and test the config wiring, not just the predicate.

`vercel build` run locally also sets a real `VERCEL=1`, so that variable separates laptops from hosted builds only while the CLI refuses local builds. Snapshot the real process env before any `.env*` merge so a file can never flip the gate.
