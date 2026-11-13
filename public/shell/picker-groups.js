/* Group-only picker grouping. Pure functions shared by the browser picker and node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PickerGroups = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SOLO = '个人';

  function isOpen(ch) {
    return Boolean(ch) && ch.available !== false;
  }

  // No group, "个人", or "GOT7／个人"-style labels all count as solo, never merged into a group.
  function isSolo(ch) {
    const group = String((ch && ch.group) || '').trim();
    return !group || group.includes(SOLO);
  }

  function bucketOf(ch) {
    return isSolo(ch) ? SOLO : String(ch.group).trim();
  }

  /**
   * characters: the public roster from /api/characters (already limited to the 49).
   * Returns visible tabs (groups with >=1 open member, then 个人 if any solo is open),
   * each with all roster members (closed ones stay as 待开放), and the visible pool.
   */
  function build(characters) {
    const buckets = new Map();
    (characters || []).forEach((ch) => {
      if (!ch || !ch.id) return;
      const key = bucketOf(ch);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(ch);
    });
    const groups = [];
    let solo = null;
    buckets.forEach((members, name) => {
      if (!members.some(isOpen)) return;
      if (name === SOLO) solo = { name, solo: true, members };
      else groups.push({ name, solo: false, members });
    });
    if (solo) groups.push(solo);
    const pool = groups.flatMap((g) => g.members);
    return { groups, pool };
  }

  function search(list, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return list.slice();
    return list.filter((ch) => [ch.name, ch.displayName, ch.nameZh, ch.nameRoman, ch.group, ch.company, ch.id]
      .filter(Boolean).join('\n').toLowerCase().includes(q));
  }

  /**
   * Characters shown for a tab and a search query.
   * 「全部」 (and an unknown tab, which falls back to it) lists only people you can chat with.
   * A real group tab still includes closed members so they show as 待开放.
   * Search runs on that same list, so a search on 「全部」 cannot surface 待开放.
   */
  function view(model, tab, query) {
    const group = tab && tab !== '全部' ? model.groups.find((g) => g.name === tab) : null;
    const list = group ? group.members : model.pool.filter(isOpen);
    return search(list, query);
  }

  return { SOLO, isOpen, isSolo, bucketOf, build, view, search };
});
