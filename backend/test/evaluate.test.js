// 채점 로직 단위 테스트 — 지금 프론트(index_v2.html)와 같은 결과가 나오는지 확인
const test = require('node:test');
const assert = require('node:assert/strict');
const { seededApp, picker } = require('./helpers');
const { foldAttempt } = require('../src/game/attempt');
const { evaluateSession } = require('../src/game/evaluate');
const { loadRules } = require('../src/game/rules');

let content, pick;
test.before(async () => { ({ content } = await seededApp()); pick = picker(content); });
const rules = loadRules('v1');
const S = id => content.scenarioById.get(id);

/** 한 사건의 답안을 만든다. plan: { [턴번호]: 'trap'|'wrong' }, hints: [턴번호...], stopAt: 실패로 끝나는 턴 */
function answersFor(scenarioId, plan = {}, hints = []) {
  const out = [];
  for (const t of S(scenarioId).turns) {
    const type = plan[t.turn_no] || 'correct';
    out.push({ turn_id: t.id, option_id: pick(t.id, type), hint_used: hints.includes(t.turn_no) });
    if (type === 'wrong') break;
  }
  return out;
}

test('foldAttempt: 전부 방어하면 신뢰도 100으로 클리어', () => {
  const r = foldAttempt(S(1), answersFor(1), rules);
  assert.equal(r.status, 'cleared');
  assert.equal(r.trust, 100);
});

test('foldAttempt: 빈틈(trap)은 -25, 치명적 실수(wrong)는 즉시 실패', () => {
  let r = foldAttempt(S(1), answersFor(1, { 2: 'trap' }), rules);
  assert.equal(r.trust, 75);
  assert.equal(r.status, 'cleared');

  r = foldAttempt(S(1), answersFor(1, { 3: 'wrong' }), rules);
  assert.equal(r.status, 'failed');
  assert.equal(r.failCause, 'fatal');
});

test('foldAttempt: 빈틈 4번이면 신뢰도 0으로 실패', () => {
  const ans = answersFor(1, { 1: 'trap', 2: 'trap', 3: 'trap', 4: 'trap' }).slice(0, 4);
  const r = foldAttempt(S(1), ans, rules);
  assert.equal(r.trust, 0);
  assert.equal(r.status, 'failed');
  assert.equal(r.failCause, 'trust_depleted');
});

test('foldAttempt: 진행 중인 도전은 playing, 다음 턴 index를 알려 준다', () => {
  const r = foldAttempt(S(2), answersFor(2).slice(0, 2), rules);
  assert.equal(r.status, 'playing');
  assert.equal(r.nextTurnIndex, 2);
});

test('evaluateSession: 프론트 showReport()와 같은 점수·등급', () => {
  let id = 0;
  const at = (scenario_id, answers, is_replay = 0) => ({ id: ++id, scenario_id, is_replay, answers });
  const attempts = [
    at(1, answersFor(1, { 2: 'wrong' }, [1])),        // 1단계 실패 (재도전 +1, 힌트 +1)
    at(1, answersFor(1, { 3: 'trap' }, [1])),         // 1단계 클리어 75점 (힌트 +1)
    at(2, answersFor(2, {}, [1])),                     // 힌트 +1
    ...[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(s => at(s, answersFor(s))),
    at(1, answersFor(1, { 4: 'trap' }, [2]), 1)        // 다시 해 보기: 75점 → 최고 기록 그대로, 힌트·빈틈은 통계에서 빠짐
  ];
  const ev = evaluateSession({ content, attempts, rules, pre: 2, post: 4 });

  // 평균 = round((75 + 100×13) / 14) = round(98.2) = 98,  점수 = 98 − 재도전 1×5 − 힌트 3×1 = 90
  assert.equal(ev.report_ready, true);
  assert.equal(ev.avg_trust, 98);
  assert.deepEqual(ev.stats, { correct: 57 + 17, trap: 1, wrong: 1, hints: 3, retries: 1 });
  assert.equal(ev.score, 90);
  assert.equal(ev.grade.grade, 'A');
  assert.equal(ev.stages.find(s => s.scenario_id === 1).best_trust, 75);
  assert.equal(ev.mistakes.length, 2);
  assert.deepEqual(ev.weak_scenarios, [1]);
  assert.equal(ev.found_flags.length, 30);
  assert.equal(ev.balance, rules.start_balance);
  assert.deepEqual(ev.confidence, { pre: 2, post: 4, delta: 2 });
});

test('evaluateSession: 다시 해 보기에서 더 잘하면 최고 기록만 바뀐다', () => {
  const attempts = [
    { id: 1, scenario_id: 1, is_replay: 0, answers: answersFor(1, { 2: 'trap', 3: 'trap' }) },
    { id: 2, scenario_id: 1, is_replay: 1, answers: answersFor(1) }
  ];
  const ev = evaluateSession({ content, attempts, rules });
  assert.equal(ev.stages.find(s => s.scenario_id === 1).best_trust, 100);
  assert.equal(ev.stats.trap, 2);         // 본 도전의 빈틈만
  assert.equal(ev.report_ready, false);
  assert.equal(ev.score, null);
});

test('evaluateSession: 마지막 본 도전이 실패면 잔고 0', () => {
  const ev = evaluateSession({ content, rules, attempts: [{ id: 1, scenario_id: 3, is_replay: 0, answers: answersFor(3, { 1: 'wrong' }) }] });
  assert.equal(ev.balance, 0);
});

test('규칙 v2: 치명타는 목숨·돈을 깎고 이어지며, 링크를 연 만큼 돈이 줄고, 다시 해 보기는 돈을 잃지 않는다', () => {
  const v2 = loadRules('v2');
  let r = foldAttempt(S(1), answersFor(1, { 2: 'wrong' }).concat([]), v2);
  // answersFor는 wrong에서 끊으므로 v2용으로 직접 만든다
  const turns = S(1).turns;
  const ans = turns.map((t, i) => ({ turn_id: t.id, option_id: pick(t.id, i === 1 ? 'wrong' : 'correct') }));
  r = foldAttempt(S(1), ans, v2);
  assert.deepEqual([r.status, r.lives, r.wrongs, r.trust], ['cleared', 2, 1, 75]);

  let id = 0;
  const at = (scenario_id, answers, is_replay = 0, clicks = []) => ({ id: ++id, scenario_id, is_replay, answers, clicks });
  const ev = evaluateSession({ content, rules: v2, attempts: [
    at(1, ans, 0, ['http://a', 'http://b']),          // 40만 + 링크 2개 40만
    at(1, ans, 1, ['http://a'])                        // 다시 해 보기: 돈 안 잃음
  ] });
  assert.equal(ev.balance, 3200000 - 800000);
  assert.equal(ev.lost, 800000);
  assert.equal(ev.link_clicks, 2);
});
