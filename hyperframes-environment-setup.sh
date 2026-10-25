#!/bin/bash
# HyperFrames for every repo: paste this into the cloud environment's Setup script.
# Installs FFmpeg, HyperFrames' Chrome headless shell, the HyperFrames skills (user-level,
# so every repo sees them), an `hf-new` project helper, and global notes for Claude.
# Every step is allowed to fail: a setup script that exits non-zero stops sessions from starting.
set -uo pipefail

# 1. FFmpeg / FFprobe
if ! command -v ffmpeg >/dev/null 2>&1; then
  apt-get update -qq >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null || true
fi

# 2. HyperFrames CLI + Chrome headless shell for rendering
npx --yes hyperframes@latest browser ensure >/dev/null 2>&1 || true

# 3. Skills into ~/.claude/skills: core set + the two main animation workflows
#    (other workflows install on demand when /hyperframes routes to them).
#    A lock file left without the skill folders makes `update` skip the install.
[ -f ~/.claude/skills/hyperframes/SKILL.md ] || rm -f ~/.agents/.skill-lock.json
(cd /tmp && npx --yes hyperframes@latest skills update motion-graphics general-video >/dev/null 2>&1) || true

# 4. `hf-new <name> [init flags]`: new project with GSAP served locally (CDNs are blocked)
cat > /usr/local/bin/hf-new <<'EOF'
#!/bin/bash
set -euo pipefail
name="${1:?usage: hf-new <name> [hyperframes init flags, e.g. --resolution portrait]}"
shift
[ -e "$name" ] && { echo "$name already exists" >&2; exit 1; }
HYPERFRAMES_SKIP_SKILLS=1 npx --yes hyperframes@latest init "$name" --non-interactive "$@"
gsap_url="$(grep -o 'https://cdn.jsdelivr.net/npm/gsap@[0-9.]*/dist/gsap.min.js' "$name/index.html" || true)"
if [ -n "$gsap_url" ]; then
  ver="$(echo "$gsap_url" | sed 's#.*gsap@\([0-9.]*\)/.*#\1#')"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  npm pack "gsap@$ver" --silent --pack-destination "$tmp" >/dev/null
  tar -xzf "$tmp/gsap-$ver.tgz" -C "$tmp"
  mkdir -p "$name/assets/vendor"
  cp "$tmp/package/dist/gsap.min.js" "$name/assets/vendor/"
  sed -i "s#$gsap_url#assets/vendor/gsap.min.js#" "$name/index.html"
fi
grep -qs '^renders/' "$name/.gitignore" || echo 'renders/' >> "$name/.gitignore"
echo "Created $name. Edit index.html, then: cd $name && npm run check && npm run render"
EOF
chmod +x /usr/local/bin/hf-new

# 5. Global instructions for Claude in every repo
mkdir -p ~/.claude
touch ~/.claude/CLAUDE.md
if ! grep -q 'BEGIN hyperframes' ~/.claude/CLAUDE.md; then
  cat >> ~/.claude/CLAUDE.md <<'EOF'
<!-- BEGIN hyperframes -->
## Making videos (HyperFrames), in any repo

HyperFrames is installed: FFmpeg, its Chrome headless shell, and its skills in ~/.claude/skills.
For any request to make, animate, edit or render a video, animation or motion graphic, start
with the `/hyperframes` skill.

- New project: `hf-new <name> [--resolution portrait|square|landscape]` (put it under `videos/`
  unless the repo already has a place for it)
- In the project: `npm run check`, then `npm run render` (writes `renders/*.mp4`, gitignored)
- The network policy may block public CDNs (cdn.jsdelivr.net, unpkg.com), so the renderer can't
  load `<script src="https://cdn...">`. `hf-new` already serves GSAP locally. For any other
  library, `npm pack <pkg>@<ver>` and copy its dist file into `assets/vendor/`.
  Check `curl -sS "$HTTPS_PROXY/__agentproxy/status"` for blocked hosts.
<!-- END hyperframes -->
EOF
fi

exit 0
