// 콘텐츠 자동 시드 · 동시 제출 테스트
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, initSchema } = require('../src/db');
const { seedIfChanged, loadContentFiles } = require('../src/seed');
const { startServer } = require('./helpers');

test('seedIfChanged: 처음엔 시드, 같은 내용이면 건너뛰고, 바뀌면 다시 시드', async () => {
  const db = openDb(':memory:');
  await initSchema(db);
  const content = loadContentFiles();

  assert.ok(await seedIfChanged(db, content));          // 처음
  assert.equal(await seedIfChanged(db, content), null); // 그대로

  const edited = structuredClone(content);
  edited.scenarios[0].turns[0].scammer_msg += ' (수정)';
  assert.ok(await seedIfChanged(db, edited));           // 바뀜
  const msg = (await db.execute('SELECT scammer_msg FROM turns WHERE id = 101')).rows[0].scammer_msg;
  assert.ok(msg.endsWith('(수정)'));
});

test('같은 턴에 답을 동시에 두 번 보내면 하나만 저장된다', async t => {
  const srv = await startServer();
  t.after(() => srv.close());
  const T = 'double-click-01';
  const ses = (await srv.call('POST', '/sessions', { player_token: T, pre_confidence: 3 })).body;
  const a = (await srv.call('POST', `/sessions/${ses.session_id}/attempts`, { scenario_id: 1 }, T)).body;
  const body = { turn_id: 101, option_id: srv.pick(101, 'correct') };
  const [r1, r2] = await Promise.all([
    srv.call('POST', `/attempts/${a.attempt_id}/answers`, body, T),
    srv.call('POST', `/attempts/${a.attempt_id}/answers`, body, T)
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const n = (await srv.db.execute({ sql: 'SELECT COUNT(*) AS n FROM answers WHERE attempt_id = ?', args: [a.attempt_id] })).rows[0].n;
  assert.equal(n, 1);
});
