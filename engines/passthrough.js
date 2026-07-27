'use strict';
/*
 * Passthrough engine — no AI at all.
 *
 * You already edited the photo yourself in the PhotoRoom mobile app, so the
 * pipeline must NOT edit it again. This engine simply takes your picture and
 * prepares it for posting: it keeps the exact picture you sent, keeps its shape,
 * and saves it at high quality.
 *
 * The only change it makes is to cap the size, because Telegram and Instagram
 * both reject very large files. Nothing is cropped and nothing is recoloured.
 *
 * Uses ffmpeg, which the pipeline already needs, so there is no new dependency.
 */
const fs = require('fs');
const { spawn } = require('child_process');

const MAX_LONG_SIDE = 2048; // plenty for Instagram; keeps files small enough to send

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`))));
  });
}

/**
 * Copies your photo through at high quality.
 * `style` and `bg` are accepted so this engine can be swapped in wherever the
 * AI engines are used, but they are deliberately ignored — this engine never
 * changes what your picture shows.
 */
async function makeShot(inputPath, style, bg, outPath, config) {
  if (!fs.existsSync(inputPath)) throw new Error('Input photo not found: ' + inputPath);

  // Shrink only if the picture is bigger than the cap. Never enlarge.
  const scale = `scale='if(gt(max(iw,ih),${MAX_LONG_SIDE}),if(gt(iw,ih),${MAX_LONG_SIDE},-2),iw)':` +
                `'if(gt(max(iw,ih),${MAX_LONG_SIDE}),if(gt(iw,ih),-2,${MAX_LONG_SIDE}),ih)'`;

  await run('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', inputPath,
    '-vf', scale + ',format=yuvj420p',
    '-q:v', '2',          // near-lossless JPEG
    '-pix_fmt', 'yuvj420p',
    outPath,
  ]);

  if (!fs.existsSync(outPath)) throw new Error('Passthrough produced no file for ' + style);
}

module.exports = { makeShot };
