# Changelog

## 1.1.1 — 2026-10-09

### Fixed
- **Slow images were sent twice.** The wait for an image was a fixed 4 minutes, separate from
  **Timeout per prompt**. When it ran out, the prompt was sent again even if ChatGPT was still
  drawing, leaving duplicates in the chat. The extension now waits up to the prompt's timeout. If
  ChatGPT is still working when time runs out, the next attempt picks the image up instead of
  resending.
- **ChatGPT asking a question instead of drawing failed the prompt.** Replies like "Would you like
  it in landscape?" now get one follow-up in the same chat ("Yes, please generate the image now,
  exactly as described."), and the image is collected from that.
- **Image → Image and Ingredients prompts could hang for 2 minutes, then fail.** Any spinner or
  progress ring anywhere on the page was taken for an upload in progress. Only the prompt box
  area is checked now.
- **A generated image could fail to save.** Images served from another domain couldn't be read
  by the page, so the whole prompt failed. The image is now read without cookies when it's on
  another domain, and if the page still can't read it, the browser's download manager saves it
  from its address.
- **Clear queue could do nothing in the side panel**, where browser confirmation dialogs don't
  reliably show. It now asks for a second click ("Click again to clear") instead.

## 1.1.0 — 2026-10-08

### Fixed
- **The queue stopped after the first prompt.** ChatGPT's September 2026 redesign removed the
  markers the extension relied on: the `send-button` test id, `#prompt-textarea`, and the
  `data-message-author-role` attribute on replies. Stop also lost its English label in other languages.
  The first prompt was sent, but its reply was never recognized as finished. The run waited
  until the 10-minute timeout and then sent the first prompt again. The driver now:
  - recognizes Send and Stop by test id, by label in about 30 languages, by icon, or by button type,
    and never clicks Stop as Send
  - finds replies by their position after the sent prompt, so role markers are optional
  - decides a reply is finished from several signals (Stop gone, content stable, action bar
    shown), not from one selector
  - confirms each prompt was actually sent before waiting, and falls back to Enter if the
    button didn't respond
- A reply that was sent but not collected (timeout, stall, tab reloaded) is picked up on the
  next attempt instead of being sent again. A ChatGPT error still sends the prompt again.
- A reply that stops making progress is reported after 3 minutes instead of waiting for the full
  timeout.

### Added
- Firefox (128+) support. The panel opens in Firefox's sidebar, and the extension asks for
  chatgpt.com access when needed.
- Browsers without a side panel (Opera, Arc…) open the panel in its own window. Every browser
  also offers **Open in a separate window** on the toolbar button's right-click menu.
- **Keep the ChatGPT tab in front while running** (on by default). Before each prompt the tab
  is brought to the front of its window, and the browser can't discard it while the queue runs.
  A warning appears if the tab is hidden.
- The Activity log shows each stage (sent, waiting for the image…) and a page check after any
  failure.
- **Copy diagnostics** copies a report of what the extension sees on the ChatGPT page.
- Only one panel can run the queue at a time.
- `npm run build` creates `dist/chromium` and `dist/firefox` packages, with zips.

### Changed
- Downloads are saved from `blob:` URLs, which work in every browser, instead of `data:` URLs.
- End-to-end tests run against both the original and the 2026 ChatGPT layouts.

## 1.0.0
- First release: batch text and image generation, one session chat, auto-resume, refusal skip,
  auto download, six UI languages.
