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

function createApiRouter({ store, content }) {
  const router = express.Router();
  router.use(express.json({ limit: '10kb' }));   // 잘못된 JSON도 아래 오류 처리기에서 JSON으로 응답
  const publicJson = JSON.stringify(publicContent(content));
  const publicEtag = '"' + crypto.createHash('sha1').update(publicJson).digest('hex').slice(0, 16) + '"';

  /* ---------- 공통 ---------- */
  const tokenOf = req => {
    const t = req.get('X-Player-Token');
    if (!t || !TOKEN_RE.test(t)) throw new ApiError(401, 'NO_TOKEN', 'X-Player-Token 헤더가 필요합니다.');
    return t;
  };
  const ownSession = (req, sessionId) => {
    const token = tokenOf(req);
    const s = store.getSession(sessionId);
    if (!s || s.player_token !== token) throw new ApiError(404, 'SESSION_NOT_FOUND', '세션을 찾을 수 없습니다.');
    return s;
  };
  const ownAttempt = (req, attemptId) => {
    const a = store.getAttempt(Number(attemptId));
    if (!a) throw new ApiError(404, 'ATTEMPT_NOT_FOUND', '도전 기록을 찾을 수 없습니다.');
    const s = ownSession(req, a.session_id);
    return { attempt: a, session: s };
  };
  const evaluate = (session, extra = {}) => evaluateSession({
    content, rules: loadRules(session.scoring_version),
    attempts: extra.attempts || store.sessionAttempts(session.id),
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
  const attemptView = (attempt, session) => {
    const scenario = content.scenarioById.get(attempt.scenario_id);
    const r = foldAttempt(scenario, store.answersOfAttempt(attempt.id), loadRules(session.scoring_version));
    return {
      attempt_id: attempt.id, scenario_id: attempt.scenario_id, attempt_no: attempt.attempt_no,
      is_replay: !!attempt.is_replay, status: attempt.status, trust: r.trust,
      next_turn_id: attempt.status === 'playing' ? scenario.turns[r.nextTurnIndex]?.id ?? null : null
    };
  };

  /* ---------- 콘텐츠 ---------- */
  router.get('/health', (req, res) => res.json({ ok: true }));

  router.get('/content', (req, res) => {
    res.set('ETag', publicEtag).set('Cache-Control', 'no-cache');
    if (req.get('If-None-Match') === publicEtag) return res.status(304).end();
    res.type('json').send(publicJson);
  });

  /* ---------- 세션 ---------- */
  router.post('/sessions', (req, res) => {
    const { player_token, pre_confidence } = req.body || {};
    if (!player_token || !TOKEN_RE.test(player_token)) throw bad('INVALID_TOKEN', 'player_token은 8~64자의 영문·숫자·-·_ 이어야 합니다.');
    if (!isScale(pre_confidence)) throw bad('INVALID_CONFIDENCE', 'pre_confidence는 1~5 정수여야 합니다.');
    const id = crypto.randomUUID();
    store.createSession(id, player_token, pre_confidence, CURRENT_VERSION);
    const rules = loadRules(CURRENT_VERSION);
    res.status(201).json({
      session_id: id,
      scoring_version: rules.version,
      rules: { start_trust: rules.start_trust, start_balance: rules.start_balance, trap_penalty: rules.trap_penalty }
    });
  });

  // 새로고침 후 이어 하기, 오른쪽 메뉴 갱신용
  router.get('/sessions/:id', (req, res) => {
    const session = ownSession(req, req.params.id);
    const playing = store.playingAttempt(session.id);
    res.json({
      session_id: session.id,
      pre_confidence: session.pre_confidence,
      post_confidence: session.post_confidence,
      finished: !!session.finished_at,
      summary: summaryOf(evaluate(session)),
      playing_attempt: playing ? attemptView(playing, session) : null
    });
  });

  /* ---------- 단계 도전 ---------- */
  router.post('/sessions/:id/attempts', (req, res) => {
    const session = ownSession(req, req.params.id);
    const scenarioId = Number(req.body?.scenario_id);
    if (!content.scenarioById.has(scenarioId)) throw bad('INVALID_SCENARIO', '없는 사건입니다.');
    // 이미 막아 낸 사건이면 자동으로 '다시 해 보기'
    const ev = evaluate(session);
    const isReplay = ev.stages.find(s => s.scenario_id === scenarioId).cleared;
    const attempt = store.startAttempt(session.id, scenarioId, isReplay);
    res.status(201).json(attemptView(attempt, session));
  });

  router.post('/attempts/:id/answers', (req, res) => {
    const { attempt, session } = ownAttempt(req, req.params.id);
    const { turn_id, option_id, hint_used = false } = req.body || {};
    if (attempt.status !== 'playing') {
      throw new ApiError(409, 'ATTEMPT_ENDED', '이미 끝난(또는 다른 사건으로 넘어간) 도전입니다.', { status: attempt.status });
    }
    const rules = loadRules(session.scoring_version);
    const scenario = content.scenarioById.get(attempt.scenario_id);

    const result = store.db.transaction(() => {
      const before = foldAttempt(scenario, store.answersOfAttempt(attempt.id), rules);
      const expected = scenario.turns[before.nextTurnIndex];
      if (!expected || Number(turn_id) !== expected.id) {
        throw new ApiError(409, 'WRONG_TURN', '지금 답할 차례의 턴이 아닙니다.', { expected_turn_id: expected?.id ?? null });
      }
      const option = expected.options.find(o => o.id === option_id);
      if (!option) throw bad('INVALID_OPTION', '이 턴에 없는 선택지입니다.');

      store.insertAnswer(attempt.id, expected.id, option.id, !!hint_used);
      const after = foldAttempt(scenario, store.answersOfAttempt(attempt.id), rules);
      if (after.status !== 'playing') store.endAttempt(attempt.id, after.status);
      return { option, before, after, turn: expected };
    })();

    const { option, before, after, turn } = result;
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

    const attempts = store.sessionAttempts(session.id);
    if (after.status === 'failed') {
      body.game_over_reason = after.failCause === 'trust_depleted'
        ? `${rules.messages.trust_depleted}\n\n${scenario.game_over_reason}`
        : scenario.game_over_reason;
    }
    if (after.status === 'cleared') {
      // 다시 해 보기라면 이번 도전 전의 최고 기록과 비교해서 알려 준다
      const prevBest = evaluate(session, { attempts: attempts.filter(a => a.id !== attempt.id) })
        .stages.find(s => s.scenario_id === scenario.id).best_trust;
      body.stage_result = {
        trust: after.trust,
        previous_best: prevBest,
        improved: prevBest == null || after.trust > prevBest
      };
    }
    body.summary = summaryOf(evaluate(session, { attempts }));
    res.json(body);
  });

  /* ---------- 마무리·리포트 ---------- */
  router.post('/sessions/:id/finish', (req, res) => {
    const session = ownSession(req, req.params.id);
    const post = req.body?.post_confidence;
    if (!isScale(post)) throw bad('INVALID_CONFIDENCE', 'post_confidence는 1~5 정수여야 합니다.');
    const ev = evaluate(session);
    if (!ev.report_ready) throw new ApiError(409, 'NOT_READY', '모든 사건을 막아 낸 뒤에 리포트를 볼 수 있습니다.', { progress: ev.progress });
    store.finishSession(session.id, post);
    res.json(evaluate(store.getSession(session.id)));
  });

  router.get('/sessions/:id/report', (req, res) => {
    const session = ownSession(req, req.params.id);
    const ev = evaluate(session);
    if (!ev.report_ready) throw new ApiError(409, 'NOT_READY', '모든 사건을 막아 낸 뒤에 리포트를 볼 수 있습니다.', { progress: ev.progress });
    res.json(ev);
  });

  /* ---------- 운영자용 문항 통계 (ADMIN_TOKEN을 설정했을 때만 열림) ---------- */
  router.get('/stats/items', (req, res) => {
    const admin = process.env.ADMIN_TOKEN;
    if (!admin) throw new ApiError(404, 'NOT_FOUND', '없는 경로입니다.');
    if (req.get('X-Admin-Token') !== admin) throw new ApiError(403, 'FORBIDDEN', '권한이 없습니다.');
    const rows = store.db.prepare(`
      SELECT a.turn_id, a.option_id, COUNT(*) AS n, SUM(a.hint_used) AS hinted
      FROM answers a JOIN stage_attempts s ON s.id = a.attempt_id
      WHERE s.is_replay = 0 GROUP BY a.turn_id, a.option_id`).all();
    const byTurn = new Map();
    for (const r of rows) {
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
        correct_rate: e.n ? +(e.options[correct.id] || 0) / e.n : null,
        hint_rate: e.n ? e.hinted / e.n : null,
        options: t.options.map(o => ({ option_id: o.id, type: o.type, picks: e.options[o.id] || 0 }))
      });
    }
    res.json({ items });
  });

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
