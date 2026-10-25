# bash-auto

Two things live in this repo:

- The **bash-auto Chrome extension** (repo root): queues prompts into one ChatGPT chat and saves the generated images. See README.md for how it works.
- **HyperFrames video projects** under `videos/`: animated videos written in HTML and rendered to MP4.

## The extension

- Plain JavaScript, Manifest V3, no build step. Load the repo folder with "Load unpacked".
- Tests: `npm test` (unit), `npm run check` (static), `npm run test:e2e` (the real extension in Playwright Chromium against the fake chatgpt.com in `tests/fake/`). Run all three before pushing a change.
- The rules for "is this image done / still coming / failed" are in `content/decide.js`. Change them there and cover the change in `tests/unit/decide.test.js`.
- Requirements to keep:
  - every prompt of a run goes to one chat unless the user chose otherwise
  - a network drop never uses retries or resends a prompt
  - an image is never failed while any signal says ChatGPT is still working

## Making videos (HyperFrames)

For any request to make, animate, edit or render a video, animation or motion graphic, **start with the `/hyperframes` skill**. It routes to the right workflow (`/motion-graphics`, `/general-video`, …). The skills are committed in `.claude/skills/`.

- New project: `videos/new-video.sh <name> [--resolution portrait|square|landscape]`
- Inside a project (`cd videos/<name>`):
  - `npm run check` (lint + runtime + layout)
  - `npm run render` (writes `renders/<name>_<timestamp>.mp4`)
- `videos/starter` is a working 10 s example.
- The SessionStart hook (`.claude/hooks/session-start.sh`) installs FFmpeg and HyperFrames' Chrome headless shell in cloud sessions.
- `hyperframes-environment-setup.sh` is the same setup for a cloud environment's Setup script, so every repo gets it.

### Network gotcha (cloud sessions)

The cloud network policy blocks public CDNs (`cdn.jsdelivr.net`, `unpkg.com`), so the headless renderer can't load `<script src="https://cdn…">`. Serve libraries from inside the project instead:

1. `npm pack <pkg>@<version>` (npm is reachable).
2. Extract it and copy the dist file into `videos/<name>/assets/vendor/`.

`new-video.sh` already does this for GSAP. Do the same for any other library a skill loads from a CDN (Lottie, Three.js, Anime.js, …).

Skills that pull media from the internet (stock footage, remote fonts, cloud TTS) may also hit blocked hosts. Check `curl -sS "$HTTPS_PROXY/__agentproxy/status"` for denials.
