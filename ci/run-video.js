'use strict';
/*
 * GitHub Actions entrypoint for the VIDEO journey.
 * Trigger: repository_dispatch { client_payload: { video_url, chat_id, template, hook, cta } }
 *
 * You send a clip of yourself holding the shirt. This downloads it, runs the
 * template edit, and sends the finished reel back with the caption and the
 * steps for adding a trending sound.
 *
 * The photo journey is ci/run.js. They are deliberately separate: video needs
 * no rembg, no Python and no image engine, so its workflow installs far less
 * and every run is quicker.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { editVideo, TEMPLATES } = require('../video.js');
const { pick: pickCaption } = require('../captions.js');
const { makeTelegram, blobFrom, sendForManualPost } = require('./telegram.js');
const { hostOnPages } = require('./instagram.js');

// A Telegram bot cannot download a file larger than this. It is a hard limit on
// their side, not something we can raise.
const TELEGRAM_MAX_BYTES = 20 * 1024 * 1024;

async function main() {
  const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const payload = (ev && ev.client_payload) || {};
  const { video_url: videoUrl, chat_id: chatId } = payload;
  if (!videoUrl || !chatId) { console.error('missing video_url/chat_id'); process.exit(1); }

  const template = TEMPLATES[payload.template] ? payload.template : (process.env.VIDEO_TEMPLATE || 'showcase');
  const hook = payload.hook || process.env.VIDEO_HOOK || 'New drop';
  const cta  = payload.cta  || process.env.VIDEO_CTA  || 'DM to order';

  const { tgForm, tgJson } = makeTelegram(process.env.TELEGRAM_BOT_TOKEN);
  const say = text => tgJson('sendMessage', { chat_id: chatId, text });

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ttvid-'));
  const inputPath = path.join(work, 'input.mp4');
  const outPath = path.join(work, 'reel.mp4');

  let step = 'startup';
  try {
    step = 'download';
    await say('⚙️ Got your video — downloading…');
    const res = await fetch(videoUrl);
    if (!res.ok) throw new Error('video download failed ' + res.status);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > TELEGRAM_MAX_BYTES) {
      throw new Error(`that video is ${(bytes.length / 1048576).toFixed(1)} MB — Telegram bots cannot handle over 20 MB`);
    }
    fs.writeFileSync(inputPath, bytes);
    console.log('downloaded', bytes.length, 'bytes');

    step = 'edit';
    await say(`▶ Editing with the "${template}" template…`);
    const emit = l => { console.log(l); if (/^\s*[▶✓✅⚠]/.test(l)) say(l.trim()); };
    await editVideo({ inputPath, outPath, template, hook, cta, emit });

    step = 'deliver';
    // Playable preview first, so you can check it in chat without saving.
    const vFd = new FormData();
    vFd.append('chat_id', String(chatId));
    vFd.append('video', ...blobFrom(outPath, 'reel.mp4'));
    vFd.append('supports_streaming', 'true');
    vFd.append('caption', '🎬 Edited — preview. The file to post is below.');
    await tgForm('sendVideo', vFd);

    const caption = pickCaption();
    await sendForManualPost({ tgForm, tgJson, chatId, videoPath: outPath, caption });

    // Auto-post is optional and always second — it cannot carry a trending sound.
    const igToken = process.env.IG_ACCESS_TOKEN;
    const igUserId = process.env.IG_USER_ID;
    const igUser = process.env.IG_USERNAME || 'tshirtsandtrousers_';
    if (!igToken || !igUserId) { console.log('done (manual only — IG secrets not set)'); return; }

    step = 'host';
    const parked = await hostOnPages({
      reelPath: outPath, caption,
      pagesBase: process.env.PAGES_BASE || 'https://uzairiqbal.github.io/tt-assets',
      emit: l => console.log(l),
    });

    await tgJson('sendMessage', {
      chat_id: chatId,
      text:
        `👀 *Or post it automatically*\n\n` +
        `This posts to \`@${igUser}\` right now, but with *no trending sound* — ` +
        `the API cannot add Instagram music.\n\nUse the file above if you want one.`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '⚡ Post now (no music)', callback_data: `post:${parked.id}` },
          { text: '❌ Cancel', callback_data: `skip:${parked.id}` },
        ]],
      },
    });
    console.log('done (awaiting approval)');
  } catch (e) {
    console.error('video pipeline failed at', step, e);
    await say(`⚠️ Video failed at "${step}": ${String(e.message).slice(0, 250)}`);
    process.exit(1);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

main();
