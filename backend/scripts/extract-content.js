#!/usr/bin/env node
/**
 * 프론트 HTML 안에 박혀 있는 학습 데이터(SCENARIOS, FLAGS, LESSONS)를
 * content/*.json 으로 뽑아낸다. 한 번 뽑은 뒤에는 content/*.json 이 원본이다.
 *
 *   node scripts/extract-content.js ../frontend/index.html
 *
 * HTML의 `const SCENARIOS = ...` 부터 `/* ---------- 상태` 직전까지를
 * 격리된 vm 안에서 실행해 값을 꺼낸다. 정규식(FLAGS.re)은 source/flags 문자열로 바꿔 저장한다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error('사용법: node scripts/extract-content.js <index.html 경로>');
  process.exit(1);
}
const outDir = path.resolve(__dirname, '../../content');

const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.indexOf('const SCENARIOS');
const end = html.indexOf('/* ---------- 상태', start);
if (start < 0 || end < 0) {
  console.error('데이터 구간(const SCENARIOS ~ /* ---------- 상태)을 찾지 못했습니다.');
  process.exit(1);
}

const code = html.slice(start, end) +
  '\n;globalThis.__out = { SCENARIOS, FLAGS, LESSONS };';
const ctx = vm.createContext({});
vm.runInContext(code, ctx, { timeout: 2000 });
const { SCENARIOS, FLAGS, LESSONS } = ctx.__out;

// ---- 시나리오: 선택지에 무작위 id를 붙인다.
// id에 정답 종류가 드러나면 브라우저에서 답이 보이므로 'o_' + 무작위 8자리로 만든다.
// 이미 content/scenarios.json 이 있으면 (단계, 턴, 선택지 문장)이 같은 선택지는 예전 id를 그대로 쓴다
// → 다시 추출해도 기존 플레이 기록이 깨지지 않는다.
const prevIds = new Map();
try {
  const prev = JSON.parse(fs.readFileSync(path.join(outDir, 'scenarios.json'), 'utf8'));
  for (const s of prev) for (const t of s.turns) for (const o of t.options) prevIds.set(`${s.stage_id}|${t.turn}|${o.text}`, o.id);
} catch { /* 처음 추출 */ }
const newId = () => 'o_' + crypto.randomBytes(4).toString('hex');

const scenarios = SCENARIOS.map((s, i) => ({
  stage_id: s.stage_id,
  order: i + 1,
  scam_type: s.scam_type,
  platform: s.platform,
  title: s.title ?? null,
  icon: s.icon ?? null,
  scammer_profile: s.scammer_profile,
  game_over_reason: s.game_over_reason,
  turns: s.turns.map(t => ({
    turn: t.turn,
    scammer_msg: t.scammer_msg,
    options: t.options.map(o => ({
      id: prevIds.get(`${s.stage_id}|${t.turn}|${o.text}`) || newId(),
      text: o.text,
      type: o.type,
      feedback: o.feedback
    }))
  }))
}));

// 선택지 id 중복 검사
const ids = new Set();
for (const s of scenarios) for (const t of s.turns) for (const o of t.options) {
  if (ids.has(o.id)) throw new Error(`선택지 id 중복: ${o.id}`);
  ids.add(o.id);
}

const flags = FLAGS.map((f, i) => ({
  id: f.id,
  order: i + 1,
  label: f.label,
  pattern: f.re.source,
  pattern_flags: f.re.flags,
  why: f.why
}));

const lessons = Object.fromEntries(
  Object.entries(LESSONS).map(([k, v]) => [k, [...v]])
);

fs.mkdirSync(outDir, { recursive: true });
const write = (name, data) => {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2) + '\n');
  console.log(`✓ content/${name}`);
};
write('scenarios.json', scenarios);
write('flags.json', flags);
write('lessons.json', lessons);
console.log(`시나리오 ${scenarios.length}개 · 위험 신호 ${flags.length}개 · 교훈 ${Object.keys(lessons).length}세트`);
