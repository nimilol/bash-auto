# Changelog

## 3.0.0 — 2026-10-25

A rebuild from scratch. Earlier versions are no longer in the repository.

### Fixed
- **Images that ChatGPT finished were reported as failed.** A reply without its image yet now
  waits as long as anything shows ChatGPT is still working. That covers an open stream, a message in
  progress, an image task with no image yet, and the "Creating image" indicator or a blurred preview
  on the page. "No image" is only decided after every signal has been quiet for the no-image wait
  (3 min) and one last look. Even then, the next attempt looks in the chat first, so a late image is
  collected instead of being requested again.
- **The run didn't continue after a network drop.** A dropped connection now pauses the run on
  "Waiting for network" without using retries. It's detected when the browser goes offline, and also
  when it still says it's online but chatgpt.com can't be reached. When the connection is back, the
  chat is reloaded and the prompt is picked up where it was, not sent again.
- **A reply that died with an error held the queue.** When the reply shows "Something went wrong"
  and nothing is happening, the prompt is sent again in the same chat after 20 s, instead of waiting
  on a message ChatGPT left marked "in progress".
- **Images didn't stay in one chat.** Every prompt of a run, and every retry and recovery, now goes to
  the chat the first prompt opened, unless you choose otherwise.

### Changed
- The run now lives in the background worker. Closing the panel no longer stops it, and a restarted
  worker continues the run.
- Text → Image is the default mode.
- One ChatGPT tab and one prompt at a time. Concurrent tabs are gone, since they can't share one chat.
- Firefox support was dropped. The extension targets Chrome and other Chromium browsers.
- If ChatGPT says a chat is too long, the run pauses with **Continue in a new chat** instead of
  switching chats by itself.
