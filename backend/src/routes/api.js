const crypto = require('crypto');
const express = require('express');
const { publicContent } = require('../content');
const { foldAttempt } = require('../game/attempt');
const { evaluateSession } = require('../game/evaluate');
const { loadRules, CURRENT_VERSION } = require('../game/rules');

class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); Object.assign(this, { status, code, extra }); }
}
const bad = (code, msg, extra) => new ApiError(400, code, msg, extra);

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const isScale = v => Number.isInteger(v) && v >= 1 && v <= 5;

/** Express 4는 async 함수의 오류를 잡지 못하므로 감싸서 오류 처리기로 넘긴다 */
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApiRouter({ store, content }) {
  const router = express.Router();
  router.use(express.json({ limit: '10kb' }));   // 잘못된 JSON도 아래 오류 처리기에서 JSON으로 응답
  // 화면이 켜고 끌 기능. ai_chat(직접 답장)은 /api/chat 이 생기면 true로 바꾼다
  const features = { ai_chat: false };
  const publicJson = JSON.stringify({ ...publicContent(content), features });
  const publicEtag = '"' + crypto.createHash('sha1').update(publicJson).digest('hex').slice(0, 16) + '"';

  /* ---------- 공통 ---------- */
  const tokenOf = req => {
    const t = req.get('X-Player-Token');
    if (!t || !TOKEN_RE.test(t)) throw new ApiError(401, 'NO_TOKEN', 'X-Player-Token 헤더가 필요합니다.');
    return t;
  };
  const ownSession = async (req, sessionId) => {
    const token = tokenOf(req);
    const s = await store.getSession(sessionId);
    if (!s || s.player_token !== token) throw new ApiError(404, 'SESSION_NOT_FOUND', '세션을 찾을 수 없습니다.');
    return s;
  };
  const ownAttempt = async (req, attemptId) => {
    tokenOf(req);
    const a = Number.isInteger(Number(attemptId)) ? await store.getAttempt(Number(attemptId)) : null;
    if (!a) throw new ApiError(404, 'ATTEMPT_NOT_FOUND', '도전 기록을 찾을 수 없습니다.');
    const s = await ownSession(req, a.session_id);
    return { attempt: a, session: s };
  };
  const evaluate = async (session, attempts) => evaluateSession({
    content, rules: loadRules(session.scoring_version),
    attempts: attempts || await store.sessionAttempts(session.id),
    pre: session.pre_confidence, post: session.post_confidence
  });
  /** 화면 위 HUD·오른쪽 메뉴에 필요한 만큼만 */
  const summaryOf = ev => ({
    balance: ev.balance,
    progress: ev.progress,
    found_flags: ev.found_flags,
    flag_total: ev.flag_total,
    report_ready: ev.report_ready,
    stages: ev.stages.map(s => ({ scenario_id: s.scenario_id, cleared: s.cleared, best_trust: s.best_trust })),
    avg_trust: ev.avg_trust
  });
  const attemptView = async (attempt, session) => {
    const scenario = content.scenarioById.get(attempt.scenario_id);
    const [answers, events] = await Promise.all([store.answersOfAttempt(attempt.id), store.eventsOfAttempt(attempt.id)]);
    const r = foldAttempt(scenario, answers, loadRules(session.scoring_version), events);
    return {
      attempt_id: attempt.id, scenario_id: attempt.scenario_id, attempt_no: attempt.attempt_no,
      is_replay: !!attempt.is_replay, status: attempt.status, trust: r.trust,
      next_turn_id: attempt.status === 'playing' ? scenario.turns[r.nextTurnIndex]?.id ?? null : null
    };
  };

  const gameOverReason = (scenario, rules, failCause) => failCause === 'trust_depleted'
    ? `${rules.messages.trust_depleted}\n\n${scenario.game_over_reason}`
    : scenario.game_over_reason;

  /* ---------- 콘텐츠 ---------- */
  // 배포 확인용: DB까지 실제로 다녀와서 응답한다
  router.get('/health', h(async (req, res) => {
    await store.db.execute('SELECT 1');
    res.json({ ok: true, db: process.env.TURSO_DATABASE_URL ? 'turso' : 'local', scenarios: content.scenarios.length, flags: content.flags.length });
  }));

  router.get('/content', (req, res) => {
    res.set('ETag', publicEtag).set('Cache-Control', 'no-cache');
    if (req.get('If-None-Match') === publicEtag) return res.status(304).end();
    res.type('json').send(publicJson);
  });

  /* ---------- 세션 ---------- */
  router.post('/sessions', h(async (req, res) => {
    const { player_token, pre_confidence } = req.body || {};
    if (!player_token || !TOKEN_RE.test(player_token)) throw bad('INVALID_TOKEN', 'player_token은 8~64자의 영문·숫자·-·_ 이어야 합니다.');
    if (!isScale(pre_confidence)) throw bad('INVALID_CONFIDENCE', 'pre_confidence는 1~5 정수여야 합니다.');
    const id = crypto.randomUUID();
    await store.createSession(id, player_token, pre_confidence, CURRENT_VERSION);
    const rules = loadRules(CURRENT_VERSION);
    res.status(201).json({
      session_id: id,
      scoring_version: rules.version,
      rules: { start_trust: rules.start_trust, start_balance: rules.start_balance, trap_penalty: rules.trap_penalty }
    });
  }));

  // 새로고침 후 이어 하기, 오른쪽 메뉴 갱신용
  router.get('/sessions/:id', h(async (req, res) => {
    const session = await ownSession(req, req.params.id);
    const [ev, playing] = await Promise.all([evaluate(session), store.playingAttempt(session.id)]);
    res.json({
      session_id: session.id,
      pre_confidence: session.pre_confidence,
      post_confidence: session.post_confidence,
      finished: !!session.finished_at,
      summary: summaryOf(ev),
      playing_attempt: playing ? await attemptView(playing, session) : null
    });
  }));

  /* ---------- 단계 도전 ---------- */
  router.post('/sessions/:id/attempts', h(async (req, res) => {
    const session = await ownSession(req, req.params.id);
    const scenarioId = Number(req.body?.scenario_id);
    if (!content.scenarioById.has(scenarioId)) throw bad('INVALID_SCENARIO', '없는 사건입니다.');
    // 이미 막아 낸 사건이면 자동으로 '다시 해 보기'
    const ev = await evaluate(session);
    const isReplay = ev.stages.find(s => s.scenario_id === scenarioId).cleared;
    const attempt = await store.startAttempt(session.id, scenarioId, isReplay);
    res.status(201).json(await attemptView(attempt, session));
  }));

  router.post('/attempts/:id/answers', h(async (req, res) => {
    const { attempt, session } = await ownAttempt(req, req.params.id);
    const { turn_id, option_id, hint_used = false } = req.body || {};
    if (attempt.status !== 'playing') {
      throw new ApiError(409, 'ATTEMPT_ENDED', '이미 끝난(또는 다른 사건으로 넘어간) 도전입니다.', { status: attempt.status });
    }
    const rules = loadRules(session.scoring_version);
    const scenario = content.scenarioById.get(attempt.scenario_id);

    // 판정은 메모리에서 하고, 저장은 한 번의 batch로 (중복 제출은 UNIQUE 제약이 막는다)
    const [answers, events] = await Promise.all([store.answersOfAttempt(attempt.id), store.eventsOfAttempt(attempt.id)]);
    const before = foldAttempt(scenario, answers, rules, events);
    if (before.status !== 'playing') {   // 가짜 링크 낚임 등으로 이미 끝난 도전
      throw new ApiError(409, 'ATTEMPT_ENDED', '이미 끝난 도전입니다.', { status: before.status });
    }
    const turn = scenario.turns[before.nextTurnIndex];
    if (!turn || Number(turn_id) !== turn.id) {
      throw new ApiError(409, 'WRONG_TURN', '지금 답할 차례의 턴이 아닙니다.', { expected_turn_id: turn?.id ?? null });
    }
    const option = turn.options.find(o => o.id === option_id);
    if (!option) throw bad('INVALID_OPTION', '이 턴에 없는 선택지입니다.');
    const after = foldAttempt(scenario, [...answers, { turn_id: turn.id, option_id: option.id }], rules, events);

    try {
      await store.recordAnswer(attempt.id, turn.id, option.id, !!hint_used, after.status !== 'playing' ? after.status : null);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new ApiError(409, 'WRONG_TURN', '이미 답한 턴입니다.', { expected_turn_id: null });
      throw e;
    }

    const body = {
      type: option.type,
      feedback: option.feedback,
      trust: after.trust,
      trust_delta: after.trust - before.trust,
      revealed_flags: turn.flags,
      status: after.status === 'playing' ? 'continue' : after.status,
      next_turn_id: after.status === 'playing' ? scenario.turns[after.nextTurnIndex].id : null,
      fail_cause: after.failCause,
      game_over_reason: null,
      stage_result: null
    };

    const attempts = await store.sessionAttempts(session.id);
    if (after.status === 'failed') {
      body.game_over_reason = gameOverReason(scenario, rules, after.failCause);
    }
    if (after.status === 'cleared') {
      // 다시 해 보기라면 이번 도전 전의 최고 기록과 비교해서 알려 준다
      const prevBest = (await evaluate(session, attempts.filter(a => a.id !== attempt.id)))
        .stages.find(s => s.scenario_id === scenario.id).best_trust;
      body.stage_result = {
        trust: after.trust,
        previous_best: prevBest,
        improved: prevBest == null || after.trust > prevBest
      };
    }
    body.summary = summaryOf(await evaluate(session, attempts));
    res.json(body);
  }));

  // 채팅 속 링크로 열린 가짜 페이지에서 정보를 넣으려 함 → 신뢰도 감점 (같은 도전·같은 링크는 한 번)
  router.post('/attempts/:id/events', h(async (req, res) => {
    const { attempt, session } = await ownAttempt(req, req.params.id);
    const { kind, turn_id, url, note = '' } = req.body || {};
    if (kind !== 'bait') throw bad('INVALID_EVENT', '지원하지 않는 사건 종류입니다.');
    if (typeof url !== 'string' || !url || url.length > 300) throw bad('INVALID_LINK', '링크 주소가 올바르지 않습니다.');
    if (typeof note !== 'string' || note.length > 300) throw bad('INVALID_NOTE', '해설은 300자 이하여야 합니다.');
    if (attempt.status !== 'playing') {
      throw new ApiError(409, 'ATTEMPT_ENDED', '이미 끝난(또는 다른 사건으로 넘어간) 도전입니다.', { status: attempt.status });
    }
    const rules = loadRules(session.scoring_version);
    const scenario = content.scenarioById.get(attempt.scenario_id);
    const [answers, events] = await Promise.all([store.answersOfAttempt(attempt.id), store.eventsOfAttempt(attempt.id)]);
    const before = foldAttempt(scenario, answers, rules, events);
    const turn = scenario.turns[before.nextTurnIndex];
    if (before.status !== 'playing' || !turn || Number(turn_id) !== turn.id) {
      throw new ApiError(409, 'WRONG_TURN', '지금 대화 중인 턴이 아닙니다.', { expected_turn_id: turn?.id ?? null });
    }
    // 지금까지 받은 메시지에 실제로 있던 링크만 인정
    if (!scenario.turns.slice(0, before.nextTurnIndex + 1).some(t => t.scammer_msg.includes(url))) {
      throw bad('INVALID_LINK', '이 대화에 나온 링크가 아닙니다.');
    }
    const summaryNow = async () => summaryOf(await evaluate(session));
    const state = r => ({ trust: r.trust, status: r.status === 'playing' ? 'continue' : r.status, fail_cause: r.failCause,
                          game_over_reason: r.status === 'failed' ? `${rules.messages.bait_depleted}\n\n${scenario.game_over_reason}` : null });

    // 다시 해 보기(연습)에서는 감점하지 않는다
    if (attempt.is_replay) return res.json({ penalized: false, trust_delta: 0, ...state(before), summary: await summaryNow() });

    const after = foldAttempt(scenario, answers, rules, [...events, { turn_id: turn.id, kind: 'bait' }]);
    try {
      await store.recordEvent(attempt.id, turn.id, 'bait', url, note, after.status !== 'playing' ? after.status : null);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return res.json({ penalized: false, trust_delta: 0, ...state(before), summary: await summaryNow() });
      throw e;
    }
    res.json({ penalized: true, trust_delta: after.trust - before.trust, ...state(after), summary: await summaryNow() });
  }));

  /* ---------- 마무리·리포트 ---------- */
  router.post('/sessions/:id/finish', h(async (req, res) => {
    const session = await ownSession(req, req.params.id);
    const post = req.body?.post_confidence;
    if (!isScale(post)) throw bad('INVALID_CONFIDENCE', 'post_confidence는 1~5 정수여야 합니다.');
    const ev = await evaluate(session);
    if (!ev.report_ready) throw new ApiError(409, 'NOT_READY', '모든 사건을 막아 낸 뒤에 리포트를 볼 수 있습니다.', { progress: ev.progress });
    await store.finishSession(session.id, post);
    res.json(await evaluate(await store.getSession(session.id)));
  }));

  router.get('/sessions/:id/report', h(async (req, res) => {
    const session = await ownSession(req, req.params.id);
    const ev = await evaluate(session);
    if (!ev.report_ready) throw new ApiError(409, 'NOT_READY', '모든 사건을 막아 낸 뒤에 리포트를 볼 수 있습니다.', { progress: ev.progress });
    res.json(ev);
  }));

  /* ---------- 운영자용 문항 통계 (ADMIN_TOKEN을 설정했을 때만 열림) ---------- */
  router.get('/stats/items', h(async (req, res) => {
    const admin = process.env.ADMIN_TOKEN;
    if (!admin) throw new ApiError(404, 'NOT_FOUND', '없는 경로입니다.');
    if (req.get('X-Admin-Token') !== admin) throw new ApiError(403, 'FORBIDDEN', '권한이 없습니다.');
    const byTurn = new Map();
    for (const r of await store.itemStats()) {
      const e = byTurn.get(r.turn_id) || { n: 0, hinted: 0, options: {} };
      e.n += r.n; e.hinted += r.hinted; e.options[r.option_id] = r.n;
      byTurn.set(r.turn_id, e);
    }
    const items = [];
    for (const s of content.scenarios) for (const t of s.turns) {
      const e = byTurn.get(t.id) || { n: 0, hinted: 0, options: {} };
      const correct = t.options.find(o => o.type === 'correct');
      items.push({
        scenario_id: s.id, turn: t.turn_no, turn_id: t.id, responses: e.n,
        correct_rate: e.n ? (e.options[correct.id] || 0) / e.n : null,
        hint_rate: e.n ? e.hinted / e.n : null,
        options: t.options.map(o => ({ option_id: o.id, type: o.type, picks: e.options[o.id] || 0 }))
      });
    }
    res.json({ items });
  }));

  /* ---------- 오류 응답: { error: { code, message, ... } } ---------- */
  router.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: '없는 경로입니다.' } }));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'INVALID_JSON', message: '요청 본문이 올바른 JSON이 아닙니다.' } });
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: '서버 오류가 발생했습니다.' } });
  });

  return router;
}

module.exports = { createApiRouter, ApiError };
