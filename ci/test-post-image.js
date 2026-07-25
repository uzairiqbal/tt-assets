'use strict';
/*
 * One-off Graph API connectivity check: posts a single IMAGE (not a reel)
 * to confirm IG_ACCESS_TOKEN / IG_USER_ID actually work. Images publish
 * near-instantly (no transcoding wait), so this is the fastest way to tell
 * "the token is broken" apart from "the reel pipeline is broken."
 */
const GRAPH = 'https://graph.facebook.com/v21.0';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const igUserId = process.env.IG_USER_ID;
  const token = process.env.IG_ACCESS_TOKEN;
  const imageUrl = process.env.IMAGE_URL;
  const caption = process.env.TEST_CAPTION || '🧪 API connectivity test — TShirts & Trousers';

  if (!igUserId || !token || !imageUrl) {
    console.error('RESULT: FAIL — missing IG_USER_ID / IG_ACCESS_TOKEN / IMAGE_URL');
    process.exit(1);
  }

  // sanity-check the secret shape without ever printing it
  console.log('token length:', token.length, '| looks like EAA-prefixed:', token.startsWith('EAA'));
  console.log('image url:', imageUrl);

  console.log('creating image container...');
  const c = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: 'POST',
    body: new URLSearchParams({ image_url: imageUrl, caption, access_token: token }),
  });
  const cj = await c.json();
  if (cj.error) {
    console.error(`RESULT: FAIL — container error (code ${cj.error.code}): ${cj.error.message}`);
    process.exit(1);
  }
  console.log('container id:', cj.id);

  await sleep(5000);

  console.log('publishing...');
  const p = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: cj.id, access_token: token }),
  });
  const pj = await p.json();
  if (pj.error) console.log('publish reported (may be a false negative):', pj.error.message);
  else console.log('publish response id:', pj.id);

  // confirm against the feed either way — never trust the publish response alone
  await sleep(8000);
  const startedAt = Date.now() - 180000;
  for (let i = 0; i < 8; i++) {
    const f = await fetch(`${GRAPH}/${igUserId}/media?fields=id,media_product_type,permalink,timestamp&limit=5&access_token=${token}`);
    const fj = await f.json();
    if (fj.error) {
      console.error(`RESULT: FAIL — feed check error (code ${fj.error.code}): ${fj.error.message}`);
      process.exit(1);
    }
    const hit = (fj.data || []).find(m => new Date(m.timestamp).getTime() >= startedAt);
    if (hit) { console.log('RESULT: PASS —', hit.permalink); return; }
    await sleep(8000);
  }
  console.error('RESULT: FAIL — not confirmed in feed within timeout');
  process.exit(1);
}

main();
