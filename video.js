'use strict';
/*
 * Video template engine — the CapCut-style automatic edit.
 *
 * You send a clip of yourself holding the shirt. This turns it into a finished
 * vertical reel: reframed to 9:16, trimmed, colour-graded, with a hook line at
 * the start and a call to action at the end, encoded to the exact format
 * Instagram accepts.
 *
 * The reel is SILENT on purpose. Your original sound is dropped and replaced
 * with a silent track, because Instagram REQUIRES an audio track or it refuses
 * to process the video. You then add a trending sound in the Instagram app,
 * which is the only way a sound counts as trending. See ci/run.js.
 *
 * About emoji: ffmpeg cannot draw colour emoji. A normal font shows an empty
 * box and an emoji font shows a flat white outline, both of which look broken.
 * So burned-in text is plain text only. Put your emoji in the caption, where
 * Instagram renders them properly in colour.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const W = 1080, H = 1920;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`))));
  });
}

/** Seconds of video, as a number. */
function probeDuration(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' });
  const d = parseFloat(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error('Could not read the video length.');
  return d;
}

/**
 * Finds a bold font that exists on this machine.
 * The GitHub runner and a Windows PC have different fonts, so we look for
 * whichever is present instead of hard-coding one and breaking in the other.
 */
function findFont() {
  const candidates = [
    path.join(__dirname, 'assets', 'font.ttf'),            // ship your own to override
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', // GitHub Actions
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf',                         // Windows
    'C:/Windows/Fonts/segoeuib.ttf',
  ];
  const hit = candidates.find(f => { try { return fs.existsSync(f); } catch (e) { return false; } });
  if (!hit) throw new Error('No bold font found. Put one at tt-assets/assets/font.ttf');
  return hit;
}

/**
 * A Windows font path contains a colon ("C:/..."), and a colon is what ffmpeg
 * uses to separate filter options. Left as-is it silently breaks the whole
 * filter, so it has to be escaped.
 */
function escapeFontPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}

/** ffmpeg's drawtext has its own escaping rules; get them wrong and it won't parse. */
function escapeText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")   // straight quote breaks the filter; use a curly one
    .replace(/%/g, '\\%');
}

/** Emoji and other symbols ffmpeg cannot draw. Stripped so they never show as boxes. */
function stripUndrawable(s) {
  return String(s)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One text overlay that fades in, holds, then fades out.
 * `from` and `to` are seconds.
 */
function textLayer({ text, from, to, y, fontFile, size = 74 }) {
  const clean = stripUndrawable(text);
  if (!clean) return null;
  const F = 0.35; // fade length
  const alpha =
    `if(lt(t,${from}),0,` +
      `if(lt(t,${(from + F).toFixed(2)}),(t-${from})/${F},` +
        `if(lt(t,${(to - F).toFixed(2)}),1,` +
          `if(lt(t,${to}),(${to}-t)/${F},0))))`;

  return `drawtext=fontfile='${escapeFontPath(fontFile)}':text='${escapeText(clean)}'` +
    `:fontcolor=white:fontsize=${size}:x=(w-tw)/2:y=${y}` +
    `:box=1:boxcolor=black@0.42:boxborderw=26` +
    `:alpha='${alpha}'`;
}

const TEMPLATES = {
  // The default. Clean and calm — lets the garment be the subject.
  showcase: { maxSeconds: 30, contrast: 1.06, saturation: 1.10, sharpen: true, hookSeconds: 2.8, ctaSeconds: 3.2 },
  // Punchier grade for busier clips.
  punchy:   { maxSeconds: 22, contrast: 1.12, saturation: 1.20, sharpen: true, hookSeconds: 2.4, ctaSeconds: 3.0 },
  // No grade at all, if your lighting is already right.
  plain:    { maxSeconds: 45, contrast: 1.00, saturation: 1.00, sharpen: false, hookSeconds: 2.8, ctaSeconds: 3.2 },
};

/**
 * Renders the finished reel.
 * @returns {Promise<{outPath:string, duration:number, template:string}>}
 */
async function editVideo({ inputPath, outPath, template = 'showcase', hook = '', cta = '', emit = () => {} }) {
  if (!fs.existsSync(inputPath)) throw new Error('Video not found: ' + inputPath);
  const tpl = TEMPLATES[template];
  if (!tpl) throw new Error(`Unknown template "${template}". Try: ${Object.keys(TEMPLATES).join(', ')}`);

  const fontFile = findFont();
  const sourceLen = probeDuration(inputPath);
  const duration = Math.min(sourceLen, tpl.maxSeconds);
  emit(`  · source ${sourceLen.toFixed(1)}s → keeping ${duration.toFixed(1)}s [${template}]`);
  if (sourceLen > tpl.maxSeconds) emit(`  · trimmed to ${tpl.maxSeconds}s (shorter reels hold attention better)`);

  // Reframe to 9:16. A blurred, darkened copy fills the screen behind, and the
  // real clip sits centred on top. This is the same look as the photo reels,
  // so the feed stays consistent whichever path a post came from.
  const chain = [
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=30:5,eq=brightness=-0.08,setsar=1[bg]`,
    `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,setsar=1[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`,
  ];

  let last = 'base';
  if (tpl.contrast !== 1 || tpl.saturation !== 1) {
    chain.push(`[${last}]eq=contrast=${tpl.contrast}:saturation=${tpl.saturation}[graded]`);
    last = 'graded';
  }
  if (tpl.sharpen) {
    chain.push(`[${last}]unsharp=5:5:0.5:5:5:0.0[sharp]`);
    last = 'sharp';
  }

  const layers = [
    textLayer({ text: hook, from: 0.2, to: tpl.hookSeconds, y: 210, fontFile, size: 78 }),
    textLayer({ text: cta, from: Math.max(0.5, duration - tpl.ctaSeconds), to: duration, y: H - 380, fontFile, size: 70 }),
  ].filter(Boolean);

  const fades = `fade=t=in:st=0:d=0.35,fade=t=out:st=${(duration - 0.5).toFixed(2)}:d=0.5`;
  // Forcing tv colour range is not optional. Instagram rejects or mangles
  // full-range video, and the -color_range flag alone does not convert it —
  // the scale filter has to do the conversion. Same recipe as the photo reels.
  // Colour tagging, and every part of this is required — tested, not guessed.
  // With -filter_complex the -color_range flag alone leaves the stream tagged
  // "unknown", which is exactly what Instagram mishandles. scale converts the
  // pixels, setparams labels them, and the encoder flags below write the tags
  // into the file. Dropping any one of the three puts it back to "unknown".
  const colour = 'scale=in_range=full:out_range=tv,' +
    'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
  const tail = [...layers, fades, colour, 'format=yuv420p'].join(',');
  chain.push(`[${last}]${tail}[v]`);

  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-t', String(duration), '-i', inputPath,
    // Silent stereo track. Instagram refuses a reel with no audio stream at all.
    '-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', chain.join(';'),
    '-map', '[v]', '-map', '1:a',
    // 'fast' rather than 'medium': at 6 Mbps for 1080x1920 the difference is not
    // visible, and it cuts roughly a third off the render time on a CI runner.
    '-c:v', 'libx264', '-profile:v', 'main', '-level', '4.0', '-preset', 'fast',
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-b:v', '6M', '-maxrate', '8M', '-bufsize', '12M',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '128k',
    '-movflags', '+faststart', '-shortest',
    outPath,
  ]);

  emit(`  ✓ video edited (${duration.toFixed(1)}s, silent — add a sound in Instagram)`);
  return { outPath, duration, template };
}

module.exports = { editVideo, TEMPLATES, probeDuration, findFont };
