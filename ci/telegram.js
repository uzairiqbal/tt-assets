'use strict';
/*
 * Shared Telegram helpers.
 *
 * Pulled out so the photo path and the video path talk to Telegram the same
 * way. run.js still has its own copies for now — they are identical, and it is
 * the path that already works and posts live, so it gets switched over in a
 * separate change rather than in the same one that introduces video.
 */
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeTelegram(botToken) {
  const TG = `https://api.telegram.org/bot${botToken}`;

  // GitHub runners intermittently cannot reach Telegram (ETIMEDOUT). Retry with
  // backoff so one network blip does not throw away a finished render.
  async function tgFetch(method, init) {
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await fetch(`${TG}/${method}`, init);
        const j = await r.json().catch(() => ({}));
        if (!j.ok) console.error(`Telegram ${method} failed:`, JSON.stringify(j).slice(0, 300));
        return j;
      } catch (e) {
        lastErr = e;
        console.error(`Telegram ${method} network error (attempt ${attempt}/4):`, e.message);
        if (attempt < 4) await sleep(attempt * 3000);
      }
    }
    return { ok: false, _networkError: String(lastErr && lastErr.message) };
  }

  const tgForm = (method, fd) => tgFetch(method, { method: 'POST', body: fd });
  const tgJson = (method, body) => tgFetch(method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { tgFetch, tgForm, tgJson };
}

function blobFrom(p, name) { return [new Blob([fs.readFileSync(p)]), name]; }

/*
 * Sends the finished video as a FILE plus the caption and the steps for adding
 * a trending sound.
 *
 * It goes as a document, not a video, on purpose: Telegram re-compresses
 * anything sent with sendVideo, and that squeezed copy is not good enough to
 * repost to Instagram. A document arrives byte for byte.
 */
async function sendForManualPost({ tgForm, tgJson, chatId, videoPath, caption }) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('document', ...blobFrom(videoPath, 'reel.mp4'));
  fd.append('caption', '⬇️ Save this file to post with Instagram music.');
  await tgForm('sendDocument', fd);

  await tgJson('sendMessage', {
    chat_id: chatId,
    text:
      '🎵 *To post with a trending sound* (best reach)\n\n' +
      '1. Tap the file above and save it to your phone\n' +
      '2. Copy the caption below\n' +
      '3. Open Instagram → new Reel → pick the saved video\n' +
      '4. Tap *Add audio* and choose a trending sound\n' +
      '5. Paste the caption and share\n\n' +
      'Instagram only counts a sound as trending when you pick it inside the app, ' +
      'which is why this last step cannot be automated.\n\n' +
      `\`\`\`\n${caption}\n\`\`\``,
    parse_mode: 'Markdown',
  });
}

module.exports = { makeTelegram, blobFrom, sendForManualPost, sleep };
