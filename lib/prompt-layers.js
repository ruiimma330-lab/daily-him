'use strict';

// Which stored field belongs to which prompt layer.
// Layers 1 and 2 (global rules, character pack) stay in build-prompt.js.
// Playback, translation, and the AI notice are account settings for the app, not the prompt.
const FIELDS = {
  account: [
    { key: 'nickname', source: 'prefs.nickname', meaning: '这个账号的昵称，所有角色共用' },
  ],
  relation: [
    { key: 'tierText', source: 'common.md + persona.md 的当前档', meaning: '关系档位正文，只放当前这一档' },
    { key: 'tier', source: 'relationship.tier', meaning: '阶段。用来选档位正文，不把阶段名字写进可说出口的句子' },
    { key: 'score', source: 'relationship.score', meaning: '亲密度。用来选档，数字不另写一行（人设要求不要说分数）' },
    { key: 'daysKnown', source: 'relationship.daysKnown', meaning: '相识天数，写在档位注记里' },
    { key: 'totalTurns', source: 'relationship.totalTurns', meaning: '对话次数，写在同一条注记里' },
    { key: 'callName', source: 'profile.callName', meaning: '他怎么称呼这个用户，填进 {{userName}}' },
    { key: 'callNameStatus', source: 'profile.callNameStatus', meaning: '称呼状态：pending、confirming、done、skipped' },
    { key: 'callNameSource', source: 'profile.callNameSource', meaning: '称呼来源：user、asked、fallback' },
    { key: 'characterNickname', source: 'profile.characterNickname', meaning: '这个用户给这个角色的备注名' },
    { key: 'habits', source: 'profile.habits', meaning: '这个账号和这个角色之间的习惯' },
    { key: 'displayName', source: 'profile.displayName', meaning: '注册时留的昵称，只在界面显示，不送进提示词' },
  ],
};

const LIMITS = {
  account: 240,
  relation: 600,
};

function cap(text, limit) {
  const s = String(text || '');
  if (s.length <= limit) return s;
  return s.slice(0, limit);
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function tierSection(block, tierId) {
  const parts = String(block || '').split(/\n### /);
  const sec = parts.slice(1).find((part) => part.startsWith(`${tierId}\n`));
  return { intro: parts[0].replace(/^### /, '').trim(), body: sec ? sec.slice(tierId.length + 1).trim() : '' };
}

// Same tier slice the prompt used before this layer existed.
function relationTier({ tierId, rel, commonTier, personaTier }) {
  const commonPart = tierSection(commonTier, tierId);
  const personaPart = tierSection(personaTier, tierId);
  const relNote = rel
    ? `\n(참고: {{userName}}랑 알게 된 지 ${rel.daysKnown}일째, 지금까지 ${rel.totalTurns}번 대화했어. 숫자를 굳이 말하지는 마.)`
    : '';
  return {
    tierIntro: commonPart.intro,
    tier: `## 현재 관계 단계\n${[commonPart.body, personaPart.body].filter(Boolean).join('\n')}${relNote}`,
  };
}

function accountSection(account) {
  const nickname = clean(account && account.nickname, 20);
  if (!nickname) return '';
  return cap(
    `## 사용자 닉네임\n상대가 자기 계정에 적어 둔 닉네임은 「${nickname}」야. 불러 달라고 한 게 아니면 굳이 꺼내지 마.`,
    LIMITS.account,
  );
}

function relationExtra(relation, userName) {
  const lines = [];
  const callName = clean(relation && relation.callName, 20);
  if (callName && callName !== userName) {
    lines.push(`- 이 사용자에게는 「${callName}」(이)라고 불러.`);
  }
  const remark = clean(relation && relation.characterNickname, 20);
  if (remark) {
    lines.push(`- 사용자는 너를 「${remark}」(이)라고 저장해 뒀어. 네가 스스로를 그 이름으로 부르지는 마.`);
  }
  const habits = clean(relation && relation.habits, 200);
  if (habits) lines.push(`- 이 사용자와 너 사이의 습관: ${habits}`);
  if (!lines.length) return '';
  return cap(`## 이 사용자\n${lines.join('\n')}`, LIMITS.relation);
}

module.exports = {
  FIELDS,
  LIMITS,
  cap,
  tierSection,
  relationTier,
  accountSection,
  relationExtra,
};
