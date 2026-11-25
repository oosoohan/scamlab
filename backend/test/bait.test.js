// 가짜 링크 페이지 낚임(bait) 테스트
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { foldAttempt } = require('../src/game/attempt');
const { loadRules } = require('../src/game/rules');

const LINK = 'https://naverpay-safedeal.co/sell?no=2611-4821';   // 1단계 3번 턴 메시지에 있는 링크

test('foldAttempt: 낚임은 −25, 신뢰도 0이면 실패', () => {
  const rules = loadRules('v1');
  const scenario = { turns: [1, 2, 3].map(n => ({ id: n, options: [{ id: `c${n}`, type: 'correct' }] })) };
  let r = foldAttempt(scenario, [{ turn_id: 1, option_id: 'c1' }], rules, [{ turn_id: 2, kind: 'bait' }]);
  assert.deepEqual([r.trust, r.status], [75, 'playing']);
  r = foldAttempt(scenario, [], rules, [1, 2, 3, 4].map(() => ({ turn_id: 1, kind: 'bait' })));
  assert.deepEqual([r.trust, r.status, r.failCause], [0, 'failed', 'trust_depleted']);
});

test('링크 낚임 API', async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  const T = 'bait-player-0001';
  const { call, pick } = srv;
  const answer = (aid, turnId, type = 'correct') => call('POST', `/attempts/${aid}/answers`, { turn_id: turnId, option_id: pick(turnId, type) }, T);
  const bait = (aid, turnId, url = LINK) => call('POST', `/attempts/${aid}/events`, { kind: 'bait', turn_id: turnId, url, note: '가짜 로그인 화면' }, T);

  await t.test('콘텐츠에 기능 플래그가 있다 (직접 답장은 꺼짐)', async () => {
    assert.deepEqual((await call('GET', '/content')).body.features, { ai_chat: false });
  });

  const ses = (await call('POST', '/sessions', { player_token: T, pre_confidence: 3 })).body;
  const a = (await call('POST', `/sessions/${ses.session_id}/attempts`, { scenario_id: 1 }, T)).body;
  await answer(a.attempt_id, 101);
  await answer(a.attempt_id, 102);

  await t.test('검증: 대화에 없는 링크, 지금이 아닌 턴', async () => {
    assert.equal((await bait(a.attempt_id, 103, 'https://evil.example')).status, 400);
    assert.equal((await bait(a.attempt_id, 104)).status, 409);
    assert.equal((await call('POST', `/attempts/${a.attempt_id}/events`, { kind: 'bait', turn_id: 103, url: LINK })).status, 401);
  });

  await t.test('첫 낚임은 −25, 같은 링크는 다시 감점하지 않는다', async () => {
    let r = await bait(a.attempt_id, 103);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.penalized, r.body.trust, r.body.trust_delta, r.body.status], [true, 75, -25, 'continue']);
    r = await bait(a.attempt_id, 103);
    assert.deepEqual([r.body.penalized, r.body.trust], [false, 75]);
  });

  await t.test('이어서 답하면 감점이 반영된 신뢰도로 클리어, 오답 노트에 낚임 기록', async () => {
    let r;
    for (const turnId of [103, 104, 105, 106]) r = await answer(a.attempt_id, turnId);
    assert.equal(r.body.status, 'cleared');
    assert.equal(r.body.stage_result.trust, 75);
    const ev = (await call('GET', `/sessions/${ses.session_id}`, null, T)).body.summary.stages.find(s => s.scenario_id === 1);
    assert.equal(ev.best_trust, 75);
  });

  await t.test('낚임 4번이면 신뢰도 0 → 실패, 이후 답은 받지 않는다', async () => {
    // 2단계: 1·2번 턴에 같은 링크가 있고, 3번 턴에 다른 링크가 있다 → 서로 다른 링크 3개 + 빈틈 1번
    const b = (await call('POST', `/sessions/${ses.session_id}/attempts`, { scenario_id: 2 }, T)).body;
    let r = await bait(b.attempt_id, 201, 'http://cj-1ogis.kr/a8Kx');
    assert.equal(r.body.trust, 75);
    await answer(b.attempt_id, 201, 'trap');                       // 50
    await answer(b.attempt_id, 202);
    r = await bait(b.attempt_id, 203, 'http://wedding-card.me/jisu1214');   // 25
    r = await bait(b.attempt_id, 203, 'http://cj-1ogis.kr/a8Kx');           // 같은 도전에서 이미 감점된 링크 → 그대로
    assert.deepEqual([r.body.penalized, r.body.trust], [false, 25]);
    // 남은 다른 링크가 없으므로 빈틈으로 0을 만든다
    r = await answer(b.attempt_id, 203, 'trap');
    assert.equal(r.body.status, 'failed');
    assert.equal(r.body.fail_cause, 'trust_depleted');
  });

  await t.test('낚임으로 신뢰도가 0이 되면 실패 사유가 낚임 문구', async () => {
    const T2 = 'bait-player-0002';
    const s2 = (await call('POST', '/sessions', { player_token: T2, pre_confidence: 3 })).body;
    const c = (await call('POST', `/sessions/${s2.session_id}/attempts`, { scenario_id: 2 }, T2)).body;
    const ans = (turnId, type) => call('POST', `/attempts/${c.attempt_id}/answers`, { turn_id: turnId, option_id: pick(turnId, type) }, T2);
    await ans(201, 'trap'); await ans(202, 'trap'); await ans(203, 'trap');   // 25
    const r = await call('POST', `/attempts/${c.attempt_id}/events`, { kind: 'bait', turn_id: 204, url: 'http://wedding-card.me/jisu1214', note: 'x' }, T2);
    assert.deepEqual([r.body.penalized, r.body.trust, r.body.status], [true, 0, 'failed']);
    assert.match(r.body.game_over_reason, /가짜 페이지/);
    assert.equal((await ans(204, 'correct')).status, 409);
  });

  await t.test('다시 해 보기에서는 감점하지 않는다', async () => {
    const rp = (await call('POST', `/sessions/${ses.session_id}/attempts`, { scenario_id: 1 }, T)).body;
    assert.equal(rp.is_replay, true);
    await answer(rp.attempt_id, 101); await answer(rp.attempt_id, 102);
    const r = await bait(rp.attempt_id, 103);
    assert.deepEqual([r.body.penalized, r.body.trust], [false, 100]);
  });

  await t.test('리포트 오답 노트에 낚임이 빈틈으로 기록된다', async () => {
    // 세션의 1단계 본 도전 기록만 확인 (리포트는 9개 모두 막아야 하므로 평가 함수로 직접)
    const { evaluateSession } = require('../src/game/evaluate');
    const { createStore } = require('../src/store');
    const ev = evaluateSession({ content: srv.content, rules: loadRules('v1'), attempts: await createStore(srv.db).sessionAttempts(ses.session_id) });
    const m = ev.mistakes.find(x => x.kind === 'bait' && x.scenario_id === 1);
    assert.ok(m);
    assert.equal(m.type, 'trap');
    assert.match(m.mine, /naverpay-safedeal\.co/);
    assert.equal(m.why, '가짜 로그인 화면');
    assert.ok(ev.stats.bait >= 1);
  });
});
