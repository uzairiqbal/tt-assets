'use strict';
/*
 * Gemini image-to-image engine.
 * Requires GEMINI_API_KEY secret + billing enabled in Google AI Studio.
 * Best for ghost-mannequin (generative, no rembg needed).
 */
const fs = require('fs');

async function makeShot(inputPath, style, bg, outPath, config) {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY secret not set');

  const base64 = fs.readFileSync(inputPath).toString('base64');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${config.geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: stylePrompt(style, bg) },
          { inline_data: { mime_type: 'image/jpeg', data: base64 } },
        ]}],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
    }
  );

  if (!res.ok) {
    const msg = (await res.text()).slice(0, 300);
    const err = new Error(`Gemini ${res.status}: ${msg}`);
    if (res.status === 429 || /quota/i.test(msg)) err.quotaExhausted = true;
    throw err;
  }

  const json = await res.json();
  const part = json.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
  if (!part) throw new Error('Gemini returned no image — check billing is enabled');

  fs.writeFileSync(outPath, Buffer.from(part.inlineData.data, 'base64'));
}

function stylePrompt(style, bg) {
  const backdrop = bg || 'clean minimal studio background, soft even lighting';
  switch (style) {
    case 'ghost-mannequin':
      return `Professional product photography: render this garment as a ghost mannequin shot. The shirt is fully 3D and upright as if worn, but the mannequin is completely invisible. ${backdrop}. E-commerce quality, 4:3 portrait format.`;
    case 'folded':
      return `Professional product photography: show this garment neatly folded into a clean stack, photographed from slightly above. ${backdrop}. E-commerce quality.`;
    default:
      return `Professional product photography: flat lay of this garment, perfectly spread and arranged, top-down view. ${backdrop}. E-commerce quality.`;
  }
}

module.exports = { makeShot };
