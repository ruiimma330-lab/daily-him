'use strict';

const fs = require('fs');
const path = require('path');

const CHAR_DIR = path.join(__dirname, '..', 'characters');
const ID_RE = /^[a-z0-9_-]{1,32}$/;
const FILE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function exists(id) {
  return ID_RE.test(String(id || '')) && fs.existsSync(path.join(CHAR_DIR, id, 'character.json'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateTierOverrides(tiers) {
  if (!Array.isArray(tiers) || !tiers.length) return 'relationship.tiers must be a non-empty list';
  for (const tier of tiers) {
    if (!tier || typeof tier !== 'object' || !ID_RE.test(String(tier.id || ''))) return 'relationship tier id is invalid';
    if (tier.minScore != null && (!Number.isFinite(tier.minScore) || tier.minScore < 0)) return 'relationship minScore is invalid';
    if (tier.minDaysKnown != null && (!Number.isFinite(tier.minDaysKnown) || tier.minDaysKnown < 0)) return 'relationship minDaysKnown is invalid';
  }
  return '';
}

function validateManifest(dir, manifest) {
  if (!manifest || typeof manifest !== 'object') return 'manifest.json is invalid';
  if (!Number.isInteger(manifest.version) || manifest.version < 1) return 'manifest version is invalid';
  if (!Array.isArray(manifest.files) || !manifest.files.length) return 'manifest files must be a non-empty list';
  const seen = new Set();
  for (const name of manifest.files) {
    if (typeof name !== 'string' || !FILE_RE.test(name) || name === 'manifest.json') return `manifest file name is invalid (${name})`;
    if (seen.has(name)) return `manifest lists ${name} more than once`;
    seen.add(name);
    const file = path.join(dir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return `manifest file is missing (${name})`;
    if (name.endsWith('.json')) {
      try {
        const parsed = readJson(file);
        if (parsed == null || typeof parsed !== 'object') return `${name} is not a JSON object`;
      } catch (_) {
        return `${name} is not valid JSON`;
      }
    } else if (!fs.readFileSync(file, 'utf8').trim()) {
      return `${name} is empty`;
    }
    if (name === 'facts.md') {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => /^\d+\.\s+\S/.test(line));
      if (!lines.length) return 'facts.md has no numbered facts';
    }
    if (name === 'sources.json') {
      const parsed = readJson(file);
      const list = parsed && Array.isArray(parsed.sources) ? parsed.sources : null;
      if (!list) return 'sources.json needs a sources list';
      for (const source of list) {
        if (!source || typeof source.id !== 'string' || !source.id.trim()) return 'sources.json source id is invalid';
        if (source.kind !== 'rss' && source.kind !== 'page' && source.kind !== 'x') return 'sources.json source kind is invalid';
        if (typeof source.url !== 'string' || !/^https?:\/\//.test(source.url)) return 'sources.json source url is invalid';
      }
    }
    if (name === 'fallbacks.json') {
      const parsed = readJson(file);
      const lines = parsed && Array.isArray(parsed.lines) ? parsed.lines : [];
      if (!lines.length) return 'fallbacks.json needs lines';
      for (const line of lines) {
        if (!line || typeof line.ko !== 'string' || !line.ko.trim() || typeof line.zh !== 'string' || !line.zh.trim()) {
          return 'fallbacks.json line is invalid';
        }
      }
    }
  }
  if (manifest.relationship != null) {
    const rel = manifest.relationship;
    if (!rel || typeof rel !== 'object') return 'relationship override is invalid';
    if (rel.tiers != null) {
      const problem = validateTierOverrides(rel.tiers);
      if (problem) return problem;
    }
  }
  return '';
}

function inspect(id) {
  const folder = String(id || '');
  if (!exists(folder)) return { ok: false, online: false, intendedOnline: false, error: 'missing character.json' };
  const dir = path.join(CHAR_DIR, folder);
  let meta;
  try {
    meta = readJson(path.join(dir, 'character.json'));
  } catch (_) {
    return { ok: false, online: false, intendedOnline: true, error: 'character.json is not valid JSON' };
  }
  if (!meta || typeof meta !== 'object' || meta.id !== folder || typeof meta.name !== 'string' || !meta.name.trim()) {
    return { ok: false, online: false, intendedOnline: true, error: 'character.json needs a matching id and name' };
  }
  const intendedOnline = meta.available !== false;
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    if (!intendedOnline) return { ok: true, online: false, intendedOnline: false, placeholder: true, meta, error: '' };
    return { ok: false, online: false, intendedOnline: true, meta, error: 'manifest.json is missing' };
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (_) {
    return { ok: false, online: false, intendedOnline, error: 'manifest.json is not valid JSON' };
  }
  const problem = validateManifest(dir, manifest);
  if (problem) return { ok: false, online: false, intendedOnline, meta, error: problem };
  if (intendedOnline && !manifest.files.includes('persona.md')) {
    return { ok: false, online: false, intendedOnline, meta, manifest, error: 'persona.md is not listed' };
  }
  return { ok: true, online: intendedOnline, intendedOnline, meta, manifest, error: '' };
}

function tierOverrides(id) {
  const report = inspect(id);
  if (!report.ok || !report.manifest || !report.manifest.relationship) return null;
  const tiers = report.manifest.relationship.tiers;
  return Array.isArray(tiers) ? tiers : null;
}

function validateAll() {
  let ids = [];
  try {
    ids = fs.readdirSync(CHAR_DIR).filter((id) => exists(id));
  } catch (_) {
    return;
  }
  for (const id of ids) {
    const report = inspect(id);
    if (!report.ok) console.error(`Character pack offline (${id}): ${report.error}`);
  }
}

validateAll();

module.exports = { CHAR_DIR, exists, inspect, tierOverrides, validateAll };
