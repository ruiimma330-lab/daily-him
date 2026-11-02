'use strict';

// Chat turns sent to the model come from the account×character record on the
// server. The request body only supplies the new line, never a transcript.
function fromHistory(stored, text) {
  const current = String(text || '').trim().slice(0, 4000);
  if (!current) return null;
  const recent = [];
  const list = Array.isArray(stored) ? stored : [];
  for (const item of list.slice(-19)) {
    if (!item || (item.role !== 'user' && item.role !== 'assistant')) continue;
    if (typeof item.text !== 'string' || !item.text.trim()) continue;
    const entry = { role: item.role, content: item.text.trim().slice(0, 4000) };
    if (item.role === 'assistant' && typeof item.zh === 'string' && item.zh) {
      entry.zh = item.zh.slice(0, 2000);
    }
    recent.push(entry);
  }
  const last = recent[recent.length - 1];
  if (!(last && last.role === 'user' && last.content === current)) {
    recent.push({ role: 'user', content: current });
  }
  return recent.slice(-20);
}

function appendTurn(stored, userText, replies) {
  const base = Array.isArray(stored) ? stored.slice() : [];
  const text = String(userText || '').trim().slice(0, 4000);
  const last = base[base.length - 1];
  if (text && !(last && last.role === 'user' && last.text === text)) {
    base.push({ role: 'user', text, time: Date.now() });
  }
  const now = Date.now();
  (Array.isArray(replies) ? replies : []).forEach((reply, index) => {
    if (!reply || typeof reply.ko !== 'string' || !reply.ko.trim()) return;
    const entry = {
      role: 'assistant',
      text: reply.ko.trim().slice(0, 4000),
      time: now + index + 1,
      audioUrl: reply.audioUrl || null,
    };
    if (typeof reply.zh === 'string' && reply.zh) entry.zh = reply.zh;
    if (typeof reply.mood === 'string' && reply.mood) entry.mood = reply.mood;
    if (reply.ttsFailed === true) entry.ttsFailed = true;
    base.push(entry);
  });
  return base;
}

module.exports = { fromHistory, appendTurn };
