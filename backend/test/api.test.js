// HTTP API 통합 테스트
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const TOKEN = 'test-player-0001';

test('API 흐름', async t => {
  const srv = await startServer();
  const { call, content, pick } = srv;
  t.after(() => srv.close());
  const turnsOf = id => content.scenarioById.get(id).turns;

  await t.test('GET /content 에는 정답·피드백·게임오버 사유가 없다', async () => {
    const r = await call('GET', '/content');
    assert.equal(r.status, 200);
    assert.equal(r.body.scenarios.length, 9);
    assert.equal(r.body.flags.length, 30);
    const raw = JSON.stringify(r.body);
    for (const key of ['"type"', '"feedback"', 'game_over_reason', 'correct', 'trap']) assert.ok(!raw.includes(key), key);
    assert.match(r.body.scenarios[0].turns[0].options[0].option_id, /^o_[0-9a-f]{8}$/);
  });

  let sessionId;
  await t.test('세션 생성 — 자가진단 값 검증', async () => {
    assert.equal((await call('POST', '/sessions', { player_token: TOKEN, pre_confidence: 9 })).status, 400);
    const r = await call('POST', '/sessions', { player_token: TOKEN, pre_confidence: 2 });
    assert.equal(r.status, 201);
    assert.equal(r.body.rules.trap_penalty, 25);
    sessionId = r.body.session_id;
  });

  await t.test('다른 사람 토큰으로는 세션이 안 보인다', async () => {
    assert.equal((await call('GET', `/sessions/${sessionId}`, null, 'someone-else-999')).status, 404);
    assert.equal((await call('GET', `/sessions/${sessionId}`)).status, 401);
  });

  await t.test('답안 검증: 차례가 아닌 턴, 다른 턴의 선택지', async () => {
    const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 1 }, TOKEN)).body;
    const [t1, t2] = turnsOf(1);
    let r = await call('POST', `/attempts/${a.attempt_id}/answers`, { turn_id: t2.id, option_id: pick(t2.id, 'correct') }, TOKEN);
    assert.equal(r.status, 409);
    assert.equal(r.body.error.expected_turn_id, t1.id);
    r = await call('POST', `/attempts/${a.attempt_id}/answers`, { turn_id: t1.id, option_id: pick(t2.id, 'correct') }, TOKEN);
    assert.equal(r.status, 400);
  });

  const answer = (attemptId, turn, type, hint = false) =>
    call('POST', `/attempts/${attemptId}/answers`, { turn_id: turn.id, option_id: pick(turn.id, type), hint_used: hint }, TOKEN);

  await t.test('1단계: 치명적 실수 → 실패, 게임오버 사유와 잔고 0', async () => {
    const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 1 }, TOKEN)).body;
    const r = await answer(a.attempt_id, turnsOf(1)[0], 'wrong');
    assert.equal(r.body.type, 'wrong');
    assert.equal(r.body.status, 'failed');
    assert.equal(r.body.fail_cause, 'fatal');
    assert.ok(r.body.game_over_reason.length > 10);
    assert.equal(r.body.summary.balance, 0);
    // 끝난 도전에는 더 답할 수 없다
    assert.equal((await answer(a.attempt_id, turnsOf(1)[1], 'correct')).status, 409);
  });

  await t.test('1단계 재도전: 빈틈 한 번 → 75점 클리어', async () => {
    const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 1 }, TOKEN)).body;
    assert.equal(a.is_replay, false);
    let r;
    for (const [i, turn] of turnsOf(1).entries()) {
      r = await answer(a.attempt_id, turn, i === 1 ? 'trap' : 'correct');
      if (i === 1) { assert.equal(r.body.trust_delta, -25); assert.ok(Array.isArray(r.body.revealed_flags)); }
    }
    assert.equal(r.body.status, 'cleared');
    assert.deepEqual(r.body.stage_result, { trust: 75, previous_best: null, improved: true });
    assert.equal(r.body.summary.balance, 3200000);
  });

  await t.test('다른 사건으로 넘어가면 진행 중이던 도전은 버려진다', async () => {
    const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 2 }, TOKEN)).body;
    await answer(a.attempt_id, turnsOf(2)[0], 'correct');
    const s = (await call('GET', `/sessions/${sessionId}`, null, TOKEN)).body;
    assert.equal(s.playing_attempt.attempt_id, a.attempt_id);
    assert.equal(s.playing_attempt.next_turn_id, turnsOf(2)[1].id);
    await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 3 }, TOKEN);
    const r = await answer(a.attempt_id, turnsOf(2)[1], 'correct');
    assert.equal(r.status, 409);
    assert.equal(r.body.error.status, 'abandoned');
  });

  await t.test('리포트는 모든 사건을 막아 내기 전엔 409', async () => {
    assert.equal((await call('POST', `/sessions/${sessionId}/finish`, { post_confidence: 4 }, TOKEN)).status, 409);
  });

  await t.test('나머지 사건 클리어 → 마무리 → 리포트', async () => {
    for (const sid of [2, 3, 4, 5, 6, 7, 8, 9]) {
      const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: sid }, TOKEN)).body;
      for (const turn of turnsOf(sid)) await answer(a.attempt_id, turn, 'correct');
    }
    const r = await call('POST', `/sessions/${sessionId}/finish`, { post_confidence: 4 }, TOKEN);
    assert.equal(r.status, 200);
    // 평균 round((75+100*8)/9)=97, 재도전 1회 −5 → 92 → A
    assert.equal(r.body.avg_trust, 97);
    assert.equal(r.body.score, 92);
    assert.equal(r.body.grade.grade, 'A');
    assert.equal(r.body.confidence.delta, 2);
  });

  await t.test('이미 막은 사건은 자동으로 다시 해 보기, 더 잘하면 최고 기록 갱신', async () => {
    const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 1 }, TOKEN)).body;
    assert.equal(a.is_replay, true);
    let r;
    for (const turn of turnsOf(1)) r = await answer(a.attempt_id, turn, 'correct');
    assert.deepEqual(r.body.stage_result, { trust: 100, previous_best: 75, improved: true });
    const rep = (await call('GET', `/sessions/${sessionId}/report`, null, TOKEN)).body;
    assert.equal(rep.avg_trust, 100);
    assert.equal(rep.score, 95);
  });

  await t.test('잘못된 JSON 본문도 JSON 오류로 응답한다', async () => {
    const res = await fetch(srv.base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_JSON');
  });

  await t.test('문항 통계는 ADMIN_TOKEN 이 없으면 닫혀 있다', async () => {
    assert.equal((await call('GET', '/stats/items')).status, 404);
  });
});
