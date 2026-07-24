'use strict';
/*
 * Free local engine: rembg (Python CLI) for background removal + sharp for compositing.
 * No API key required. Runs on GitHub Actions ubuntu-latest after:
 *   pip install "rembg[cli]" onnxruntime
 *   npm install   (for sharp)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const W = 1080, H = 1350;

async function makeShot(inputPath, style, bg, outPath, config) {
  let sharp;
  try { sharp = require('sharp'); }
  catch { throw new Error('sharp not installed — run: npm install (in tt-assets/)'); }

  const tmpDir = path.dirname(outPath);
  const pngPath = path.join(tmpDir, `cutout_${style}_${Date.now()}.png`);

  removeBg(inputPath, pngPath);
  await compose(sharp, pngPath, style, bg, outPath);

  try { fs.unlinkSync(pngPath); } catch (_) {}
}

function removeBg(inputPath, pngPath) {
  const attempts = [
    ['rembg', ['i', inputPath, pngPath]],
    ['python', ['-m', 'rembg', 'i', inputPath, pngPath]],
    ['python3', ['-m', 'rembg', 'i', inputPath, pngPath]],
  ];
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { stdio: 'pipe', timeout: 120000 });
    if (r.status === 0 && fs.existsSync(pngPath)) return;
  }
  throw new Error('rembg not available — install with: pip install "rembg[cli]" onnxruntime');
}

function parseBgColor(prompt) {
  const p = (prompt || '').toLowerCase();
  if (p.includes('dark') || p.includes('charcoal') || p.includes('black')) return { r: 32, g: 32, b: 35 };
  if (p.includes('beige') || p.includes('warm') || p.includes('cream')) return { r: 242, g: 236, b: 224 };
  if (p.includes('sage') || p.includes('green')) return { r: 220, g: 228, b: 218 };
  if (p.includes('grey') || p.includes('gray')) return { r: 215, g: 215, b: 215 };
  return { r: 246, g: 246, b: 248 };
}

async function compose(sharp, cutoutPath, style, bg, outPath) {
  const c = parseBgColor(bg);
  const d = { r: Math.max(0, c.r - 25), g: Math.max(0, c.g - 25), b: Math.max(0, c.b - 25) };

  const gradSvg = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgb(${c.r},${c.g},${c.b})"/>
        <stop offset="100%" stop-color="rgb(${d.r},${d.g},${d.b})"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
  </svg>`);

  let resized, top, left;
  switch (style) {
    case 'ghost-mannequin': {
      resized = await sharp(cutoutPath).resize(880, 1200, { fit: 'inside' }).toBuffer();
      const m = await sharp(resized).metadata();
      top = Math.round((H - m.height) / 2);
      left = Math.round((W - m.width) / 2);
      break;
    }
    case 'folded': {
      resized = await sharp(cutoutPath).resize(720, 600, { fit: 'inside' }).toBuffer();
      const m = await sharp(resized).metadata();
      top = Math.round(H * 0.18);
      left = Math.round((W - m.width) / 2);
      break;
    }
    default: {
      resized = await sharp(cutoutPath).resize(W - 60, H - 120, { fit: 'inside' }).toBuffer();
      const m = await sharp(resized).metadata();
      top = Math.round((H - m.height) / 2);
      left = Math.round((W - m.width) / 2);
    }
  }

  const fm = await sharp(resized).metadata();
  const shW = Math.round(fm.width * 0.85);
  const shH = Math.max(20, Math.round(fm.height * 0.06));
  const shadowSvg = Buffer.from(`<svg width="${shW}" height="${shH + 20}" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="${shW / 2}" cy="${shH}" rx="${shW / 2}" ry="${Math.round(shH * 0.6)}" fill="rgba(0,0,0,0.20)"/>
  </svg>`);
  const shadow = await sharp(shadowSvg).blur(14).png().toBuffer();
  const shLeft = Math.max(0, left + Math.round((fm.width - shW) / 2));
  const shTop = Math.max(0, Math.min(top + fm.height - Math.round(shH * 0.5), H - shH - 10));

  const bgBuf = await sharp(gradSvg).png().toBuffer();
  await sharp(bgBuf)
    .composite([
      { input: shadow, top: shTop, left: shLeft, blend: 'multiply' },
      { input: resized, top: Math.max(0, top), left: Math.max(0, left) },
    ])
    .jpeg({ quality: 92 })
    .toFile(outPath);
}

module.exports = { makeShot };
