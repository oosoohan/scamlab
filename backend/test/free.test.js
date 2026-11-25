// 직접 답장(AI 채점) — 실제 AI 대신 가짜 judge를 넣어 흐름만 검사한다
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { buildApp } = require('../src/app');
const { loadContent } = require('../src/content');
const { judgeFreeText, findPii, sanitizeReply } = require('../src/game/judge');

const TOKEN = 'free-player-0001';

async function start(judge) {
  const db = openDb(':memory:');
  const { app } = await buildApp({ db, serveFrontend: false, judge });
  const content = await loadContent(db);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Player-Token': TOKEN }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { content, call, close: () => new Promise(r => server.close(r)) };
}

test('직접 답장: 판정 유형대로 기록되고 AI 대사·설명이 함께 온다', async t => {
  const verdicts = ['correct', 'trap', 'wrong'];
  const seen = [];
  const srv = await start(async ({ text, turn, nextTurn }) => {
    seen.push({ text, turnId: turn.id, hasNext: !!nextTurn });
    return { type: verdicts.shift(), reply: '왜 이렇게 의심하세요 ㅠ', feedback: 'AI 설명' };
  });
  t.after(srv.close);
  const turns = srv.content.scenarioById.get(1).turns;
  const sid = (await srv.call('POST', '/sessions', { player_token: TOKEN, pre_confidence: 3 })).body.session_id;
  const a = (await srv.call('POST', `/sessions/${sid}/attempts`, { scenario_id: 1 })).body;

  let r = await srv.call('POST', `/attempts/${a.attempt_id}/free-answers`, { turn_id: turns[0].id, text: '앱 안에서만 거래할게요' });
  assert.equal(r.status, 200);
  assert.equal(r.body.type, 'correct');
  assert.equal(r.body.reply, '왜 이렇게 의심하세요 ㅠ');
  assert.equal(r.body.feedback, 'AI 설명');
  assert.equal(r.body.model_answer, null);
  assert.equal(r.body.status, 'continue');

  r = await srv.call('POST', `/attempts/${a.attempt_id}/free-answers`, { turn_id: turns[1].id, text: '음 잘 모르겠어요' });
  assert.equal(r.body.type, 'trap');
  assert.equal(r.body.trust_delta, -25);
  assert.ok(r.body.model_answer.length > 5);

  r = await srv.call('POST', `/attempts/${a.attempt_id}/free-answers`, { turn_id: turns[2].id, text: '링크 눌러서 로그인할게요' });
  assert.equal(r.body.type, 'wrong');
  assert.equal(r.body.status, 'continue');   // 규칙 v2: 돈을 잃고 대화가 이어진다
  assert.equal(r.body.loss, 400000);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].hasNext, true);
});

test('직접 답장: 개인정보·빈 답장은 AI로 보내지 않는다', async t => {
  let called = 0;
  const srv = await start(async () => { called++; return { type: 'correct', reply: '', feedback: '' }; });
  t.after(srv.close);
  const turns = srv.content.scenarioById.get(1).turns;
  const sid = (await srv.call('POST', '/sessions', { player_token: TOKEN, pre_confidence: 3 })).body.session_id;
  const a = (await srv.call('POST', `/sessions/${sid}/attempts`, { scenario_id: 1 })).body;
  let r = await srv.call('POST', `/attempts/${a.attempt_id}/free-answers`, { turn_id: turns[0].id, text: '제 번호 010-1234-5678' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'PERSONAL_INFO');
  r = await srv.call('POST', `/attempts/${a.attempt_id}/free-answers`, { turn_id: turns[0].id, text: '   ' });
  assert.equal(r.body.error.code, 'INVALID_TEXT');
  assert.equal(called, 0);
});

test('직접 답장: API 키가 없으면 503 AI_DISABLED, 기록은 남지 않는다', async t => {
  const srv = await start(args => judgeFreeText(args, { apiKey: '' }));
  t.after(srv.close);
  const turns = srv.content.scenarioById.get(1).turns;
  const sid = (await srv.call('POST', '/sessions', { player_token: TOKEN, pre_confidence: 3 })).body.session_id;
  const a = (await srv.call('POST', `/sessions/${sid}/attempts`, { scenario_id: 1 })).body;
  const r = await srv.call('POST', `/attempts/${a.attempt_id}/free-answers`, { turn_id: turns[0].id, text: '거절할게요' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'AI_DISABLED');
  const s = (await srv.call('GET', `/sessions/${sid}`)).body;
  assert.equal(s.playing_attempt.next_turn_id, turns[0].id);
});

test('judge: AI 응답 JSON을 읽고, 이상한 판정은 trap, 대사 속 링크·번호는 지운다', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"verdict":"maybe","reply":"여기로 오세요 https://evil.example.com 010-1111-2222","feedback":"설명"}' }] }) });
  const r = await judgeFreeText({ scenario: { scam_type: 'x', title: 'y', scammer_name: 'z' }, turn: { scammer_msg: 'm', options: [] }, nextTurn: null, text: 't' }, { apiKey: 'k', fetchImpl: fake });
  assert.equal(r.type, 'trap');
  assert.ok(!/https|010/.test(r.reply));
  assert.equal(findPii('주민번호 990101-1234567'), '주민등록번호');
  assert.equal(findPii('안 보낼게요'), null);
  assert.equal(sanitizeReply('www.a.com 가세요'), '[링크] 가세요');
});
