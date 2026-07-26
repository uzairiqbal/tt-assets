'use strict';
/*
 * TikTok Content Posting API — publish phase.
 *
 * Uses the FILE_UPLOAD source (no domain verification needed). The reel is
 * downloaded from GitHub Pages then uploaded directly to TikTok in one chunk
 * (reels are typically 2–15 MB, well under the 64 MB single-chunk threshold).
 *
 * Post mode is controlled by TIKTOK_POST_MODE env var:
 *   MEDIA_UPLOAD  (default) — drops into user's TikTok inbox as a draft;
 *                             user taps the inbox notification and publishes manually.
 *                             Works without audit approval. Posts are public.
 *   DIRECT_POST   — publishes immediately as public. Requires TikTok audit approval;
 *                   until approved, posts are forced to SELF_ONLY private.
 *
 * Token rotation: TikTok issues a NEW refresh_token on every token refresh, and the
 * old one expires immediately. To keep the chain alive, this module writes the new
 * refresh_token back into the TIKTOK_REFRESH_TOKEN GitHub Actions secret after every
 * successful refresh. Requires GH_SECRETS_TOKEN (fine-grained PAT, secrets:write on
 * uzairiqbal/tt-assets).
 */

const TIKTOK_API = 'https://open.tiktokapis.com/v2';
const GH_API = 'https://api.github.com';
const REPO = 'uzairiqbal/tt-assets';

async function refreshAccessToken(clientKey, clientSecret, refreshToken) {
  const res = await fetch(`${TIKTOK_API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const j = await res.json();
  if (j.error && j.error !== 'ok') {
    throw new Error(`TikTok token refresh failed: ${j.error_description || j.error}`);
  }
  if (!j.access_token) throw new Error('TikTok token refresh: no access_token returned');
  return { accessToken: j.access_token, newRefreshToken: j.refresh_token };
}

async function rotateRefreshToken(newToken, ghSecretsToken) {
  // GitHub requires the value to be encrypted with the repo's libsodium public key.
  let sodium;
  try { sodium = require('tweetsodium'); } catch {
    throw new Error('tweetsodium not installed — run npm ci in tt-assets');
  }

  const pkRes = await fetch(`${GH_API}/repos/${REPO}/actions/public-key`, {
    headers: { Authorization: `Bearer ${ghSecretsToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'tt-reel-bot' },
  });
  if (!pkRes.ok) throw new Error(`Could not fetch GitHub public key: HTTP ${pkRes.status}`);
  const { key, key_id } = await pkRes.json();

  const keyBytes = Buffer.from(key, 'base64');
  const msgBytes = Buffer.from(newToken, 'utf8');
  const encrypted = Buffer.from(sodium.seal(msgBytes, keyBytes)).toString('base64');

  const putRes = await fetch(`${GH_API}/repos/${REPO}/actions/secrets/TIKTOK_REFRESH_TOKEN`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${ghSecretsToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'tt-reel-bot',
    },
    body: JSON.stringify({ encrypted_value: encrypted, key_id }),
  });
  if (putRes.status !== 201 && putRes.status !== 204) {
    throw new Error(`GitHub secret update failed: HTTP ${putRes.status}`);
  }
}

async function uploadReel(videoUrl, accessToken, postMode, caption) {
  // Download the reel from GitHub Pages
  const dlRes = await fetch(videoUrl);
  if (!dlRes.ok) throw new Error(`Failed to download reel: HTTP ${dlRes.status}`);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  const size = buf.length;

  // Determine the init endpoint based on post mode
  const initPath = postMode === 'DIRECT_POST'
    ? '/post/publish/video/init/'
    : '/post/publish/inbox/video/init/';

  // Chunk strategy: single chunk (reels < 64 MB)
  const chunkSize = size; // single chunk

  const initBody = {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: size,
      chunk_size: chunkSize,
      total_chunk_count: 1,
    },
  };

  // DIRECT_POST requires post_info; MEDIA_UPLOAD (inbox) does not
  if (postMode === 'DIRECT_POST') {
    initBody.post_info = {
      title: caption.slice(0, 2200),
      privacy_level: 'PUBLIC_TO_EVERYONE',
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
      video_cover_timestamp_ms: 1000,
    };
  }

  const initRes = await fetch(`${TIKTOK_API}${initPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(initBody),
  });
  const initJ = await initRes.json();
  if (initJ.error && initJ.error.code && initJ.error.code !== 'ok') {
    throw new Error(`TikTok init error: ${initJ.error.message} (${initJ.error.code})`);
  }
  const { publish_id, upload_url } = initJ.data || {};
  if (!publish_id || !upload_url) throw new Error(`TikTok init: unexpected response — ${JSON.stringify(initJ)}`);

  // Upload the single chunk
  const putRes = await fetch(upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes 0-${size - 1}/${size}`,
      'Content-Length': String(size),
    },
    body: buf,
  });
  if (putRes.status !== 201 && putRes.status !== 206) {
    throw new Error(`TikTok chunk upload failed: HTTP ${putRes.status}`);
  }

  return publish_id;
}

async function pollStatus(publishId, accessToken, emit) {
  for (let i = 0; i < 36; i++) { // 36 × 5s = 3 min
    await new Promise(r => setTimeout(r, 5000));
    const res = await fetch(`${TIKTOK_API}/post/publish/status/fetch/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
    const j = await res.json();
    if (j.error && j.error.code && j.error.code !== 'ok') {
      throw new Error(`TikTok status error: ${j.error.message} (${j.error.code})`);
    }
    const status = j.data && j.data.status;
    emit && emit(`  · TikTok: ${status}`);

    if (status === 'SEND_TO_USER_INBOX') {
      return { status, note: 'Draft ready in TikTok inbox — open the app and tap to publish' };
    }
    if (status === 'PUBLISH_COMPLETE') {
      return { status, note: 'Published to TikTok' };
    }
    if (status === 'FAILED') {
      const reason = JSON.stringify((j.data && j.data.fail_reason) || j.data);
      throw new Error(`TikTok processing failed: ${reason}`);
    }
    // PROCESSING_UPLOAD, PROCESSING_DOWNLOAD — keep polling
  }
  throw new Error('TikTok status poll timed out (3 min)');
}

async function publishToTikTok({ videoUrl, caption, clientKey, clientSecret, refreshToken, ghSecretsToken, emit }) {
  emit && emit('▶ TikTok: refreshing token…');
  const { accessToken, newRefreshToken } = await refreshAccessToken(clientKey, clientSecret, refreshToken);

  // Rotate the refresh token in GitHub Secrets immediately after refresh.
  // Old token is already dead — if this write fails we still proceed, but log it.
  if (ghSecretsToken && newRefreshToken) {
    try {
      await rotateRefreshToken(newRefreshToken, ghSecretsToken);
      emit && emit('  ✓ TikTok: refresh token rotated');
    } catch (e) {
      emit && emit(`  ⚠ TikTok: refresh token rotation failed — ${e.message}`);
      emit && emit('    ⚠ Re-run get-tiktok-token.js to reset before next post');
    }
  }

  const postMode = (process.env.TIKTOK_POST_MODE || 'MEDIA_UPLOAD').toUpperCase();
  emit && emit(`▶ TikTok: uploading reel (${postMode})…`);
  const publishId = await uploadReel(videoUrl, accessToken, postMode, caption);

  emit && emit('▶ TikTok: waiting for processing…');
  return pollStatus(publishId, accessToken, emit);
}

module.exports = { publishToTikTok };
