'use strict';
/*
 * Instagram Reels auto-publish.
 *
 * Flow: host the mp4 on GitHub Pages -> create a REELS container -> wait for it to
 * finish transcoding -> publish -> CONFIRM against the account's media feed.
 *
 * The confirm step is not optional. media_publish regularly returns
 * "Media Builder Not Found / expired" for a reel that DID post, because the
 * container is consumed by the successful publish. Retrying on that error
 * double-posts. The feed is the only source of truth.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GRAPH = 'https://graph.facebook.com/v21.0';
const KEEP_REELS = 10; // prune older files so the repo doesn't grow forever

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 1. hosting ---------- */

/**
 * Commit the reel into the repo and wait for GitHub Pages to serve it.
 * Pages returns a proper `video/mp4` content-type; raw.githubusercontent.com
 * returns application/octet-stream, which Instagram rejects.
 */
async function hostOnPages(reelPath, pagesBase, emit) {
  const repoRoot = path.join(__dirname, '..');
  const name = `reel_${Date.now()}.mp4`;
  const destDir = path.join(repoRoot, 'reels');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(reelPath, path.join(destDir, name));

  // keep only the newest KEEP_REELS files
  const old = fs.readdirSync(destDir)
    .filter(f => f.endsWith('.mp4'))
    .sort()
    .slice(0, -KEEP_REELS);
  for (const f of old) fs.unlinkSync(path.join(destDir, f));

  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
  git('config', 'user.name', 'tt-reel-bot');
  git('config', 'user.email', 'bot@users.noreply.github.com');
  git('add', 'reels');
  git('commit', '-m', `reel ${name} [skip ci]`);
  git('push', 'origin', 'HEAD:main');
  emit(`  · pushed ${name}`);

  const url = `${pagesBase.replace(/\/$/, '')}/reels/${name}`;

  // Pages rebuilds asynchronously — poll until the file is actually served
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok && (r.headers.get('content-type') || '').includes('video/mp4')) {
        emit('  · live on GitHub Pages');
        return url;
      }
    } catch (_) { /* Pages still building */ }
  }
  throw new Error('GitHub Pages did not serve the reel within 4 minutes');
}

/* ---------- 2. container ---------- */

async function createContainer(igUserId, token, videoUrl, caption, emit) {
  const body = new URLSearchParams({
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    access_token: token,
  });
  const res = await fetch(`${GRAPH}/${igUserId}/media`, { method: 'POST', body });
  const json = await res.json();
  if (json.error) throw new Error(`container: ${json.error.message}`);
  emit(`  · container ${json.id}`);
  return json.id;
}

/** Poll the container until Instagram finishes transcoding. */
async function waitForContainer(containerId, token, emit) {
  for (let i = 0; i < 30; i++) {
    await sleep(10000);
    const res = await fetch(`${GRAPH}/${containerId}?fields=status_code,status&access_token=${token}`);
    const json = await res.json();
    if (json.error) { emit('  · status check unavailable — waiting out the clock'); await sleep(50000); return; }
    if (json.status_code === 'FINISHED') { emit('  · transcoding finished'); return; }
    if (json.status_code === 'ERROR') throw new Error(`transcoding failed: ${json.status || 'unknown'}`);
  }
  throw new Error('container did not finish within 5 minutes');
}

/* ---------- 3. publish + confirm ---------- */

/** Look for a reel published in the last few minutes. Returns its permalink, or null. */
async function findRecentReel(igUserId, token, sinceMs) {
  const res = await fetch(
    `${GRAPH}/${igUserId}/media?fields=id,media_product_type,permalink,timestamp&limit=5&access_token=${token}`
  );
  const json = await res.json();
  if (json.error || !json.data) return null;
  const hit = json.data.find(m =>
    m.media_product_type === 'REELS' && new Date(m.timestamp).getTime() >= sinceMs
  );
  return hit ? hit.permalink : null;
}

async function publish(igUserId, token, containerId, emit) {
  const startedAt = Date.now() - 120000; // allow for clock skew
  let publishError = null;

  const res = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: containerId, access_token: token }),
  });
  const json = await res.json();

  if (json.error) {
    publishError = json.error.message;
    emit(`  · publish reported: ${publishError}`);
  }

  // Confirm against the feed either way — a reported error does NOT mean it failed.
  await sleep(15000);
  for (let i = 0; i < 6; i++) {
    const permalink = await findRecentReel(igUserId, token, startedAt);
    if (permalink) return permalink;
    await sleep(10000);
  }

  throw new Error(publishError || 'published but the reel did not appear in the feed');
}

/* ---------- entry point ---------- */

/**
 * @returns {Promise<string>} permalink of the published reel
 */
async function postReel({ reelPath, caption, igUserId, token, pagesBase, emit }) {
  const log = emit || (() => {});
  log('▶ Step 3 — posting to Instagram');
  const videoUrl = await hostOnPages(reelPath, pagesBase, log);
  const containerId = await createContainer(igUserId, token, videoUrl, caption, log);
  await waitForContainer(containerId, token, log);
  const permalink = await publish(igUserId, token, containerId, log);
  log(`  ✓ live: ${permalink}`);
  return permalink;
}

module.exports = { postReel };
