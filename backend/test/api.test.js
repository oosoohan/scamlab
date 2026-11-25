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

  await t.test('GET /content 에는 정답·피드백·게임오버 사유·사기 여부가 없다', async () => {
    const r = await call('GET', '/content');
    assert.equal(r.status, 200);
    assert.equal(r.body.scenarios.length, 14);
    assert.equal(r.body.flags.length, 30);
    const raw = JSON.stringify(r.body);
    for (const key of ['"type"', '"feedback"', 'game_over_reason', 'correct', 'trap', 'is_scam', '"title"', 'scam_type', 'lessons']) assert.ok(!raw.includes(key), key);
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

  await t.test('1단계: 치명적 실수 = 털림(무작위 금액), 대화는 이어지고 빈틈과 함께 75점 클리어', async () => {
    const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 1 }, TOKEN)).body;
    let r;
    for (const [i, turn] of turnsOf(1).entries()) {
      r = await answer(a.attempt_id, turn, i === 0 ? 'wrong' : 'correct');
      if (i === 0) {
        const START = 3200000;
        assert.equal(r.body.status, 'continue');
        assert.ok(r.body.loss >= START * 0.25 && r.body.loss <= START * 0.45 && r.body.loss % 10000 === 0, `${r.body.loss}`);
        assert.equal(r.body.trust_delta, -25);
        assert.equal(r.body.summary.balance, START - r.body.loss);
        assert.equal(r.body.summary.strikes, 1);
        assert.equal(r.body.reveal, undefined);   // 아직 대화 중이면 정체를 알려 주지 않는다
        assert.equal(r.body.game_over, false);
      }
    }
    assert.equal(r.body.status, 'cleared');
    assert.deepEqual(r.body.stage_result, { trust: 75, previous_best: null, improved: true });
    assert.equal(r.body.reveal.is_scam, true);
  });

  let balanceAfterLink;
  await t.test('다른 사건으로 넘어가면 진행 중이던 도전은 버려진다 + 링크 열기도 털림', async () => {
    const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 2 }, TOKEN)).body;
    await answer(a.attempt_id, turnsOf(2)[0], 'correct');
    const url = turnsOf(2)[0].scammer_msg.match(/https?:\/\/\S+/)[0];
    let c = await call('POST', `/attempts/${a.attempt_id}/link-clicks`, { url }, TOKEN);
    assert.equal(c.status, 200);
    assert.equal(c.body.charged, true);
    assert.ok(c.body.loss > 0);
    assert.equal(c.body.summary.strikes, 2);
    balanceAfterLink = c.body.summary.balance;
    c = await call('POST', `/attempts/${a.attempt_id}/link-clicks`, { url }, TOKEN);
    assert.deepEqual([c.body.charged, c.body.summary.balance], [false, balanceAfterLink]);   // 같은 링크는 한 번만
    c = await call('POST', `/attempts/${a.attempt_id}/link-clicks`, { url: 'https://example.com' }, TOKEN);
    assert.equal(c.body.error.code, 'INVALID_URL');
    const s = (await call('GET', `/sessions/${sessionId}`, null, TOKEN)).body;
    assert.equal(s.playing_attempt.attempt_id, a.attempt_id);
    assert.equal(s.playing_attempt.next_turn_id, turnsOf(2)[1].id);
    assert.equal(s.rules.money_mode, true);
    await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 3 }, TOKEN);
    const r = await answer(a.attempt_id, turnsOf(2)[1], 'correct');
    assert.equal(r.status, 409);
    assert.equal(r.body.error.status, 'abandoned');
  });

  await t.test('리포트는 모든 사건을 처리하기 전엔(게임 오버도 아니면) 409', async () => {
    assert.equal((await call('POST', `/sessions/${sessionId}/finish`, { post_confidence: 4 }, TOKEN)).status, 409);
  });

  await t.test('나머지 사건 처리 → 마무리 → 리포트 (잃은 돈은 그대로)', async () => {
    for (const sid of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: sid }, TOKEN)).body;
      for (const turn of turnsOf(sid)) await answer(a.attempt_id, turn, 'correct');
    }
    const r = await call('POST', `/sessions/${sessionId}/finish`, { post_confidence: 4 }, TOKEN);
    assert.equal(r.status, 200);
    // 평균 round((75+100*13)/14)=98, 재도전 없음 → 98 → S
    assert.equal(r.body.avg_trust, 98);
    assert.equal(r.body.score, 98);
    assert.equal(r.body.game_over, false);
    assert.equal(Object.keys(r.body.reveals).length, 14);
    assert.deepEqual(r.body.judgment, { scam_total: 9, scam_first_try: 9, legit_total: 5, legit_first_try: 5 });
    assert.equal(r.body.confidence.delta, 2);
    assert.equal(r.body.balance, balanceAfterLink);
    assert.equal(r.body.strikes, 2);
    assert.equal(r.body.link_clicks, 1);
  });

  await t.test('이미 막은 사건은 자동으로 다시 해 보기, 더 잘하면 최고 기록 갱신 (돈은 안 털림)', async () => {
    const a = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 1 }, TOKEN)).body;
    assert.equal(a.is_replay, true);
    let r = await answer(a.attempt_id, turnsOf(1)[0], 'wrong');
    assert.equal(r.body.loss, 0);
    assert.equal(r.body.summary.balance, balanceAfterLink);
    const b = (await call('POST', `/sessions/${sessionId}/attempts`, { scenario_id: 1 }, TOKEN)).body;
    for (const turn of turnsOf(1)) r = await answer(b.attempt_id, turn, 'correct');
    assert.deepEqual(r.body.stage_result, { trust: 100, previous_best: 75, improved: true });
    const rep = (await call('GET', `/sessions/${sessionId}/report`, null, TOKEN)).body;
    assert.equal(rep.avg_trust, 100);
  });

  await t.test('털림 세 번이면 0원 → 그 자리에서 게임 전체 끝: 다시 도전 불가, 바로 리포트', async () => {
    const T2 = 'test-player-0002';
    const sid2 = (await call('POST', '/sessions', { player_token: T2, pre_confidence: 3 })).body.session_id;
    const ans2 = (attemptId, turn, type) => call('POST', `/attempts/${attemptId}/answers`, { turn_id: turn.id, option_id: pick(turn.id, type) }, T2);
    const a = (await call('POST', `/sessions/${sid2}/attempts`, { scenario_id: 1 }, T2)).body;
    await ans2(a.attempt_id, turnsOf(1)[0], 'wrong');
    let r = await ans2(a.attempt_id, turnsOf(1)[1], 'wrong');
    const left2 = r.body.summary.balance;
    assert.ok(r.body.loss > 0 && left2 > 0);
    r = await ans2(a.attempt_id, turnsOf(1)[2], 'wrong');
    assert.equal(r.body.loss, left2);                    // 3번째: 남은 돈 전부
    assert.equal(r.body.summary.balance, 0);
    assert.equal(r.body.status, 'failed');               // 대화가 남아 있어도 그 자리에서 끝
    assert.equal(r.body.fail_cause, 'bankrupt');
    assert.ok(r.body.game_over_reason.startsWith('통장 잔고가 0원'));
    assert.equal(r.body.game_over, true);
    assert.equal(r.body.reveal.is_scam, true);
    // 더 답할 수도, 새로 도전할 수도 없다
    assert.equal((await ans2(a.attempt_id, turnsOf(1)[3], 'correct')).status, 409);
    const n = await call('POST', `/sessions/${sid2}/attempts`, { scenario_id: 2 }, T2);
    assert.equal(n.body.error.code, 'GAME_OVER');
    // 리포트는 바로 열린다. 못 끝낸 메시지는 0점
    const f = await call('POST', `/sessions/${sid2}/finish`, { post_confidence: 2 }, T2);
    assert.equal(f.status, 200);
    assert.equal(f.body.game_over, true);
    assert.equal(f.body.progress.cleared, 0);
    assert.equal(f.body.avg_trust, 0);
    assert.equal(f.body.balance, 0);
  });

  await t.test('링크를 열어 0원이 되어도 그 자리에서 게임 끝', async () => {
    const T3 = 'test-player-0003';
    const sid3 = (await call('POST', '/sessions', { player_token: T3, pre_confidence: 3 })).body.session_id;
    const a = (await call('POST', `/sessions/${sid3}/attempts`, { scenario_id: 1 }, T3)).body;
    await call('POST', `/attempts/${a.attempt_id}/answers`, { turn_id: turnsOf(1)[0].id, option_id: pick(turnsOf(1)[0].id, 'wrong') }, T3);
    await call('POST', `/attempts/${a.attempt_id}/answers`, { turn_id: turnsOf(1)[1].id, option_id: pick(turnsOf(1)[1].id, 'wrong') }, T3);
    const url = turnsOf(1).map(t => t.scammer_msg.match(/https?:\/\/\S+/)).find(Boolean)[0];
    const c = await call('POST', `/attempts/${a.attempt_id}/link-clicks`, { url }, T3);
    assert.equal(c.body.summary.balance, 0);
    assert.equal(c.body.status, 'failed');
    assert.equal(c.body.fail_cause, 'bankrupt');
    assert.equal(c.body.game_over, true);
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
