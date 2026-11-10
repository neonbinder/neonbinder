FROM python:3.12-slim

# BiRefNet model for the tiered crop strategy, run directly through
# onnxruntime (NEO-484; `app/cropper/birefnet.py` transcribes rembg 2.0.78's
# pre/post-processing, and the parity job proves the masks are rembg's).
# ONE-LINE FLIP: "birefnet-general" (full, ~930MB) vs "birefnet-general-lite"
# (~224MB). Runtime reads the same name from the BIREFNET_MODEL env var (set
# below), so the baked model and the loaded model always agree; both sides
# allowlist the name.
# FULL model, non-negotiable: lite cannot find foil cards on the scanner
# belt — the live-corpus replay returned "identity" (no crop) for 81/82 of
# the c2 batch that full cropped 82/82, reproduced locally with the
# benchmark harness. The lite model also has no parity goldens. Memory
# (measured OOM-kill points: full 4601MiB@4Gi, 8326MiB@8Gi with the ORT
# arena; arena now disabled) requires the heavy service shape,
# terraform-managed.
ARG BIREFNET_MODEL=birefnet-general

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    HF_HOME=/opt/hf-cache \
    TRANSFORMERS_CACHE=/opt/hf-cache \
    HF_HUB_DISABLE_PROGRESS_BARS=1 \
    BIREFNET_HOME=/opt/birefnet \
    BIREFNET_MODEL=${BIREFNET_MODEL} \
    REQUIRE_BAKED_WEIGHTS=1
# REQUIRE_BAKED_WEIGHTS: the heavy role's startup fails loudly if the baked
# model is gone. Nothing at runtime can download one (there is no rembg or
# pooch in the image), so a missing model is a broken image. ORT intra-op
# threads are pinned to 4 in code (`birefnet.INTRA_OP_NUM_THREADS`, NEO-484):
# gen2 reports 5-6 CPUs against the 4-vCPU quota, and 4 measured bit-identical
# masks and 14-15% faster inference than the default. (A cap of 1 thread, tried
# earlier, pushed a single BiRefNet pass past the smoke timeout.)

WORKDIR /app

# System libs that opencv-python-headless needs at runtime (libgl etc.).
# kept lean — headless build skips Qt and GTK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# The runtime user exists before anything is copied, so the app is copied
# owned by it (COPY --chown below) instead of a trailing `chown -R` that
# would duplicate every file into another layer.
RUN useradd --create-home --shell /bin/bash appuser

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# The service imports these SDKs on first use, not at boot (NEO-484 C6,
# `app/prewarm.py`), so a boot no longer proves they import. Prove it here
# instead: an SDK that installs but cannot import fails the build.
RUN python -c "import anthropic, google.cloud.storage, google.cloud.vision"

# Pre-download the SAM model (~375MB weights + processor config) into the
# image at build time. Baking it in trades image size for deterministic
# cold starts — first request doesn't wait on HuggingFace network I/O.
# The cache is made read-only in the same RUN, so no writable copy of the
# weights is ever a layer: if they go missing, a runtime re-download fails.
RUN python -c "\
from transformers import SamModel, SamProcessor; \
SamProcessor.from_pretrained('facebook/sam-vit-base'); \
SamModel.from_pretrained('facebook/sam-vit-base'); \
print('SAM model cached to', '$HF_HOME')" \
    && chmod -R a+rX-w /opt/hf-cache

# Bake the BiRefNet model: download rembg 2.0.78's original, verify its md5
# and our pinned sha256, save it pre-optimised at ORT_ENABLE_EXTENDED (never
# ALL: that bakes this build host's CPU kernels in), and fail the build unless
# the optimised model's raw output is byte-equal to the original's. Writes
# `<model>.onnx`, `<model>.onnx.sha256` (the B mask-cache key) and
# `<model>.onnx.provenance.json` (`birefnet.get_session` refuses a model baked
# by another onnxruntime). NOTE: this is NOT a rarely-hit fallback — tiered
# runs BiRefNet on virtually every image that reaches the heavy service.
# The model name reaches the script through the environment, never shell-
# interpolated into source, and the script allowlists it.
COPY scripts/bake_birefnet.py /tmp/bake_birefnet.py
RUN python /tmp/bake_birefnet.py \
    && rm /tmp/bake_birefnet.py \
    && chmod -R a+rX-w "$BIREFNET_HOME"

COPY --chown=appuser:appuser app ./app

# Compile app/ to bytecode now, as root, so a cold start loads .pyc files
# instead of compiling ~30 modules (PYTHONDONTWRITEBYTECODE only stops writes
# at runtime; compileall still writes here). The __pycache__ directories are
# root-owned and made read-only in the same RUN, like the model directories.
RUN python -m compileall -q app \
    && find app -type d -name __pycache__ -exec chmod -R a+rX-w {} +

USER appuser

EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
