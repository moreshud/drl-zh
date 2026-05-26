# syntax=docker/dockerfile:1.6

# Base image for the runtime stage. Defaults to the GPU-capable CUDA image.
# For fast iteration on slow connections, override with a small CPU-only base
# like `ubuntu:24.04` via `docker compose build --build-arg BASE_IMAGE=...`
# or the BASE_IMAGE env var (see docker-compose.yml).
ARG BASE_IMAGE=nvidia/cuda:12.9.1-runtime-ubuntu24.04

# ---------- Stage 1: build the DRL-ZH AI Companion extension ----------
# Isolated Node toolchain so the final image never carries npm / node_modules.
FROM node:20-bookworm-slim AS extension-builder

WORKDIR /build

# Copy manifests first to maximize Docker layer caching for npm installs.
COPY extension/package.json extension/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# Copy the rest of the extension source, compile TS, prune dev deps, and
# package to .vsix. The pruning step matters: runtime deps (@anthropic-ai/sdk,
# openai, kokoro-js, uuid) MUST ship inside the vsix because the extension
# is not bundled - .vscodeignore no longer excludes node_modules/.
COPY extension/ ./
RUN npm run build && \
    npm prune --omit=dev && \
    npx vsce package -o /build/companion.vsix


# ---------- Stage 2: runtime image ----------
FROM ${BASE_IMAGE}

ARG UID=1000
ARG GID=1000
ARG CODE_SERVER_VERSION=4.116.0
# TORCH_VARIANT selects which pyproject.toml / poetry.lock pair is used:
#   cuda (default) → canonical files at repo root, torch from PyPI (CUDA bundle)
#   cpu            → files under cpu/, torch from pytorch-cpu index (~2 GB smaller)
# Paired with BASE_IMAGE in docker-compose.cpu.yml.
ARG TORCH_VARIANT=cuda

ENV DEBIAN_FRONTEND=noninteractive

# System packages:
#   build-essential, swig  - gymnasium[box2d] builds Box2D from source
#   libgl1, libegl1        - EGL loader for PyOpenGL / MuJoCo headless render
#                            (real GL libs come from the NVIDIA container runtime
#                            via NVIDIA_DRIVER_CAPABILITIES=graphics)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    build-essential \
    swig \
    libgl1 \
    libegl1 \
    ca-certificates \
    curl \
    wget \
    git \
    tar \
    xz-utils \
    sudo && \
    rm -rf /var/lib/apt/lists/*

# Install uv (fast Python installer + venv manager, replacing Miniconda).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Install uv-managed Python under /opt (world-readable) instead of the default
# ~/.local/share/uv/python. Otherwise the venv's `python` symlink points into
# /root/ which is mode 700 and unreadable by the non-root `coder` runtime user.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python

# Create the project venv at /opt/drl-env. uv downloads and pins Python itself,
# so we don't rely on the base image's Python at all.
RUN uv venv --python 3.13 --seed /opt/drl-env

# Put the venv on PATH so `python`, `pip`, `poetry`, etc. resolve to it without
# needing per-layer activation. `~/.local/bin` is where `uv tool install` puts
# its shims (poetry lives there, isolated from the project venv).
ENV VIRTUAL_ENV=/opt/drl-env
ENV PATH="/root/.local/bin:/opt/drl-env/bin:${PATH}"

# Poetry installs into the active venv (no nested envs) and never prompts.
ENV POETRY_VIRTUALENVS_CREATE=false \
    POETRY_NO_INTERACTION=1

WORKDIR /app

# Copy both variant's dependency manifests. TORCH_VARIANT picks which pair
# is actually consumed by poetry; the other pair sits unused in the layer.
# (Negligible size impact, and keeps the Dockerfile branch-free above the RUN.)
COPY poetry.lock pyproject.toml ./
COPY cpu/pyproject.toml cpu/poetry.lock ./cpu/

# Install Poetry in its own isolated environment via `uv tool install`, so its
# transitive deps never clash with the locked project deps (avoids the slow
# downgrade phase that happens when poetry's deps are installed into the same
# venv first). Then `poetry install --no-root` populates /opt/drl-env straight
# from the selected lockfile. `poetry -C cpu` tells poetry to read metadata
# from cpu/ instead of the current dir; the install target is still the
# VIRTUAL_ENV we created earlier, regardless of which project dir poetry reads.
# POETRY_INSTALLER_MAX_WORKERS caps parallelism to prevent the occasional
# deadlock in the parallel installer; -vv gives visible progress so a hang is
# diagnosable instead of mysterious. BuildKit cache mounts preserve downloaded
# wheels across retries (poetry/PyPI are flaky for heavy wheels like torch -
# we do not want to re-download on every retry).
RUN --mount=type=cache,target=/root/.cache/pypoetry \
    --mount=type=cache,target=/root/.cache/pip \
    --mount=type=cache,target=/root/.cache/uv \
    uv tool install poetry && \
    if [ "${TORCH_VARIANT}" = "cpu" ]; then \
        POETRY_INSTALLER_MAX_WORKERS=4 poetry -C cpu install --no-root -vv; \
    else \
        POETRY_INSTALLER_MAX_WORKERS=4 poetry install --no-root -vv; \
    fi

# Register the kernel so VS Code Jupyter sees it as "Python (drl-zh)".
RUN python -m ipykernel install --prefix=/usr/local \
    --name "drl-zh-env" --display-name "Python (drl-zh)"

# Runtime env for rendering + GPU graphics + matplotlib cache location.
ENV MPLCONFIGDIR="/home/coder/.cache/matplotlib" \
    MUJOCO_GL=egl \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=graphics,utility,compute

# Install code-server.
RUN curl -fL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz" \
    | tar -C /usr/local/lib -xz && \
    ln -s "/usr/local/lib/code-server-${CODE_SERVER_VERSION}-linux-amd64/bin/code-server" \
    /usr/local/bin/code-server

# Create the non-root `coder` user. Ubuntu 24.04 ships a default `ubuntu:1000`
# account that collides with UID/GID 1000 - remove it first.
RUN (userdel -r ubuntu 2>/dev/null || true) && \
    (groupdel ubuntu 2>/dev/null || true) && \
    groupadd -g ${GID} coder && \
    useradd -m -s /bin/bash -u ${UID} -g ${GID} coder && \
    usermod -aG sudo coder && \
    echo 'coder ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Seed code-server's user config and point it at the project interpreter.
RUN mkdir -p /home/coder/.local/share/code-server/User /home/coder/.cache && \
    printf '{\n  "python.defaultInterpreterPath": "/opt/drl-env/bin/python"\n}\n' \
    > /home/coder/.local/share/code-server/User/settings.json && \
    chown -R ${UID}:${GID} /home/coder/.local /home/coder/.cache

USER coder

# Pre-install VS Code extensions so first launch is ready to go:
#   ms-python.python          - Python language support
#   ms-toolsai.jupyter        - notebook UI + kernel picker (owns .ipynb editing)
#   ms-python.black-formatter - formatter matching pyproject.toml
#   bierner.markdown-mermaid  - Mermaid rendering in Markdown preview & notebooks
# Extensions are pulled from open-vsx (code-server's default marketplace).
RUN code-server --install-extension ms-python.python && \
    code-server --install-extension ms-toolsai.jupyter && \
    code-server --install-extension ms-python.black-formatter && \
    code-server --install-extension bierner.markdown-mermaid

# Install the DRL-ZH AI Companion built in stage 1.
COPY --from=extension-builder --chown=${UID}:${GID} \
    /build/companion.vsix /tmp/companion.vsix
RUN code-server --install-extension /tmp/companion.vsix && \
    rm /tmp/companion.vsix

WORKDIR /home/coder/project

EXPOSE 8080

ENTRYPOINT ["code-server", "--auth", "none", "--bind-addr", "0.0.0.0:8080", "."]
