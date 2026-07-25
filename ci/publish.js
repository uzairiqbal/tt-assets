'use strict';
/*
 * Publish phase. Runs only after the user taps "✅ Post it" in Telegram.
 * Trigger: repository_dispatch { client_payload: { reel_id, chat_id, message_id } }.
 *
 * The reel is already hosted on GitHub Pages by the build phase; this just
 * pushes it to Instagram and reports back. If message_id was passed (the
 * worker sends the id of the review message it just cleared the buttons on),
 * that same message is turned into a live progress ticker instead of posting
 * a fresh one — otherwise a new status message is created.
 */
const fs = require('fs');
const { publishHosted, readParked } = require('./instagram.js');
const { makeReporter } = require('./progress.js');

async function main() {
  const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const { reel_id: reelId, chat_id: chatId, message_id: messageId } = (ev && ev.client_payload) || {};
  if (!reelId || !chatId) { console.error('missing reel_id/chat_id'); process.exit(1); }

  const igUserId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  const igUser = process.env.IG_USERNAME || 'tshirtsandtrousers_';
  const pagesBase = (process.env.PAGES_BASE || 'https://uzairiqbal.github.io/tt-assets').replace(/\/$/, '');

  const progress = makeReporter(process.env.TELEGRAM_BOT_TOKEN, chatId);
  if (messageId) progress.attach(messageId, '📤 Posting to Instagram…');
  else await progress.start('📤 Posting to Instagram…');

  if (!igUserId || !token) {
    await progress.finish('⚠️ Instagram credentials are not configured on the repo.');
    process.exit(1);
  }

  try {
    const { caption } = readParked(reelId);
    const videoUrl = `${pagesBase}/reels/${reelId}.mp4`;

    const permalink = await publishHosted({
      videoUrl, caption, igUserId, token,
      emit: l => progress.update(l),
    });

    await progress.finish(`✅ Posted to @${igUser}\n\n${permalink}`, { disable_web_page_preview: false });
    console.log('published:', permalink);
  } catch (e) {
    console.error('publish failed:', e.message);
    await progress.finish(
      `⚠️ Posting failed: ${String(e.message).slice(0, 250)}\n\n` +
      `The reel and caption are still in your chat above — you can post them by hand.`
    );
    process.exit(1);
  }
}

main();
