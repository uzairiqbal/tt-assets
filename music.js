'use strict';
/*
 * Music library for the reel.
 *
 * Drop your tracks into  tt-assets/assets/music/  and the pipeline picks one at
 * random for every reel, so your feed does not always sound the same.
 *
 * IMPORTANT, please read:
 *   1. This repository is PUBLIC. Anything you put in the music folder is
 *      published on the internet for anyone to download.
 *   2. Only put music in there that you are allowed to publish — music you own,
 *      or royalty-free tracks whose licence permits it. Do not put songs from
 *      Instagram, TikTok, YouTube or Spotify in there.
 *   3. If you would rather add music inside Instagram when posting, simply leave
 *      the folder empty. The reel is then built silent, and Instagram lets you
 *      add any track from its own library, which is always safe.
 */
const fs = require('fs');
const path = require('path');

const AUDIO_TYPES = ['.mp3', '.m4a', '.aac', '.wav', '.ogg'];

function musicDir() {
  return path.join(__dirname, 'assets', 'music');
}

/**
 * Lists every usable track in the music folder.
 */
function listMusic(dir = musicDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => AUDIO_TYPES.includes(path.extname(f).toLowerCase()))
    .map(f => path.join(dir, f))
    .sort();
}

/**
 * Picks one track at random. Returns '' when the folder is empty, which tells
 * the pipeline to build a silent reel.
 */
function pickMusic(dir = musicDir()) {
  const tracks = listMusic(dir);
  if (!tracks.length) return '';
  return tracks[Math.floor(Math.random() * tracks.length)];
}

module.exports = { pickMusic, listMusic, musicDir };
