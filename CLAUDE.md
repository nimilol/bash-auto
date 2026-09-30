# bash-auto

Two things live in this repo:

- The **ChatGPT Automation** Chrome extension (repo root). Tests: `npm test`, `npm run check`.
- **HyperFrames video projects** under `videos/`: animated videos written in HTML and rendered to MP4.

## Making videos (HyperFrames)

For any request to make, animate, edit or render a video, animation or motion graphic, **start with the `/hyperframes` skill**. It routes to the right workflow (`/motion-graphics`, `/general-video`, …). The skills are committed in `.claude/skills/`.

- New project: `videos/new-video.sh <name> [--resolution portrait|square|landscape]`
- Inside a project (`cd videos/<name>`): `npm run check` (lint + runtime + layout), `npm run render` (writes `renders/<name>_<timestamp>.mp4`)
- `videos/starter` is a working 10s example.
- The SessionStart hook (`.claude/hooks/session-start.sh`) installs FFmpeg and HyperFrames' Chrome headless shell in cloud sessions.

### Network gotcha (cloud sessions)

The cloud network policy blocks public CDNs (`cdn.jsdelivr.net`, `unpkg.com`), so the headless renderer can't load `<script src="https://cdn…">`. Serve libraries from inside the project instead: `npm pack <pkg>@<version>`, extract it, and copy the dist file into `videos/<name>/assets/vendor/` (npm is reachable). `new-video.sh` already does this for GSAP. Do the same for any other library a skill loads from a CDN (Lottie, Three.js, Anime.js, …).

Skills that pull media from the internet (stock footage, remote fonts, cloud TTS) may also hit blocked hosts. Check `curl -sS http://127.0.0.1:37799/__agentproxy/status` for denials.
