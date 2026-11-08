'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const chars = require('../lib/characters');
const keep = ["baekhyun", "kai", "mark", "sehun", "the8", "jun", "renjun", "ningning", "yuqi", "shuhua", "tzuyu", "jacksonwang", "layzhang", "ricky", "zhanghao", "chaeunwoo", "gdragon", "rose", "lisa", "jennie", "jisoo", "myungjaehyun", "jimin", "jungkook", "taehyung", "sunghoon", "sunoo", "yujin", "wonyoung", "sakura", "jeno", "jaemin", "yushi", "wonbin", "wonwoo", "mingyu", "leeknow", "felix", "hyunjin", "sana", "shinyu", "dohoon", "beomgyu", "yeonjun", "soobin", "giselle", "karina", "winter", "iu"];
const hidden = ["anton", "bangchan", "chaewon", "chanyeol", "chenle", "gyuvin", "haechan", "han", "hanyujin", "hueningkai", "irene", "jeonghan", "jisung", "jungwon", "juyeon", "liz", "minju", "moka", "nayeon", "nct-jaehyun", "rei", "riku", "sangwon", "scoups", "sion", "sungchan", "taehyun", "taemin", "taesan", "ten", "tws-jihoon", "sakuya", "ahyeon", "wonhee", "hanjin", "niki", "anxin", "james", "juhoon", "keonho", "martin", "seonghyeon", "xinlong"];
test('public discovery contains exactly the approved 49; all 43 archived packs remain resolvable', () => {
  const listed = chars.list();
  assert.equal(listed.length, 49);
  assert.deepEqual(listed.map(c => c.id).sort(), [...keep].sort());
  for (const id of hidden) {
    assert.equal(listed.some(c => c.id === id), false, id);
    assert.equal(chars.resolveId(id), id);
    assert.ok(chars.publicInfo(id));
  }
  for (const info of listed) assert.deepEqual(info, chars.publicInfo(info.id));
});
