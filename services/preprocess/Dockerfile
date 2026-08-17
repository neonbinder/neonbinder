FROM python:3.12-slim

# BiRefNet model for the tiered crop strategy (via rembg). ONE-LINE FLIP:
# set to "birefnet-general-lite" for a smaller/faster image. Runtime reads
# the same name from the REMBG_MODEL env var (set below), so the baked
# weights and the loaded model always agree.
ARG REMBG_MODEL=birefnet-general

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    HF_HOME=/opt/hf-cache \
    TRANSFORMERS_CACHE=/opt/hf-cache \
    HF_HUB_DISABLE_PROGRESS_BARS=1 \
    U2NET_HOME=/opt/u2net-cache \
    REMBG_MODEL=${REMBG_MODEL} \
    REQUIRE_BAKED_WEIGHTS=1 \
    OMP_NUM_THREADS=1
# REQUIRE_BAKED_WEIGHTS: startup fails loudly if the baked weights are gone,
# instead of rembg silently re-downloading ~930MB into Cloud Run's in-memory
# filesystem. OMP_NUM_THREADS=1: ORT would otherwise claim all 4 vCPU per
# inference under concurrency 3 (torch already does set_num_threads(1)).

WORKDIR /app

# System libs that opencv-python-headless needs at runtime (libgl etc.).
# kept lean — headless build skips Qt and GTK.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the SAM model (~375MB weights + processor config) into the
# image at build time. Baking it in trades image size for deterministic
# cold starts — first request doesn't wait on HuggingFace network I/O.
RUN python -c "\
from transformers import SamModel, SamProcessor; \
SamProcessor.from_pretrained('facebook/sam-vit-base'); \
SamModel.from_pretrained('facebook/sam-vit-base'); \
print('SAM model cached to', '$HF_HOME')"

# Pre-download the BiRefNet weights the same way — rembg downloads into
# U2NET_HOME when the session is first created, so creating one here bakes
# the weights and the first request never touches the network. NOTE: this is
# NOT a rarely-hit fallback — tiered runs BiRefNet on virtually every image
# (as fallback when classical fails, as verification when it passes).
# ~930MB for the full model; see the ARG above for the lite flip.
# The model name is read from the environment inside python — never shell-
# interpolated into the source (a crafted --build-arg would otherwise be
# build-time code injection).
RUN python -c "\
import os; \
from rembg import new_session; \
new_session(os.environ['REMBG_MODEL']); \
print('BiRefNet model', os.environ['REMBG_MODEL'], 'cached to', os.environ['U2NET_HOME'])"

COPY app ./app

# appuser owns only /app. The model caches stay root-owned and read-only:
# if the weights ever go missing/corrupt, a runtime re-download must FAIL
# (see REQUIRE_BAKED_WEIGHTS above), not silently succeed.
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app \
    && chmod -R a+rX-w /opt/hf-cache /opt/u2net-cache
USER appuser

EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
