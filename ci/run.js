'use strict';
/*
 * GitHub Actions entrypoint for the mobile pipeline.
 * Trigger: repository_dispatch { client_payload: { photo_url, chat_id } }.
 * Downloads the Telegram photo -> runs the shared pipeline -> replies to the chat with 3 shots + reel + caption.
 * Secrets come from env (PHOTOROOM_API_KEY, TELEGRAM_BOT_TOKEN). Never logged.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runPipeline } = require('../pipeline.js');
const { pick: pickCaption } = require('../captions.js');
const { postReel } = require('./instagram.js');

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG = `https://api.telegram.org/bot${BOT}`;

// Send FormData (for file uploads)
async function tgForm(method, fd) {
  const r = await fetch(`${TG}/${method}`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error(`Telegram ${method} failed:`, JSON.stringify(j).slice(0, 300));
  return j;
}

// Send JSON (for text messages)
async function tgJson(method, body) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error(`Telegram ${method} failed:`, JSON.stringify(j).slice(0, 300));
  return j;
}

function blobFrom(p, name) { return [new Blob([fs.readFileSync(p)]), name]; }

// Manual-post fallback: caption in a code block (one tap copies it) + profile link.
async function sendManualCaption(chatId, caption, igUser) {
  await tgJson('sendMessage', {
    chat_id: chatId,
    text: `📋 Tap the caption below to copy it, then open Instagram and paste:\n\n\`\`\`\n${caption}\n\`\`\``,
    parse_mode: 'Markdown',
  });
  await tgJson('sendMessage', {
    chat_id: chatId,
    text: `👆 Copy caption above → then tap below to open your Instagram page and post:\n\nhttps://www.instagram.com/${igUser}/`,
    disable_web_page_preview: false,
  });
}

async function main() {
  const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const payload = (ev && ev.client_payload) || {};
  const photoUrl = payload.photo_url;
  const chatId = payload.chat_id;
  if (!photoUrl || !chatId) { console.error('missing photo_url/chat_id'); process.exit(1); }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrun-'));
  const outDir = path.join(work, 'out');
  const imagePath = path.join(work, 'input.jpg');

  try {
    const res = await fetch(photoUrl);
    if (!res.ok) throw new Error('photo download failed ' + res.status);
    fs.writeFileSync(imagePath, Buffer.from(await res.arrayBuffer()));

    const repoAudio = path.join(__dirname, '..', 'assets', 'audio.mp3');
    const reelAudio = fs.existsSync(repoAudio) ? repoAudio : '';

    const emit = l => console.log(l);
    const { shotPaths, reelPath } = await runPipeline({
      imagePath, outDir,
      config: {
        photoroomKey: process.env.PHOTOROOM_API_KEY,
        geminiKey: process.env.GEMINI_API_KEY,
        brandBg: payload.bg || process.env.BRAND_BG_PROMPT || 'a clean minimal light neutral studio background, soft even lighting',
        engine: payload.engine || process.env.ENGINE || 'auto',
        reelAudio,
        secondsPerShot: parseFloat(process.env.SECONDS_PER_SHOT || '4'),
      },
      emit,
    });

    // 1 — 3 studio shots album
    const media = shotPaths.map((_, i) => ({ type: 'photo', media: `attach://p${i}` }));
    const albumFd = new FormData();
    albumFd.append('chat_id', String(chatId));
    albumFd.append('media', JSON.stringify(media));
    shotPaths.forEach((p, i) => albumFd.append(`p${i}`, ...blobFrom(p, `shot_${i + 1}.jpg`)));
    await tgForm('sendMediaGroup', albumFd);

    // 2 — reel video
    const vFd = new FormData();
    vFd.append('chat_id', String(chatId));
    vFd.append('video', ...blobFrom(reelPath, 'reel.mp4'));
    vFd.append('supports_streaming', 'true');
    vFd.append('caption', '🎬 Reel ready — save it then post to Instagram.');
    await tgForm('sendVideo', vFd);

    // 3 — publish, or hand the caption over for a manual post
    const caption = pickCaption();
    const igUser = process.env.IG_USERNAME || 'tshirtsandtrousers_';
    const igToken = process.env.IG_ACCESS_TOKEN;
    const igUserId = process.env.IG_USER_ID;

    if (igToken && igUserId) {
      await tgJson('sendMessage', { chat_id: chatId, text: '📤 Posting to Instagram…' });
      try {
        const permalink = await postReel({
          reelPath, caption, igUserId, token: igToken,
          pagesBase: process.env.PAGES_BASE || 'https://uzairiqbal.github.io/tt-assets',
          emit,
        });
        await tgJson('sendMessage', {
          chat_id: chatId,
          text: `✅ Posted to @${igUser}\n\n${permalink}`,
          disable_web_page_preview: false,
        });
      } catch (e) {
        // Posting failed — fall back to the manual flow so the run is still useful
        console.error('instagram post failed:', e.message);
        await tgJson('sendMessage', {
          chat_id: chatId,
          text: `⚠️ Auto-post failed: ${String(e.message).slice(0, 180)}\n\nPost it manually with the caption below.`,
        });
        await sendManualCaption(chatId, caption, igUser);
      }
    } else {
      await sendManualCaption(chatId, caption, igUser);
    }

    console.log('done');
  } catch (e) {
    console.error('pipeline error:', e.message);
    try {
      await tgJson('sendMessage', { chat_id: chatId, text: '⚠️ Something went wrong: ' + String(e.message).slice(0, 200) });
    } catch (_) {}
    process.exit(1);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

main();
