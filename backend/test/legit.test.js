// 사기와 진짜 메시지가 섞인 훈련: 진짜 메시지에서의 실패는 돈을 잃지 않고, 정체는 끝난 뒤에만 알려 준다
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const TOKEN = 'legit-player-001';

test('진짜(정상) 메시지', async t => {
  const srv = await startServer();
  const { call, content, pick } = srv;
  t.after(() => srv.close());
  const legit = content.scenarios.filter(s => !s.is_scam);
  assert.equal(legit.length, 5);

  await t.test('진짜 메시지에는 치명타(wrong) 선택지가 없고 위험 신호도 걸리지 않는다', () => {
    for (const s of legit) for (const turn of s.turns) {
      assert.ok(!turn.options.some(o => o.type === 'wrong'), `${turn.id}`);
      assert.equal(turn.options.filter(o => o.type === 'correct').length, 1);
      assert.deepEqual(turn.flags, [], `${turn.id} flags`);
    }
  });

  const sid = (await call('POST', '/sessions', { player_token: TOKEN, pre_confidence: 3 })).body.session_id;
  const s10 = content.scenarioById.get(10);

  await t.test('과잉 의심만 하다 신뢰도 0 → 실패, 하지만 잔고는 그대로', async () => {
    const a = (await call('POST', `/sessions/${sid}/attempts`, { scenario_id: 10 }, TOKEN)).body;
    let r;
    for (const turn of s10.turns) {
      r = await call('POST', `/attempts/${a.attempt_id}/answers`, { turn_id: turn.id, option_id: pick(turn.id, 'trap') }, TOKEN);
      if (r.body.status !== 'continue') break;
    }
    assert.equal(r.body.status, 'failed');
    assert.equal(r.body.fail_cause, 'trust_depleted');
    assert.equal(r.body.summary.balance, 3200000);
    assert.equal(r.body.reveal.is_scam, false);
    assert.ok(!r.body.game_over_reason.includes('사기꾼의 요구'));
  });

  await t.test('세션 요약: 끝낸 사건만 정체가 보인다', async () => {
    const s = (await call('GET', `/sessions/${sid}`, null, TOKEN)).body;
    const st10 = s.summary.stages.find(x => x.scenario_id === 10);
    assert.equal(st10.failed, true);
    assert.equal(st10.reveal.is_scam, false);
    assert.equal(s.summary.stages.find(x => x.scenario_id === 11).reveal, null);
  });
});
