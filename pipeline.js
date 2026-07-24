'use strict';
/*
 * Shared pipeline: PhotoRoom studio shots -> ffmpeg reel.
 * Used by both the local web app (agent/server.js) and the GitHub Action (ci/run.js).
 * No third-party deps: relies on Node 18+ global fetch/FormData/Blob + built-in fs/child_process.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${(err || out).slice(0, 400)}`))));
  });
}

// 3 shots: one consistent brand background, different styles. Each attempts its "real" style;
// on error the caller falls back to the proven flat-lay recipe so we always get 3 images.
function styleDefs(bg) {
  return [
    { name: 'flat-lay', params: { removeBackground: 'true', 'background.prompt': bg, 'shadow.mode': 'ai.soft' } },
    { name: 'ghost-mannequin', params: { removeBackground: 'false', 'ghostMannequin.mode': 'ai.auto', 'background.prompt': bg, 'shadow.mode': 'ai.soft' } },
    { name: 'folded', params: { removeBackground: 'true', 'background.prompt': bg + ', garment folded flat, top-down', 'shadow.mode': 'ai.soft' } },
  ];
}
function fallbackParams(bg) {
  return { removeBackground: 'true', 'background.prompt': bg, 'shadow.mode': 'ai.soft' };
}

async function photoroom(apiKey, inputPath, params, outPath) {
  const buf = fs.readFileSync(inputPath);
  const fd = new FormData();
  fd.append('imageFile', new Blob([buf]), path.basename(inputPath));
  for (const [k, v] of Object.entries(params)) fd.append(k, v);
  fd.append('export.format', 'jpeg');
  fd.append('outputSize', '1080x1350');
  const res = await fetch('https://image-api.photoroom.com/v2/edit', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'pr-ai-background-model-version': 'background-studio-beta-2025-03-17' },
    body: fd,
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || ct.includes('application/json')) {
    throw new Error(`PhotoRoom ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

async function buildReel(shotPaths, audioPath, outPath, secondsPerShot, emit) {
  const D = secondsPerShot || 4, XF = 0.6;
  const outDir = path.dirname(outPath);
  const clips = [];
  for (let i = 0; i < shotPaths.length; i++) {
    const clip = path.join(outDir, `clip_${i}.mp4`);
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-t', String(D), '-i', shotPaths[i],
      '-filter_complex',
      '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=25:4,setsar=1[bg];' +
      '[0:v]scale=1000:-2[f];[bg][f]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]',
      '-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-video_track_timescale', '30000', clip]);
    clips.push(clip);
    emit && emit(`  · scene ${i + 1} rendered`);
  }
  const inputs = [];
  clips.forEach(c => inputs.push('-i', c));
  let filter = '', prev = '0:v', acc = D;
  for (let i = 1; i < clips.length; i++) {
    const off = (acc - XF).toFixed(2);
    const lbl = i === clips.length - 1 ? 'v' : `v0${i}`;
    filter += `[${prev}][${i}:v]xfade=transition=fade:duration=${XF}:offset=${off}[${lbl}];`;
    prev = lbl; acc = acc + D - XF;
  }
  filter = filter.replace(/;$/, '');
  const total = acc;
  const silent = path.join(outDir, 'reel_silent.mp4');
  await run('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[v]', '-an',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart', silent]);
  emit && emit('  · scenes joined with crossfades');

  const vArgs = ['-vf', 'scale=in_range=full:out_range=tv,format=yuv420p', '-color_range', 'tv',
    '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-r', '30',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M',
    '-movflags', '+faststart'];
  if (audioPath && fs.existsSync(audioPath)) {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0', '-shortest',
      '-af', `afade=t=out:st=${(total - 1).toFixed(2)}:d=1`, '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      ...vArgs, outPath]);
    emit && emit('  · audio track added');
  } else {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-map', '0:v:0', '-map', '1:a:0', '-shortest', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      ...vArgs, outPath]);
    emit && emit('  · silent audio track added (add music when posting)');
  }
  return { total };
}

/**
 * Run the full pipeline.
 * @param {object} o
 * @param {string} o.imagePath  source product photo
 * @param {string} o.outDir     directory for shot_*.jpg and reel.mp4
 * @param {object} o.config     { photoroomKey, brandBg, reelAudio, secondsPerShot }
 * @param {function} [o.emit]   progress callback(line)
 * @returns {Promise<{shotPaths:string[], reelPath:string}>}
 */
async function runPipeline({ imagePath, outDir, config, emit }) {
  fs.mkdirSync(outDir, { recursive: true });
  const bg = config.brandBg || 'a clean minimal light neutral studio background, soft even lighting';
  const styles = styleDefs(bg);
  const shotPaths = [];
  emit && emit('▶ Step 1 — PhotoRoom studio shots');
  for (let i = 0; i < styles.length; i++) {
    const outP = path.join(outDir, `shot_${i + 1}.jpg`);
    try {
      await photoroom(config.photoroomKey, imagePath, styles[i].params, outP);
      emit && emit(`  ✓ shot ${i + 1} (${styles[i].name})`);
    } catch (e) {
      emit && emit(`  ! ${styles[i].name} failed — flat-lay fallback`);
      await photoroom(config.photoroomKey, imagePath, fallbackParams(bg), outP);
      emit && emit(`  ✓ shot ${i + 1} (flat-lay fallback)`);
    }
    shotPaths.push(outP);
  }
  emit && emit('▶ Step 2 — building reel');
  const reelPath = path.join(outDir, 'reel.mp4');
  await buildReel(shotPaths, config.reelAudio, reelPath, config.secondsPerShot, emit);
  emit && emit('  ✓ reel built');
  return { shotPaths, reelPath };
}

module.exports = { runPipeline, buildReel, photoroom, styleDefs, fallbackParams };
