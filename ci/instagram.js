'use strict';
/*
 * Instagram Reels publishing, split into two phases so a human can approve
 * between them:
 *
 *   hostOnPages()    build phase — commit the mp4 + its caption to the repo so
 *                    GitHub Pages serves it at a public video/mp4 URL
 *   publishHosted()  publish phase — container -> transcode -> publish -> CONFIRM
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
const REPO_ROOT = path.join(__dirname, '..');
const REELS_DIR = path.join(REPO_ROOT, 'reels');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- error decoding ---------- */

// Instagram's transcoder errors are opaque by default. Map the ones that
// actually happen to something the user can act on.
function explainMediaError(raw) {
  const s = String(raw || '');
  if (/2207026|unsupported|format/i.test(s))
    return 'Instagram rejected the video format. The reel must be H.264/AAC MP4 — check the ffmpeg step.';
  if (/2207020|download|fetch|url/i.test(s))
    return 'Instagram could not download the video. The GitHub Pages URL may not be live yet.';
  if (/2207003|timeout|timed out/i.test(s))
    return 'Instagram timed out transcoding the video. Usually transient — try again.';
  if (/2207too|too long|duration/i.test(s))
    return 'Reel duration is out of range (must be 3s–15min).';
  if (/aspect|resolution|dimension/i.test(s))
    return 'Aspect ratio rejected. Reels want 9:16 (1080x1920).';
  return s || 'unknown transcoding error';
}

/** Log the actual encode params, so a rejection is diagnosable after the fact. */
function probe(reelPath, emit) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,width,height,r_frame_rate,sample_rate,channels',
      '-show_entries', 'format=duration,size',
      '-of', 'default=noprint_wrappers=1', reelPath,
    ], { encoding: 'utf8' });
    emit('  · reel: ' + out.trim().split('\n').join(' ').replace(/\s+/g, ' '));
  } catch (_) { /* ffprobe is nice-to-have, never fatal */ }
}

/* ---------- build phase: host + park the caption ---------- */

/**
 * Commit the reel and its caption into the repo, then wait for GitHub Pages.
 * Pages returns a proper `video/mp4` content-type; raw.githubusercontent.com
 * returns application/octet-stream, which Instagram rejects.
 *
 * @returns {Promise<{id:string, url:string}>}
 */
async function hostOnPages({ reelPath, caption, pagesBase, emit }) {
  const log = emit || (() => {});
  probe(reelPath, log);

  const id = `reel_${Date.now()}`;
  fs.mkdirSync(REELS_DIR, { recursive: true });
  fs.copyFileSync(reelPath, path.join(REELS_DIR, `${id}.mp4`));
  fs.writeFileSync(path.join(REELS_DIR, `${id}.json`), JSON.stringify({ id, caption }, null, 2));

  // keep only the newest KEEP_REELS reels (mp4 + its sidecar json)
  const ids = fs.readdirSync(REELS_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => f.replace(/\.mp4$/, ''))
    .sort();
  for (const old of ids.slice(0, -KEEP_REELS)) {
    for (const ext of ['.mp4', '.json']) {
      try { fs.unlinkSync(path.join(REELS_DIR, old + ext)); } catch (_) {}
    }
  }

  const git = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, stdio: 'pipe' });
  git('config', 'user.name', 'tt-reel-bot');
  git('config', 'user.email', 'bot@users.noreply.github.com');
  git('add', 'reels');
  git('commit', '-m', `reel ${id} [skip ci]`);
  git('push', 'origin', 'HEAD:main');
  log(`  · pushed ${id}`);

  const url = `${pagesBase.replace(/\/$/, '')}/reels/${id}.mp4`;

  // Pages rebuilds asynchronously — poll until the file is actually served
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok && (r.headers.get('content-type') || '').includes('video/mp4')) {
        log('  · live on GitHub Pages');
        return { id, url };
      }
    } catch (_) { /* Pages still building */ }
  }
  throw new Error('GitHub Pages did not serve the reel within 4 minutes');
}

/** Read a parked reel's caption back during the publish phase. */
function readParked(id) {
  const meta = path.join(REELS_DIR, `${id}.json`);
  if (!fs.existsSync(meta)) throw new Error(`reel ${id} is no longer available (it may have been pruned)`);
  return JSON.parse(fs.readFileSync(meta, 'utf8'));
}

/* ---------- publish phase ---------- */

async function createContainer(igUserId, token, videoUrl, caption, log) {
  const res = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: 'POST',
    body: new URLSearchParams({ media_type: 'REELS', video_url: videoUrl, caption, access_token: token }),
  });
  const json = await res.json();
  if (json.error) throw new Error('Could not start upload: ' + explainMediaError(json.error.message));
  log(`  · container ${json.id}`);
  return json.id;
}

/** Poll until Instagram finishes transcoding, surfacing real errors. */
async function waitForContainer(containerId, token, log) {
  for (let i = 0; i < 30; i++) {
    await sleep(10000);
    const res = await fetch(`${GRAPH}/${containerId}?fields=status_code,status&access_token=${token}`);
    const json = await res.json();

    if (json.error) {
      // status polling can be blocked on some tokens — wait out a typical transcode
      log('  · status unavailable, waiting out the clock');
      await sleep(50000);
      return;
    }
    if (json.status_code === 'FINISHED') { log('  · transcoding finished'); return; }
    if (json.status_code === 'ERROR') throw new Error(explainMediaError(json.status));
    if (i % 3 === 0) log(`  · transcoding (${json.status_code || 'IN_PROGRESS'})`);
  }
  throw new Error('Instagram did not finish transcoding within 5 minutes');
}

/** Find a reel published since `sinceMs`. Returns its permalink, or null. */
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

async function publishContainer(igUserId, token, containerId, log) {
  const startedAt = Date.now() - 120000; // tolerate clock skew
  let reported = null;

  const res = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: containerId, access_token: token }),
  });
  const json = await res.json();
  if (json.error) {
    reported = json.error.message;
    log(`  · publish reported: ${reported}`);
  }

  // Confirm against the feed either way — a reported error does NOT mean it failed,
  // and retrying publish on that error is what causes duplicate posts.
  await sleep(15000);
  for (let i = 0; i < 6; i++) {
    const permalink = await findRecentReel(igUserId, token, startedAt);
    if (permalink) return permalink;
    await sleep(10000);
  }
  throw new Error(reported ? explainMediaError(reported) : 'Published, but the reel never appeared in the feed.');
}

/**
 * Publish an already-hosted reel.
 * @returns {Promise<string>} permalink
 */
async function publishHosted({ videoUrl, caption, igUserId, token, emit }) {
  const log = emit || (() => {});
  const containerId = await createContainer(igUserId, token, videoUrl, caption, log);
  await waitForContainer(containerId, token, log);
  const permalink = await publishContainer(igUserId, token, containerId, log);
  log(`  ✓ live: ${permalink}`);
  return permalink;
}

module.exports = { hostOnPages, publishHosted, readParked, explainMediaError };
