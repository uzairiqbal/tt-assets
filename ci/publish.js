'use strict';
/*
 * Publish phase. Runs only after the user taps "✅ Post it" in Telegram.
 * Trigger: repository_dispatch { client_payload: { reel_id, chat_id, message_id } }.
 *
 * Posts to Instagram and TikTok in parallel. Either can fail without blocking the other.
 * TikTok is skipped gracefully if its secrets are not configured.
 */
const fs = require('fs');
const { publishHosted, readParked } = require('./instagram.js');
const { makeReporter } = require('./progress.js');
const { publishToTikTok } = require('./tiktok.js');

async function main() {
  const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const { reel_id: reelId, chat_id: chatId, message_id: messageId } = (ev && ev.client_payload) || {};
  if (!reelId || !chatId) { console.error('missing reel_id/chat_id'); process.exit(1); }

  const igUserId  = process.env.IG_USER_ID;
  const igToken   = process.env.IG_ACCESS_TOKEN;
  const igUser    = process.env.IG_USERNAME || 'tshirtsandtrousers_';
  const pagesBase = (process.env.PAGES_BASE || 'https://uzairiqbal.github.io/tt-assets').replace(/\/$/, '');

  const ttClientKey    = process.env.TIKTOK_CLIENT_KEY;
  const ttClientSecret = process.env.TIKTOK_CLIENT_SECRET;
  const ttRefreshToken = process.env.TIKTOK_REFRESH_TOKEN;
  const ghSecretsToken = process.env.GH_SECRETS_TOKEN;

  const hasTikTok = !!(ttClientKey && ttClientSecret && ttRefreshToken);
  const platforms = hasTikTok ? 'Instagram & TikTok' : 'Instagram';

  const progress = makeReporter(process.env.TELEGRAM_BOT_TOKEN, chatId);
  if (messageId) progress.attach(messageId, `📤 Posting to ${platforms}…`);
  else await progress.start(`📤 Posting to ${platforms}…`);

  if (!igUserId || !igToken) {
    await progress.finish('⚠️ Instagram credentials are not configured on the repo.');
    process.exit(1);
  }

  const { caption } = readParked(reelId);
  const videoUrl = `${pagesBase}/reels/${reelId}.mp4`;

  // Run Instagram and TikTok in parallel — allSettled so one failure never blocks the other
  const [igResult, ttResult] = await Promise.allSettled([
    publishHosted({
      videoUrl, caption, igUserId, token: igToken,
      // Names the reel's own audio so it gets an audio page others can reuse.
      // This does NOT add Instagram library music — the API cannot do that.
      audioName: process.env.IG_AUDIO_NAME || 'TShirts & Trousers',
      emit: l => progress.update(l),
    }),
    hasTikTok
      ? publishToTikTok({
          videoUrl, caption,
          clientKey: ttClientKey,
          clientSecret: ttClientSecret,
          refreshToken: ttRefreshToken,
          ghSecretsToken,
          emit: l => progress.update(l),
        })
      : Promise.resolve(null),
  ]);

  // Build the final Telegram message
  const lines = [];

  if (igResult.status === 'fulfilled') {
    lines.push(`✅ Instagram — @${igUser}\n${igResult.value}`);
    console.log('instagram published:', igResult.value);
  } else {
    lines.push(`⚠️ Instagram failed:\n${String(igResult.reason && igResult.reason.message).slice(0, 200)}`);
    console.error('instagram failed:', igResult.reason);
  }

  if (hasTikTok) {
    if (ttResult.status === 'fulfilled' && ttResult.value) {
      lines.push(`✅ TikTok — ${ttResult.value.note}`);
      console.log('tiktok result:', ttResult.value.status);
    } else if (ttResult.status === 'rejected') {
      lines.push(`⚠️ TikTok failed:\n${String(ttResult.reason && ttResult.reason.message).slice(0, 200)}`);
      console.error('tiktok failed:', ttResult.reason);
    }
  }

  const bothFailed = igResult.status === 'rejected' && (!hasTikTok || ttResult.status === 'rejected');
  if (bothFailed) {
    lines.push('\nThe reel and caption are still in your chat — you can post them by hand.');
  }

  await progress.finish(lines.join('\n\n'), { disable_web_page_preview: false });

  if (igResult.status === 'rejected') process.exit(1);
}

main().catch(async e => {
  console.error('publish.js crashed:', e);
  process.exit(1);
});
