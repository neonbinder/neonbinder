---
name: preprocess-port-8080-red-is-a-startup-hook-raise
description: Preprocess preview "failed to start and listen on PORT=8080" after a pin bump = the HEAVY startup hook raised; unit tests fake the model-cache layout so only the deploy catches it
metadata:
  type: project
---

A preprocess per-PR preview that dies with "container failed to start and listen on the port defined by PORT=8080" while unit tests are green usually means `_verify_baked_weights` (app/main.py startup hook, HEAVY role only) raised, not a slow boot. Its unit tests write a stub `.onnx` into a tmp dir, so they never see the real baked layout. NEO-468 (rembg 2.0.78 -> 2.0.86): rembg moved its cache from `U2NET_HOME/<model>.onnx` to `U2NET_HOME/models/<model>/<model>.onnx`, and the hook's non-recursive glob found nothing.

**Why:** the image bakes weights at build time and the hook checks for them by path, so any third-party cache-layout change passes build and unit tests and fails only at container start.

**How to apply:** in a deps batch touching rembg/transformers/huggingface-hub, grep the build log for "Downloading data ... to file" and compare the path with what the startup check globs. With gcloud auth expired, that build-log line plus the two rembg wheels' `sessions/base.py` is enough to diagnose.
