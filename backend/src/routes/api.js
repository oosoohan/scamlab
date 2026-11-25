const crypto = require('crypto');
const express = require('express');
const { publicContent, revealOf } = require('../content');
const { foldAttempt } = require('../game/attempt');
const { evaluateSession } = require('../game/evaluate');
const { loadRules, CURRENT_VERSION } = require('../game/rules');
const { judgeFreeText, findPii } = require('../game/judge');

class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); Object.assign(this, { status, code, extra }); }
}
const bad = (code, msg, extra) => new ApiError(400, code, msg, extra);

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const isScale = v => Number.isInteger(v) && v >= 1 && v <= 5;

/** Express 4는 async 함수의 오류를 잡지 못하므로 감싸서 오류 처리기로 넘긴다 */
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApiRouter({ store, content, judge = judgeFreeText }) {
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
    pre: session.pre_confidence, post: session.post_confidence, seed: session.id
  });
  /** 화면 위 HUD·오른쪽 메뉴에 필요한 만큼만 */
  // 사기인지 진짜인지는 그 사건 대화를 끝까지 한 번이라도 마친 뒤에만 알려 준다
  /** 화면에 필요한 규칙 값만 (money_mode: 치명타·링크가 돈을 깎고 대화가 이어지는 v2 규칙인지) */
  const publicRules = rules => ({
    start_trust: rules.start_trust, start_balance: rules.start_balance, trap_penalty: rules.trap_penalty,
    money_mode: !rules.wrong_is_fatal, strikes_to_zero: rules.strikes_to_zero || null
  });

  const summaryOf = ev => ({
    balance: ev.balance,
    lost: ev.lost,
    strikes: ev.strikes,
    progress: ev.progress,
    found_flags: ev.found_flags,
    flag_total: ev.flag_total,
    report_ready: ev.report_ready,
    stages: ev.stages.map(s => ({
      scenario_id: s.scenario_id, cleared: s.cleared, failed: s.failed, best_trust: s.best_trust,
      reveal: s.cleared || s.failed ? revealOf(content.scenarioById.get(s.scenario_id)) : null
    })),
    avg_trust: ev.avg_trust
  });
  /** 리포트에는 모든 사건의 정체를 붙인다 (리포트는 모든 사건을 마친 뒤에만 열린다) */
  const withReveals = ev => ({ ...ev, reveals: Object.fromEntries(content.scenarios.map(s => [s.id, revealOf(s)])) });
  const attemptView = async (attempt, session) => {
    const scenario = content.scenarioById.get(attempt.scenario_id);
    const r = foldAttempt(scenario, await store.answersOfAttempt(attempt.id), loadRules(session.scoring_version));
    return {
      attempt_id: attempt.id, scenario_id: attempt.scenario_id, attempt_no: attempt.attempt_no,
      is_replay: !!attempt.is_replay, status: attempt.status, trust: r.trust,
      next_turn_id: attempt.status === 'playing' ? scenario.turns[r.nextTurnIndex]?.id ?? null : null
    };
  };

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
      rules: publicRules(rules)
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
      rules: publicRules(loadRules(session.scoring_version)),
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

  /** 지금 답할 차례의 턴을 확인한다 (선택지 답안·직접 답장 공통) */
  const currentTurn = async (attempt, session, turnId) => {
    if (attempt.status !== 'playing') {
      throw new ApiError(409, 'ATTEMPT_ENDED', '이미 끝난(또는 다른 사건으로 넘어간) 도전입니다.', { status: attempt.status });
    }
    const rules = loadRules(session.scoring_version);
    const scenario = content.scenarioById.get(attempt.scenario_id);
    const answers = await store.answersOfAttempt(attempt.id);
    const before = foldAttempt(scenario, answers, rules);
    const turn = scenario.turns[before.nextTurnIndex];
    if (!turn || Number(turnId) !== turn.id) {
      throw new ApiError(409, 'WRONG_TURN', '지금 답할 차례의 턴이 아닙니다.', { expected_turn_id: turn?.id ?? null });
    }
    return { rules, scenario, answers, before, turn };
  };

  /** 고른 선택지를 기록하고 응답 본문을 만든다 (선택지 답안·직접 답장 공통) */
  const applyOption = async ({ attempt, session, rules, scenario, answers, before, turn, option, hintUsed }) => {
    const after = foldAttempt(scenario, [...answers, { turn_id: turn.id, option_id: option.id }], rules);
    try {
      await store.recordAnswer(attempt.id, turn.id, option.id, !!hintUsed, after.status !== 'playing' ? after.status : null);
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
      // 진짜 메시지에서 실패한 경우(과잉 의심 등)는 '사기꾼에게 끌려갔다'는 문구를 붙이지 않는다
      const lead = !scenario.is_scam ? null
        : after.failCause === 'trust_depleted' ? rules.messages.trust_depleted : null;
      body.game_over_reason = lead ? `${lead}\n\n${scenario.game_over_reason}` : scenario.game_over_reason;
    }
    if (after.status !== 'playing') body.reveal = revealOf(scenario);
    if (after.status === 'cleared') {
      // 다시 해 보기라면 이번 도전 전의 최고 기록과 비교해서 알려 준다
      const prevBest = (await evaluate(session, attempts.filter(a => a.id !== attempt.id)))
        .stages.find(s => s.scenario_id === scenario.id).best_trust;
      body.stage_result = { trust: after.trust, previous_best: prevBest, improved: prevBest == null || after.trust > prevBest };
    }
    const ev = await evaluate(session, attempts);
    // 이 답으로 잃은 돈 (규칙 v2의 치명타, 본 도전일 때만): 방금 기록한 치명타가 가장 마지막 손실이다
    body.loss = option.type === 'wrong' && !rules.wrong_is_fatal && !attempt.is_replay ? ev.last_loss : 0;
    body.summary = summaryOf(ev);
    return body;
  };

  router.post('/attempts/:id/answers', h(async (req, res) => {
    const { attempt, session } = await ownAttempt(req, req.params.id);
    const { turn_id, option_id, hint_used = false } = req.body || {};
    const ctx = await currentTurn(attempt, session, turn_id);
    const option = ctx.turn.options.find(o => o.id === option_id);
    if (!option) throw bad('INVALID_OPTION', '이 턴에 없는 선택지입니다.');
    res.json(await applyOption({ attempt, session, ...ctx, option, hintUsed: hint_used }));
  }));

  /* ---------- 직접 답장: AI가 판정한 유형의 선택지를 고른 것으로 기록한다 ---------- */
  // 간이 사용량 제한 (함수 인스턴스 단위, 심사 기간용): 플레이어 토큰별 + IP별 + 시간당 총량
  const freeHits = new Map();
  const FREE_LIMIT = 60, IP_LIMIT = 120, FREE_WINDOW_MS = 10 * 60 * 1000;
  const HOURLY_CAP = Number(process.env.AI_HOURLY_CAP) || 1500;   // 비용 안전장치
  let hour = { start: 0, n: 0 };
  const over = (key, limit, now) => {
    const arr = (freeHits.get(key) || []).filter(t => now - t < FREE_WINDOW_MS);
    arr.push(now); freeHits.set(key, arr);
    return arr.length > limit;
  };
  const freeLimited = (token, ip) => {
    const now = Date.now();
    if (now - hour.start > 60 * 60 * 1000) hour = { start: now, n: 0 };
    if (++hour.n > HOURLY_CAP) return true;
    if (freeHits.size > 5000) for (const [k, v] of freeHits) if (now - v[v.length - 1] > FREE_WINDOW_MS) freeHits.delete(k);
    return over('t:' + token, FREE_LIMIT, now) | over('ip:' + ip, IP_LIMIT, now);
  };
  const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';

  router.post('/attempts/:id/free-answers', h(async (req, res) => {
    const { attempt, session } = await ownAttempt(req, req.params.id);
    const { turn_id, text, hint_used = false } = req.body || {};
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 200) throw bad('INVALID_TEXT', '답장은 1~200자여야 합니다.');
    const pii = findPii(clean);
    if (pii) throw bad('PERSONAL_INFO', `${pii}처럼 보이는 내용은 보낼 수 없습니다.`, { kind: pii });
    if (freeLimited(session.player_token, clientIp(req))) throw new ApiError(429, 'TOO_MANY', '잠시 후 다시 시도해 주세요.');

    const ctx = await currentTurn(attempt, session, turn_id);
    const nextTurn = ctx.scenario.turns[ctx.before.nextTurnIndex + 1] || null;
    let verdict;
    try {
      verdict = await judge({ scenario: ctx.scenario, turn: ctx.turn, nextTurn, text: clean });
    } catch (e) {
      if (e.code === 'AI_DISABLED') throw new ApiError(503, 'AI_DISABLED', 'AI 채점이 꺼져 있습니다. 선택지로 진행해 주세요.');
      console.error('AI 채점 실패:', e.cause || e);
      throw new ApiError(503, 'AI_FAILED', 'AI 채점에 실패했습니다. 선택지로 진행해 주세요.');
    }
    // 진짜 메시지 턴에는 치명타(wrong) 선택지가 없을 수 있다 → 빈틈으로 기록
    const option = ctx.turn.options.find(o => o.type === verdict.type) || ctx.turn.options.find(o => o.type === 'trap');
    const body = await applyOption({ attempt, session, ...ctx, option, hintUsed: hint_used });
    // AI 설명이 있으면 그걸 보여 주고, 같은 상황의 모범 답안(정답 선택지)도 함께 알려 준다
    if (verdict.feedback) body.feedback = verdict.feedback;
    body.reply = verdict.reply || '';
    body.matched_option_id = option.id;
    body.model_answer = verdict.type === 'correct' ? null : ctx.turn.options.find(o => o.type === 'correct').text;
    res.json(body);
  }));

  /* ---------- 대화 속 링크 열기 (규칙 v2: 본 도전에서 연 링크마다 돈을 잃는다) ---------- */
  router.post('/attempts/:id/link-clicks', h(async (req, res) => {
    const { attempt, session } = await ownAttempt(req, req.params.id);
    const url = String((req.body || {}).url || '').trim().slice(0, 300);
    const scenario = content.scenarioById.get(attempt.scenario_id);
    // 이 사건 메시지에 실제로 있는 링크만 받는다
    if (!url || !scenario.turns.some(t => t.scammer_msg.includes(url))) throw bad('INVALID_URL', '이 대화에 없는 링크입니다.');
    const rules = loadRules(session.scoring_version);
    let charged = false;
    if (attempt.status === 'playing' && !attempt.is_replay && !rules.wrong_is_fatal) charged = await store.recordLinkClick(attempt.id, url);
    const ev = await evaluate(session, await store.sessionAttempts(session.id));
    res.json({ charged, loss: charged ? ev.last_loss : 0, summary: summaryOf(ev) });
  }));

  /* ---------- 마무리·리포트 ---------- */
  router.post('/sessions/:id/finish', h(async (req, res) => {
    const session = await ownSession(req, req.params.id);
    const post = req.body?.post_confidence;
    if (!isScale(post)) throw bad('INVALID_CONFIDENCE', 'post_confidence는 1~5 정수여야 합니다.');
    const ev = await evaluate(session);
    if (!ev.report_ready) throw new ApiError(409, 'NOT_READY', '모든 사건을 막아 낸 뒤에 리포트를 볼 수 있습니다.', { progress: ev.progress });
    await store.finishSession(session.id, post);
    res.json(withReveals(await evaluate(await store.getSession(session.id))));
  }));

  router.get('/sessions/:id/report', h(async (req, res) => {
    const session = await ownSession(req, req.params.id);
    const ev = await evaluate(session);
    if (!ev.report_ready) throw new ApiError(409, 'NOT_READY', '모든 사건을 막아 낸 뒤에 리포트를 볼 수 있습니다.', { progress: ev.progress });
    res.json(withReveals(ev));
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
