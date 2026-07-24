'use strict';
const fs = require('fs');
const path = require('path');

async function makeShot(inputPath, style, bg, outPath, config) {
  if (!config.photoroomKey) throw new Error('PHOTOROOM_API_KEY not configured');
  const buf = fs.readFileSync(inputPath);
  const fd = new FormData();
  fd.append('imageFile', new Blob([buf]), path.basename(inputPath));
  const params = styleParams(style, bg);
  for (const [k, v] of Object.entries(params)) fd.append(k, v);
  fd.append('export.format', 'jpeg');
  fd.append('outputSize', '1080x1350');
  const res = await fetch('https://image-api.photoroom.com/v2/edit', {
    method: 'POST',
    headers: {
      'x-api-key': config.photoroomKey,
      'pr-ai-background-model-version': 'background-studio-beta-2025-03-17',
    },
    body: fd,
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || ct.includes('application/json')) {
    const msg = (await res.text()).slice(0, 300);
    const err = new Error(`PhotoRoom ${res.status}: ${msg}`);
    if (res.status === 402 || res.status === 429 || /credit|quota|limit/i.test(msg)) {
      err.quotaExhausted = true;
    }
    throw err;
  }
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

function styleParams(style, bg) {
  switch (style) {
    case 'ghost-mannequin':
      return { removeBackground: 'false', 'ghostMannequin.mode': 'ai.auto', 'background.prompt': bg, 'shadow.mode': 'ai.soft' };
    case 'folded':
      return { removeBackground: 'true', 'background.prompt': bg + ', garment folded flat, top-down', 'shadow.mode': 'ai.soft' };
    default:
      return { removeBackground: 'true', 'background.prompt': bg, 'shadow.mode': 'ai.soft' };
  }
}

module.exports = { makeShot };
