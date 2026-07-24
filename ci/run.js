'use strict';
/*
 * GitHub Actions entrypoint for the mobile pipeline.
 * Trigger: repository_dispatch { client_payload: { photo_url, chat_id } }.
 * Downloads the Telegram photo -> runs the shared pipeline -> replies to the chat with 3 shots + reel.
 * Secrets come from env (PHOTOROOM_API_KEY, TELEGRAM_BOT_TOKEN). Never logged.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runPipeline } = require('../pipeline.js');

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG = `https://api.telegram.org/bot${BOT}`;

async function tgSend(method, fd) {
  const r = await fetch(`${TG}/${method}`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error(`Telegram ${method} failed:`, JSON.stringify(j).slice(0, 300));
  return j;
}
function blobFrom(p, name) { return [new Blob([fs.readFileSync(p)]), name]; }

async function sendText(chatId, text) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('text', text);
  return tgSend('sendMessage', fd);
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
    // download the source photo (photoUrl embeds the bot token — do not log it)
    const res = await fetch(photoUrl);
    if (!res.ok) throw new Error('photo download failed ' + res.status);
    fs.writeFileSync(imagePath, Buffer.from(await res.arrayBuffer()));

    // optional audio: repo file assets/audio.mp3 if present (else silent, user adds IG music)
    const repoAudio = path.join(__dirname, '..', 'assets', 'audio.mp3');
    const reelAudio = fs.existsSync(repoAudio) ? repoAudio : '';

    const logs = [];
    const emit = l => { logs.push(l); console.log(l); };
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

    // 3 studio shots as an album
    const media = shotPaths.map((_, i) => ({ type: 'photo', media: `attach://p${i}` }));
    const albumFd = new FormData();
    albumFd.append('chat_id', String(chatId));
    albumFd.append('media', JSON.stringify(media));
    shotPaths.forEach((p, i) => albumFd.append(`p${i}`, ...blobFrom(p, `shot_${i + 1}.jpg`)));
    await tgSend('sendMediaGroup', albumFd);

    // the reel + caption
    const caption = (process.env.IG_CAPTION || '').replace(/\\n/g, '\n');
    const vFd = new FormData();
    vFd.append('chat_id', String(chatId));
    vFd.append('video', ...blobFrom(reelPath, 'reel.mp4'));
    vFd.append('supports_streaming', 'true');
    vFd.append('caption', '🎬 Your reel is ready — save it and tap Share → Instagram.\n\n' + caption);
    await tgSend('sendVideo', vFd);

    console.log('done');
  } catch (e) {
    console.error('pipeline error:', e.message);
    try { await sendText(chatId, '⚠️ Something went wrong building your reel: ' + String(e.message).slice(0, 200)); } catch (_) {}
    process.exit(1);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  }
}

main();
