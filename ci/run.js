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
const { hostOnPages } = require('./instagram.js');

const BOT = process.env.TELEGRAM_BOT_TOKEN;
const TG = `https://api.telegram.org/bot${BOT}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GitHub Actions runners intermittently can't reach Telegram (ETIMEDOUT on
// api.telegram.org). Retry with backoff so one network blip doesn't crash the
// whole pipeline after the shots/reel are already built.
async function tgFetch(method, init, label) {
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
  console.error(`Telegram ${method} gave up after 4 attempts`);
  return { ok: false, _networkError: String(lastErr && lastErr.message) };
}

// Send FormData (for file uploads)
async function tgForm(method, fd) {
  return tgFetch(method, { method: 'POST', body: fd });
}

// Send JSON (for text messages)
async function tgJson(method, body) {
  return tgFetch(method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function blobFrom(p, name) { return [new Blob([fs.readFileSync(p)]), name]; }

// AI editing is paused. Anything not explicitly chosen — and the legacy 'auto',
// which now always ends up at the background-stripping free engine — resolves
// to passthrough, which keeps your photo exactly as you sent it.
const PAUSED = new Set(['auto', '', undefined, null]);
function resolveEngine(requested) {
  return PAUSED.has(requested) ? 'passthrough' : requested;
}

// Manual-post fallback: caption in a code block (one tap copies it) + profile link.
// Username goes in an inline code span — its trailing "_" would otherwise be read
// as an unclosed Markdown italic marker and make Telegram reject the whole message.
/*
 * The music route.
 *
 * Instagram's API cannot attach a track from Instagram's music library. There
 * is no parameter for it — trending sounds are app-only. So a reel posted
 * automatically can never carry a trending sound, and that sound is exactly
 * what drives reach.
 *
 * So we send the reel as a FILE rather than a video. Telegram squeezes videos
 * to make them play in chat, and that squeezed copy is not good enough to post.
 * The file arrives untouched, you save it, and you post it from the Instagram
 * app where you can pick any trending sound you like.
 */
async function sendForManualPost(chatId, reelPath, caption) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('document', ...blobFrom(reelPath, 'reel.mp4'));
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

async function main() {
  const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const payload = (ev && ev.client_payload) || {};
  const photoUrl = payload.photo_url;
  const chatId = payload.chat_id;
  const jobId = payload.job_id; // set by the Worker; lets a "Retry" tap re-run this exact job
  if (!photoUrl || !chatId) { console.error('missing photo_url/chat_id'); process.exit(1); }

  // Milestone updates are sent as fresh messages — not edits — so each one
  // is a real notification and the whole run stays visible in chat history
  // if you check back after it's finished, instead of only ever showing
  // whatever the last edit happened to be.
  let currentStep = 'startup';
  const milestone = l => { currentStep = l; return tgJson('sendMessage', { chat_id: chatId, text: l }); };

  // Attach a one-tap "🔄 Retry" button when something transient breaks (a
  // Telegram network blip, PhotoRoom, etc.). The Worker re-runs this same job
  // from the stored photo, so the user never has to re-upload. Falls back to a
  // plain message if the Worker didn't supply a job_id (e.g. KV not configured).
  const offerRetry = text => {
    const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
    if (jobId) body.reply_markup = { inline_keyboard: [[{ text: '🔄 Retry', callback_data: `retry:${jobId}` }]] };
    return tgJson('sendMessage', body);
  };

  await milestone('⚙️ Starting — downloading your photo…');

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ttrun-'));
  const outDir = path.join(work, 'out');
  const imagePath = path.join(work, 'input.jpg');

  try {
    const res = await fetch(photoUrl);
    if (!res.ok) throw new Error('photo download failed ' + res.status);
    fs.writeFileSync(imagePath, Buffer.from(await res.arrayBuffer()));

    // Music comes from the library at tt-assets/assets/music/ — the pipeline
    // picks one track at random per reel. The old single assets/audio.mp3 is
    // still honoured if it is there, so nothing breaks.
    const legacyAudio = path.join(__dirname, '..', 'assets', 'audio.mp3');
    const reelAudio = fs.existsSync(legacyAudio) ? legacyAudio : '';

    // Every line goes to the Action log (full detail, for debugging).
    // Only step headers/results (▶ ✓ ✅ ⚠) also go to Telegram, as their
    // own message — the per-scene "· ..." lines would just be noise there.
    const emit = l => {
      console.log(l);
      if (/^\s*[▶✓✅⚠]/.test(l)) { currentStep = l.trim(); milestone(l.trim()); }
    };
    const { shotPaths, reelPath } = await runPipeline({
      imagePath, outDir,
      config: {
        photoroomKey: process.env.PHOTOROOM_API_KEY,
        geminiKey: process.env.GEMINI_API_KEY,
        brandBg: payload.bg || process.env.BRAND_BG_PROMPT || 'a clean minimal light neutral studio background, soft even lighting',
        // 'passthrough' = no AI. You edit the photo yourself in the PhotoRoom
        // mobile app and send the finished picture, so the pipeline must not
        // edit it again. Set ENGINE to bring the AI engines back later.
        //
        // 'auto' is deliberately remapped. It used to mean "try PhotoRoom, fall
        // back to the free engine". With no PhotoRoom credits left, that
        // fallback ALWAYS fires, and the free engine is rembg — which strips the
        // background off the photo you already edited by hand. The Telegram
        // Worker still sends 'auto' until it is redeployed, so it is caught
        // here, where a plain git push is enough to take effect.
        engine: resolveEngine(payload.engine || process.env.ENGINE),
        reelAudio,
        secondsPerShot: parseFloat(process.env.SECONDS_PER_SHOT || '4'),
        // Baked-in music sits quietly under the reel. 1.0 would be full volume.
        musicVolume: parseFloat(process.env.MUSIC_VOLUME || '0.12'),
      },
      emit,
    });

    await milestone('▶ Step 3 — sending shots + reel to this chat');

    // 1 — the picture(s). Telegram's album endpoint refuses a group of one, and
    // the passthrough engine returns exactly one picture, so send a single photo
    // in that case and an album only when there really are several.
    let album;
    if (shotPaths.length === 1) {
      const photoFd = new FormData();
      photoFd.append('chat_id', String(chatId));
      photoFd.append('photo', ...blobFrom(shotPaths[0], 'shot_1.jpg'));
      photoFd.append('caption', '🖼 Your photo, kept exactly as you sent it.');
      album = await tgForm('sendPhoto', photoFd);
    } else {
      const media = shotPaths.map((_, i) => ({ type: 'photo', media: `attach://p${i}` }));
      const albumFd = new FormData();
      albumFd.append('chat_id', String(chatId));
      albumFd.append('media', JSON.stringify(media));
      shotPaths.forEach((p, i) => albumFd.append(`p${i}`, ...blobFrom(p, `shot_${i + 1}.jpg`)));
      album = await tgForm('sendMediaGroup', albumFd);
    }

    // 2 — reel video
    const vFd = new FormData();
    vFd.append('chat_id', String(chatId));
    vFd.append('video', ...blobFrom(reelPath, 'reel.mp4'));
    vFd.append('supports_streaming', 'true');
    vFd.append('caption', '🎬 Reel ready — see below for what happens next.');
    const vid = await tgForm('sendVideo', vFd);

    // If the shots or reel couldn't be delivered (Telegram unreachable from the
    // runner), don't limp forward into a confusing review step — offer a retry.
    if (!album.ok || !vid.ok) {
      await offerRetry('⚠️ Your shots and reel were built, but delivering them here failed (network). Tap Retry to rebuild and resend — no need to re-upload the photo.');
      console.log('done (delivery failed — offered retry)');
      return;
    }

    // 3 — park the reel and ask for approval. Nothing is published without a tap.
    const caption = pickCaption();
    const igUser = process.env.IG_USERNAME || 'tshirtsandtrousers_';
    const igToken = process.env.IG_ACCESS_TOKEN;
    const igUserId = process.env.IG_USER_ID;

    // Always offer the music route first. It is the one that actually earns
    // reach, and it is the only way to get a trending sound onto the reel.
    await sendForManualPost(chatId, reelPath, caption);

    if (!igToken || !igUserId) {
      console.log('done (manual mode — IG secrets not set)');
      return;
    }

    await milestone('▶ Step 4 — preparing reel for Instagram review');
    let parked;
    try {
      parked = await hostOnPages({
        reelPath, caption,
        pagesBase: process.env.PAGES_BASE || 'https://uzairiqbal.github.io/tt-assets',
        emit,
      });
    } catch (e) {
      console.error('hosting failed:', e.message);
      // The file and caption were already sent above, so don't repeat them —
      // just point back at them.
      await tgJson('sendMessage', {
        chat_id: chatId,
        text: `⚠️ Auto-posting is unavailable right now: ${String(e.message).slice(0, 180)}\n\nNo problem — use the file and caption above and post it from the Instagram app. You get a trending sound that way anyway.`,
      });
      return;
    }

    await tgJson('sendMessage', {
      chat_id: chatId,
      text:
        `👀 *Or post it automatically*\n\n` +
        `This posts to \`@${igUser}\` right now, but it will have *no trending sound* — ` +
        `the API cannot add Instagram music. Its audio gets named "TShirts & Trousers" instead, ` +
        `which gives you your own audio page.\n\n` +
        `Use the file above if you want a trending sound.`,
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
    const stack = (e.stack || e.message || String(e)).slice(0, 600);
    console.error('pipeline error at step:', currentStep);
    console.error(stack);
    await offerRetry(
      `⚠️ *Pipeline crashed*\nStep: \`${String(currentStep).slice(0, 80)}\`\n\`\`\`\n${String(e.message).slice(0, 300)}\n\`\`\``
    );
    await tgJson('sendMessage', {
      chat_id: chatId,
      text: `📋 Stack trace:\n\`\`\`\n${stack}\n\`\`\``,
      parse_mode: 'Markdown',
    });
    process.exit(1);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

main();
