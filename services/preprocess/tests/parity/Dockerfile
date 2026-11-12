# Images for the NEO-484 mask-parity job (`preprocess-mask-parity` in
# .github/workflows/pr-pipeline.yml). Build context: this directory.
#
#   docker build --build-arg BASE_IMAGE=<pr image>@sha256:... --target check  .
#   docker build --build-arg BASE_IMAGE=<pr image>@sha256:... --target oracle .
#
# BASE_IMAGE is the PR's preprocess image pinned by digest, so both targets
# test exactly the bytes that deploy. Nothing from the repo is copied in: the
# job mounts services/preprocess read-only at /work and runs the tests from
# there, offline, as the base image's own non-root user.
ARG BASE_IMAGE

# check: the shipped image plus pytest. Step A runs here, so it sees the
# image's packages exactly as deployed (rembg must be absent).
FROM ${BASE_IMAGE} AS check
USER root
COPY requirements-check.txt /tmp/parity/
RUN pip install --no-cache-dir --no-deps --require-hashes --only-binary=:all: \
        -r /tmp/parity/requirements-check.txt \
    && pip check \
    && rm -rf /tmp/parity
USER appuser

# oracle: check plus rembg 2.0.78 and the packages the old image carried only
# for it, every one pinned by hash at the version that image ran. Step B
# compares the direct path against it on the same host. numba's JIT is off:
# the oracle never runs alpha matting, so nothing needs compiling, and the
# ~100 s compile is what NEO-484 removed.
FROM check AS oracle
USER root
COPY requirements-oracle.txt /tmp/parity/
RUN pip install --no-cache-dir --no-deps --require-hashes --only-binary=:all: \
        -r /tmp/parity/requirements-oracle.txt \
    && pip check \
    && rm -rf /tmp/parity
ENV NUMBA_DISABLE_JIT=1
USER appuser
