#!/bin/bash
# Installs what HyperFrames needs to preview and render videos in Claude Code on the web.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

HF_VERSION="0.8.96"

# FFmpeg / FFprobe (encoding + media probing)
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  # Some third-party apt sources may be blocked by the network policy; ignore those failures.
  apt-get update -qq >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null
fi

# HyperFrames CLI (warm the npx cache) + its Chrome headless shell for rendering
npx --yes "hyperframes@${HF_VERSION}" --version >/dev/null
npx --yes "hyperframes@${HF_VERSION}" browser ensure >/dev/null

# Skills are committed under .claude/skills; don't let init/render re-sync them into ~/.claude.
echo 'export HYPERFRAMES_SKIP_SKILLS=1' >> "${CLAUDE_ENV_FILE:-/dev/null}"
