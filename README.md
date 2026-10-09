# ChatGPT Automation (bash-auto)

**Auto ChatGPT for your prompts at scale.** Batch generate and auto-download responses and images on [chatgpt.com](https://chatgpt.com).

A browser extension (Manifest V3, for Chrome, Edge, Brave, Opera, Vivaldi, Arc and Firefox). Queue dozens or hundreds of prompts in its side panel. It sends each one to ChatGPT, waits for the reply to finish, saves the result, and moves on to the next prompt.

Version 2 is a rebuild that follows the [ChatGPT Automation user guide](https://github.com/trgkyle/chatgpt-automation-user-guide). The Workflow editor from that guide is not built yet.

<p align="center"><img src="docs/screenshot-panel.png" alt="Side panel" width="340" /></p>

## Features

- **Batch processing**: queue any number of prompts. They run one after another, or several at once with **Concurrent Prompts**.
- **Four modes**
  - **Text Processing**: a text reply for every prompt.
  - **Ingredients to Text**: your images or components are sent with each prompt, and the text replies are collected.
  - **Text to Image**: images from text descriptions, with an optional aspect ratio.
  - **Image to Image**: each prompt is sent with your source images to transform them.
- **Auto-add character images**: name your files after characters (`hero.png`, `villain.jpg`). Each prompt gets the images whose names it mentions.
- **Prompt options**
  - *New Chat* or *Concat*: Concat continues the next prompt in the same chat.
  - *New Image* or *Last Image*: Last Image uses the previous prompt's generated image as this prompt's input.
  - Set the defaults in Settings, or click a prompt's tag in the queue to switch it.
- **Smart delays**: a random wait between prompts, to stay clear of rate limits.
- **Auto download**: text is saved as `.md` or `.txt`, images as files. They go to `Downloads/<Save to Folder>/001-<prompt>.png`. **Auto Change File Name** names the files after the prompt.
- **Queue and progress**: a status bar and a list of every prompt, showing what it's doing now (*Sending → Replying → Drawing image → Completed*), with a link to its chat.
- **Retries and recovery**
  - Failed prompts are retried up to **Max Retries**.
  - A prompt that ChatGPT refuses is retried once, then skipped.
  - When ChatGPT asks a question instead of drawing, the extension asks it once to generate the image.
  - A prompt that already reached the chat is never sent twice.
- **Fix Error**: one click stops ChatGPT, closes dialogs, reloads the chat, and runs the stuck prompt again.
- **Background mode**: shares the chatgpt.com tab so the browser keeps it running behind other windows. Nothing is recorded or sent anywhere.
- **Six languages**: English, Tiếng Việt, 中文, 한국어, 日本語, Español.

## How it knows a reply is finished

Earlier versions guessed from the page's markup: a Stop button, CSS classes, image addresses. When ChatGPT redesigned its page, those guesses broke, and the queue stalled after the first prompt. Version 2 doesn't depend on the markup for this.

1. A small script in the chatgpt.com page (`content/net-hook.js`) watches the request ChatGPT makes when a prompt is sent. The reply is done when the reply stream closes.
2. The extension then reads the conversation from ChatGPT's own backend (`/backend-api/conversation/<id>`), using your logged-in session. From it, it checks that the reply to *this* prompt is final, takes the text, and downloads the generated images. If an image is still being drawn after the stream closed, it waits for it.
3. The panel asks the ChatGPT tab how the prompt is going every 1.5 seconds. It doesn't rely on the page's own timers, which browsers slow down in background tabs. If the tab is reloaded or closed mid-reply, the panel notices within seconds. It goes back to that chat and collects the reply without sending the prompt again.
4. If the conversation can't be read (for example, if ChatGPT changes its backend), the extension falls back to watching the page. The Activity log says which way each prompt finished: *(network)* or *(page)*.

The page is still used to type and send prompts, as a person would. Its selectors and button labels (in about 30 languages) live in [`content/selectors.js`](content/selectors.js).

## Install

### Chrome, Edge, Brave, Opera, Vivaldi, Arc
1. Download or clone this repository. Or use `dist/chromium/` or its zip (`npm run build` creates both).
2. Open the extensions page: `chrome://extensions`, `edge://extensions`, `brave://extensions`, `opera://extensions` or `vivaldi:extensions`.
3. Turn on **Developer mode**, click **Load unpacked**, and select the folder that contains `manifest.json`.
4. **Updating from 1.x:** click the reload icon on the extension card, then **reload any open chatgpt.com tabs** once.
5. Pin the extension and click its icon to open the panel.

### Firefox (128+)
1. Run `npm run build` and use `dist/firefox/`.
2. For a quick try: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and pick `dist/firefox/manifest.json`.
3. For a permanent install, the zip has to be signed by Mozilla. Upload `dist/bash-auto-firefox-<version>.zip` at [addons.mozilla.org](https://addons.mozilla.org/developers/) as an *unlisted* add-on, then install the signed `.xpi`.
4. Allow access to chatgpt.com when asked on the first **Run**.

## User guide

1. Log in to [chatgpt.com](https://chatgpt.com) in a tab, then open the panel from the toolbar button.
2. **Control** tab: pick a mode. Enter prompts with a blank line between them, or **upload a .txt file**. Upload images if the mode uses them.
3. Set **Concurrent Prompts**, **Prompt Delay**, **Save to Folder** and **Auto Change File Name**.
4. Click **Run**. Keep the panel open while it runs. If it closes, **Run** continues where it stopped.

### Settings

| Setting | What it does |
| :--- | :--- |
| Language | Panel language |
| Default Mode | The mode the panel opens with |
| Outputs per Prompt (Text / Image) | Runs each prompt 1–4 times (text) or 1–50 times (image); files get `-v2`, `-v3`… |
| Concurrent Prompts | 1–6 prompts at once, each in its own chatgpt.com tab (Concat / Last Image prompts always run one at a time) |
| Random Delay | Random wait (min–max seconds) between prompts |
| Text Model / Image Model | Empty keeps ChatGPT's current model. Otherwise a model id as used in `chatgpt.com/?model=…`, e.g. `gpt-5` |
| Default Prompt Mode Option | New Chat or Concat |
| Default Image Mode Option | New Image or Last Image |
| Max Input Images per Prompt | Ingredients 1–3, Image to Image 1–10 |
| Max Retries on Failure | 1–20 |
| Timeout per Prompt | Minutes to wait for one reply |
| Auto Download (Text) / Quality (Image) | No Download, Markdown or plain text / No Download or the original image |
| Keep the ChatGPT tab in front | With one prompt at a time, brings the tab to the front before each prompt |

## Troubleshooting

| Problem | What to do |
| :--- | :--- |
| A prompt stays on *Running* | Look at the Activity log. While a prompt runs, a *page check* line every minute says what it's waiting on: whether the page hook is loaded (`hook ✓`), whether the reply stream is open or closed, and whether the conversation shows the reply as final. Click **Fix Error** to recover, and **Copy diagnostics** for a bug report (it has no prompt or reply text). |
| `hook ✗` in the log | Reload the chatgpt.com tab once, for example after installing or updating the extension. |
| Prompts stall while you use other windows | Click **Enable background mode** and pick the chatgpt.com tab, or keep that tab visible. |
| "ChatGPT page is not ready" | Log in to chatgpt.com in that tab, and make sure no dialog covers the prompt box. |
| Downloads ask where to save | Turn off "Ask where to save each file before downloading" in the browser's settings. |
| Firefox: nothing happens on Run | Allow access to chatgpt.com, under *about:addons → ChatGPT Automation → Permissions*. |

## Project structure

```
manifest.json          MV3 manifest for Chromium browsers (Firefox's is generated by the build)
background.js          Opens the panel: side panel, Firefox sidebar, or a separate window
content/
  sse.js               Reads ChatGPT's reply stream (page world)
  net-hook.js          Watches the prompt requests, reads conversations and images (page world)
  conversation.js      Is the reply final? Its text and images, from the conversation JSON
  agent.js             Types and sends prompts, follows each one until done, page fallback
  selectors.js         chatgpt.com selectors, button labels, error/refusal phrases
sidepanel/
  index.html, panel.css, app.js   Control and Setting tabs
  engine.js            Queue engine: concurrent tabs, polling, retries, delays, downloads
  modes.js             What each mode sends (images, aspect ratio, Last Image)
  i18n.js              Runtime language switching
lib/                   Pure helpers, browser API namespace
scripts/build.mjs      Packages dist/chromium and dist/firefox (+ zips)
_locales/<lang>/       Translations
tests/                 Unit tests, static checks, Playwright end-to-end tests with a fake ChatGPT
```

## Development

```bash
npm test            # unit tests: stream parser, conversation reader, helpers, modes
npm run check       # manifest/locale validation, missing translation keys
npm run test:e2e    # Playwright: the content scripts and the real extension against a fake chatgpt.com
npm run build       # dist/chromium, dist/firefox and their .zip files
```

`test:e2e` needs Playwright with Chromium, or `CHROMIUM_PATH` set to a Chromium binary.

## Disclaimer

This project is not affiliated with or endorsed by OpenAI. Automating chatgpt.com may be subject to OpenAI's Terms of Use and usage limits. Use reasonable delays and respect your plan's limits.
