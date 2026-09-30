#!/bin/bash
# Scaffold a new HyperFrames video project in videos/<name> with GSAP served locally.
# Usage: videos/new-video.sh <name> [extra `hyperframes init` flags, e.g. --resolution portrait]
set -euo pipefail

HF_VERSION="0.8.96"
GSAP_VERSION="3.14.2"

name="${1:?usage: videos/new-video.sh <name> [init flags]}"
shift
cd "$(dirname "$0")"

if [ -e "$name" ]; then
  echo "videos/$name already exists" >&2
  exit 1
fi

HYPERFRAMES_SKIP_SKILLS=1 npx --yes "hyperframes@${HF_VERSION}" init "$name" --non-interactive "$@"

# The cloud network policy blocks CDNs (jsdelivr, unpkg), so load GSAP from the project instead.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
npm pack "gsap@${GSAP_VERSION}" --silent --pack-destination "$tmp" >/dev/null
tar -xzf "$tmp/gsap-${GSAP_VERSION}.tgz" -C "$tmp"
mkdir -p "$name/assets/vendor"
cp "$tmp/package/dist/gsap.min.js" "$name/assets/vendor/"
sed -i "s#https://cdn.jsdelivr.net/npm/gsap@[0-9.]*/dist/gsap.min.js#assets/vendor/gsap.min.js#" "$name/index.html"

echo "Created videos/$name — edit index.html, then: cd videos/$name && npm run check && npm run render"
