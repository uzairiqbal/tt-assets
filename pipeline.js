'use strict';
/*
 * Shared pipeline: prepare the product shots -> build a professional reel.
 *
 * ENGINES
 *   'passthrough' (DEFAULT) — no AI. You already edited the photo yourself in
 *                             the PhotoRoom mobile app, so the pipeline keeps
 *                             your exact picture and only prepares it.
 *   'photoroom'             — PhotoRoom API. PAUSED: the key has no credits.
 *   'gemini'                — Gemini image-to-image. Needs billing switched on.
 *   'local'                 — free rembg + sharp. Weakest quality.
 *
 * The AI engines are left in place so they can be switched back on later by
 * setting ENGINE in the environment. Nothing was deleted.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pickMusic } = require('./music.js');

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

const STYLES = ['flat-lay', 'ghost-mannequin', 'folded'];

// The reel is always three scenes. When only one picture is available, the same
// picture is used for all three but each scene gets a different camera move, so
// the reel still feels alive instead of being a frozen photo for twelve seconds.
const SCENES = 3;
const MOTIONS = ['zoom-in', 'zoom-out', 'pan-down'];

function loadEngine(name) {
  return require(`./engines/${name}.js`);
}

async function runPipeline({ imagePath, outDir, config, emit }) {
  fs.mkdirSync(outDir, { recursive: true });
  const bg = config.brandBg || 'a clean minimal light neutral studio background, soft even lighting';
  const requestedEngine = config.engine || 'passthrough';

  const shotPaths = requestedEngine === 'passthrough'
    ? await passthroughShots(imagePath, outDir, emit)
    : await aiShots(imagePath, outDir, bg, requestedEngine, config, emit);

  emit && emit('▶ Step 2 — building reel');
  const audio = config.reelAudio || pickMusic();
  const reelPath = path.join(outDir, 'reel.mp4');
  await buildReel(shotPaths, audio, reelPath, config.secondsPerShot, emit, config.musicVolume);
  emit && emit('  ✓ reel built');
  return { shotPaths, reelPath };
}

/**
 * No AI. Your picture, kept as it is, at high quality.
 * Returns a single shot — there is no point sending three copies of one photo.
 */
async function passthroughShots(imagePath, outDir, emit) {
  emit && emit('▶ Step 1 — preparing your photo [engine: passthrough, no AI]');
  const outP = path.join(outDir, 'shot_1.jpg');
  await loadEngine('passthrough').makeShot(imagePath, 'as-sent', '', outP, {});
  emit && emit('  ✓ your photo kept as sent, at high quality');
  return [outP];
}

/**
 * The original AI path: three different styles from one photo.
 * Kept intact for when PhotoRoom or Gemini is switched back on.
 */
async function aiShots(imagePath, outDir, bg, requestedEngine, config, emit) {
  let primary = requestedEngine === 'auto' ? 'photoroom' : requestedEngine;
  let canFallback = requestedEngine === 'auto';

  emit && emit(`▶ Step 1 — studio shots [engine: ${primary}]`);

  const shotPaths = [];
  for (let i = 0; i < STYLES.length; i++) {
    const style = STYLES[i];
    const outP = path.join(outDir, `shot_${i + 1}.jpg`);
    let made = false;

    try {
      await loadEngine(primary).makeShot(imagePath, style, bg, outP, config);
      emit && emit(`  ✓ shot ${i + 1} (${style}) [${primary}]`);
      made = true;
    } catch (e) {
      const isQuota = e.quotaExhausted || /402|429/i.test(e.message);
      if (isQuota && canFallback) {
        emit && emit(`  ⚠ ${primary} credits exhausted — switching to free local engine`);
        primary = 'local';
        canFallback = false;
        try {
          await loadEngine(primary).makeShot(imagePath, style, bg, outP, config);
          emit && emit(`  ✓ shot ${i + 1} (${style}) [${primary}]`);
          made = true;
        } catch (e2) {
          emit && emit(`  ! ${style} failed on local engine — flat-lay fallback`);
        }
      } else {
        emit && emit(`  ! ${style} failed (${e.message.slice(0, 80)}) — flat-lay fallback`);
      }
    }

    if (!made) {
      try {
        await loadEngine(primary).makeShot(imagePath, 'flat-lay', bg, outP, config);
        emit && emit(`  ✓ shot ${i + 1} (flat-lay fallback) [${primary}]`);
      } catch (fe) {
        throw new Error(`Shot ${i + 1} flat-lay fallback failed [engine: ${primary}]: ${fe.message}`);
      }
    }

    shotPaths.push(outP);
  }
  return shotPaths;
}

/**
 * Builds one scene: a blurred, slightly darkened copy of the photo fills the
 * screen behind, the real photo sits centred and sharp on top, and a slow
 * camera move runs across the whole frame. This is the template that makes it
 * look made rather than generated.
 */
function sceneFilter(motion) {
  const backdrop =
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,' +
    'boxblur=28:5,eq=brightness=-0.05,setsar=1[bg];' +
    '[0:v]scale=960:1400:force_original_aspect_ratio=decrease,setsar=1[fg];' +
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[comp];';

  const moves = {
    'zoom-in':  "z='min(zoom+0.0012,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    'zoom-out': "z='if(eq(on,0),1.12,max(zoom-0.0012,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
    'pan-down': "z=1.09:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(on/119)'",
  };
  const move = moves[motion] || moves['zoom-in'];

  return backdrop + `[comp]zoompan=${move}:d=1:s=1080x1920:fps=30,format=yuv420p[v]`;
}

// How loud the baked-in music is. 1.0 is full volume. This is deliberately low:
// the track should sit quietly under the reel, not compete with it.
const DEFAULT_MUSIC_VOLUME = 0.12;

async function buildReel(shotPaths, audioPath, outPath, secondsPerShot, emit, musicVolume) {
  const D = secondsPerShot || 4, XF = 0.6;
  const vol = Number.isFinite(parseFloat(musicVolume)) ? parseFloat(musicVolume) : DEFAULT_MUSIC_VOLUME;
  const outDir = path.dirname(outPath);

  // Render each scene. Pictures are reused in order when there are fewer
  // pictures than scenes, but the camera move always changes.
  const clips = [];
  for (let i = 0; i < SCENES; i++) {
    const image = shotPaths[i % shotPaths.length];
    const motion = MOTIONS[i % MOTIONS.length];
    const clip = path.join(outDir, `clip_${i}.mp4`);
    await run('ffmpeg', ['-y', '-loglevel', 'error',
      '-loop', '1', '-framerate', '30', '-t', String(D), '-i', image,
      '-filter_complex', sceneFilter(motion),
      '-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-r', '30', '-video_track_timescale', '30000', clip]);
    clips.push(clip);
    emit && emit(`  · scene ${i + 1} rendered (${motion})`);
  }

  // Join with crossfades.
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

  // Instagram is strict about the video format. These settings are the ones
  // proven to work — do not loosen them without testing a real post.
  // A short fade from and to black tops and tails the reel.
  const vf = 'scale=in_range=full:out_range=tv,format=yuv420p,' +
             `fade=t=in:st=0:d=0.4,fade=t=out:st=${(total - 0.5).toFixed(2)}:d=0.5`;
  const vArgs = ['-vf', vf, '-color_range', 'tv',
    '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-r', '30',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M',
    '-movflags', '+faststart'];

  if (audioPath && fs.existsSync(audioPath)) {
    // -stream_loop repeats the track if it is shorter than the reel.
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent,
      '-stream_loop', '-1', '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0', '-shortest',
      '-af', `volume=${vol},afade=t=in:st=0:d=0.8,afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2`,
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      ...vArgs, outPath]);
    emit && emit(`  · music added at ${Math.round(vol * 100)}% volume: ` + path.basename(audioPath));
  } else {
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-map', '0:v:0', '-map', '1:a:0', '-shortest', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
      ...vArgs, outPath]);
    emit && emit('  · no music in the library — silent reel (add music in Instagram)');
  }
  return { total };
}

// Legacy exports kept for older callers.
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

module.exports = { runPipeline, buildReel, styleDefs, fallbackParams, SCENES, MOTIONS };
