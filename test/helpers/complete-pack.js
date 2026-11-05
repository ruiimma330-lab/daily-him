'use strict';
const fs = require('fs');
const path = require('path');
const { REQUIRED_FILES } = require('../../lib/character-pack');
// Complete synthetic test packs without overwriting their test-specific persona/metadata.
module.exports = function completePack(dir) {
  const defaults = {
    'facts.md': '1. Synthetic test character.\n',
    'catchphrases.md': 'Test phrase.\n',
    'scenes.json': '{"scenes":[]}',
    'moments.json': '{"posts":[]}',
    'fallbacks.json': '{"lines":[{"ko":"잠깐 기다려 줘.","zh":"请稍等。"}]}',
    'sources.json': '{"sources":[]}',
  };
  for (const [name, body] of Object.entries(defaults)) {
    if (!fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), body);
  }
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.files = [...new Set([...manifest.files, ...REQUIRED_FILES])];
  fs.writeFileSync(file, JSON.stringify(manifest));
};
