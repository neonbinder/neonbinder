FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    HF_HOME=/opt/hf-cache \
    TRANSFORMERS_CACHE=/opt/hf-cache \
    HF_HUB_DISABLE_PROGRESS_BARS=1

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

COPY app ./app

RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app /opt/hf-cache
USER appuser

EXPOSE 8080

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
