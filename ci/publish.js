'use strict';
/*
 * Publish phase. Runs only after the user taps "✅ Post it" in Telegram.
 * Trigger: repository_dispatch { client_payload: { reel_id, chat_id } }.
 *
 * The reel is already hosted on GitHub Pages by the build phase; this just
 * pushes it to Instagram and reports back.
 */
const fs = require('fs');
const { publishHosted, readParked } = require('./instagram.js');

const TG = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function tell(chatId, text, extra = {}) {
  const res = await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, ...extra }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) console.error('Telegram sendMessage failed:', JSON.stringify(j).slice(0, 300));
}

async function main() {
  const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const { reel_id: reelId, chat_id: chatId } = (ev && ev.client_payload) || {};
  if (!reelId || !chatId) { console.error('missing reel_id/chat_id'); process.exit(1); }

  const igUserId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  const igUser = process.env.IG_USERNAME || 'tshirtsandtrousers_';
  const pagesBase = (process.env.PAGES_BASE || 'https://uzairiqbal.github.io/tt-assets').replace(/\/$/, '');

  if (!igUserId || !token) {
    await tell(chatId, '⚠️ Instagram credentials are not configured on the repo.');
    process.exit(1);
  }

  try {
    const { caption } = readParked(reelId);
    const videoUrl = `${pagesBase}/reels/${reelId}.mp4`;

    await tell(chatId, '📤 Posting to Instagram… this takes a couple of minutes.');

    const permalink = await publishHosted({
      videoUrl, caption, igUserId, token,
      emit: l => console.log(l),
    });

    await tell(chatId, `✅ Posted to @${igUser}\n\n${permalink}`, { disable_web_page_preview: false });
    console.log('published:', permalink);
  } catch (e) {
    console.error('publish failed:', e.message);
    await tell(chatId,
      `⚠️ Posting failed: ${String(e.message).slice(0, 250)}\n\n` +
      `The reel and caption are still in your chat above — you can post them by hand.`
    );
    process.exit(1);
  }
}

main();
