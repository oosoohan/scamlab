/**
 * 세션 전체 평가. 답안 기록 → 진행 상황·점수·등급·오답 노트. 순수 함수.
 *
 * 지금 프론트(index_v2.html)의 계산과 같은 결과를 내도록 맞췄다.
 *  - 단계 신뢰도   : 그 사건을 막아 낸 도전들 중 가장 높은 남은 신뢰도 (다시 해 보기로 최고 기록 갱신)
 *  - 빈틈·치명타·오답 노트·취약 유형 : 본 도전(is_replay=0)만 센다 (다시 해 보기는 연습이라 통계에서 빠짐)
 *  - 재도전 수     : 본 도전 중 실패한 횟수
 *  - 힌트 수       : 본 도전에서 힌트를 쓴 턴 수
 *  - 찾은 위험 신호 : 응답한 모든 턴(다시 해 보기 포함)의 위험 신호 합집합
 *  - 방어 점수     : max(0, round(평균 단계 신뢰도) − 재도전×retry_penalty − 힌트×hint_penalty)
 */
const { foldAttempt } = require('./attempt');

/**
 * @param {object} p
 * @param {object} p.content   loadContent() 결과
 * @param {{ id:number, scenario_id:number, is_replay:boolean|number, answers:{turn_id:number, option_id:string, hint_used:boolean|number}[] }[]} p.attempts  시작 순서대로
 * @param {object} p.rules
 * @param {number|null} p.pre
 * @param {number|null} p.post
 */
// 세션 id로 고정되는 난수: 같은 기록이면 몇 번을 다시 계산해도 같은 금액이 나온다
function seededRandom(seed, k) {
  let h = 2166136261 >>> 0;
  for (const ch of `${seed}:${k}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0; h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function evaluateSession({ content, attempts, rules, pre = null, post = null, seed = '' }) {
  const stats = { correct: 0, trap: 0, wrong: 0, hints: 0, retries: 0 };
  const found = new Set();
  const mistakes = [];
  const stageMap = new Map(content.scenarios.map(s => [s.id, { scenario_id: s.id, is_scam: s.is_scam !== false, cleared: false, failed: false, first_try: null, best_trust: null, misses: 0, attempts: 0 }]));
  let lastMainFailed = false;
  // 규칙 v2: 본 도전의 치명타·링크 열기 = '털림'. 일어난 순서대로 세 번이면 잔고 0 (다시 해 보기는 돈을 잃지 않음)
  const lossEvents = [];
  let linkClicks = 0;

  for (const at of attempts) {
    const scenario = content.scenarioById.get(at.scenario_id);
    const stage = stageMap.get(at.scenario_id);
    if (!scenario || !stage) continue; // 숨겨진(비활성) 사건
    const main = !at.is_replay;
    const result = foldAttempt(scenario, at.answers, rules);
    stage.attempts++;

    for (const a of at.answers) {
      const turn = content.turnById.get(a.turn_id);
      turn.flags.forEach(f => found.add(f));
      if (!main) continue;
      const opt = content.optionById.get(a.option_id);
      stats[opt.type]++;
      if (a.hint_used) stats.hints++;
      if (opt.type !== 'correct') {
        const right = turn.options.find(o => o.type === 'correct');
        stage.misses++;
        mistakes.push({
          scenario_id: scenario.id, is_scam: scenario.is_scam !== false, platform: scenario.platform, turn: turn.turn_no, type: opt.type,
          mine: opt.text, right: right.text, why: right.feedback
        });
      }
    }

    if (result.status === 'failed') stage.failed = true;
    // 첫 본 도전의 결과 = 처음 봤을 때 제대로 판단했는지
    if (main && stage.first_try === null && result.status !== 'playing') stage.first_try = result.status === 'cleared';
    if (result.status === 'cleared') {
      stage.cleared = true;
      stage.best_trust = Math.max(stage.best_trust ?? 0, result.trust);
    }
    if (main) {
      at.answers.forEach((a, i) => {
        if (content.optionById.get(a.option_id).type === 'wrong') lossEvents.push({ at: a.answered_at || '', seq: lossEvents.length });
      });
      for (const c of at.clicks || []) {
        linkClicks++;
        lossEvents.push({ at: (c && c.at) || '', seq: lossEvents.length });
      }
      if (result.status === 'failed') stats.retries++;
      // 돈을 잃는 건 사기에 당했을 때만. 진짜 메시지를 놓친 실패는 잔고를 건드리지 않는다
      lastMainFailed = result.status === 'failed' && scenario.is_scam !== false;
    }
  }

  // 시간 순으로 털림을 센다. k번째 털림은 strike_ranges[k] 범위의 무작위 비율, 마지막(strikes_to_zero번째)은 남은 돈 전부
  lossEvents.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq));
  let balanceV2 = rules.start_balance, lastLoss = 0;
  const unit = rules.loss_unit || 1, ranges = rules.strike_ranges || [], toZero = rules.strikes_to_zero || 3;
  lossEvents.forEach((e, k) => {
    let take = 0;
    if (k + 1 >= toZero) take = balanceV2;
    else {
      const [lo, hi] = ranges[k] || [0.3, 0.5];
      const base = k === 0 ? rules.start_balance : balanceV2;
      take = Math.min(balanceV2, Math.max(unit, Math.round(base * (lo + (hi - lo) * seededRandom(seed, k)) / unit) * unit));
    }
    balanceV2 -= take; lastLoss = take;
  });

  const stages = [...stageMap.values()];
  const clearedCount = stages.filter(s => s.cleared).length;
  const reportReady = clearedCount === stages.length && stages.length > 0;

  const maxMiss = Math.max(0, ...stages.map(s => s.misses));
  const weak = maxMiss > 0 ? stages.filter(s => s.misses === maxMiss).map(s => s.scenario_id) : [];

  let score = null, grade = null, avgTrust = null;
  if (reportReady) {
    avgTrust = Math.round(stages.reduce((sum, s) => sum + s.best_trust, 0) / stages.length);
    const penalty = stats.retries * rules.retry_penalty + stats.hints * rules.hint_penalty;
    score = Math.max(0, avgTrust - penalty);
    grade = rules.grades.find(g => score >= g.min) || rules.grades[rules.grades.length - 1];
  }

  // 판단력: 사기는 첫 도전에 막았는지, 진짜는 첫 도전에 제대로 처리했는지
  const judged = kind => stages.filter(s => s.is_scam === kind);
  const judgment = {
    scam_total: judged(true).length, scam_first_try: judged(true).filter(s => s.first_try).length,
    legit_total: judged(false).length, legit_first_try: judged(false).filter(s => s.first_try).length
  };

  return {
    scoring_version: rules.version,
    judgment,
    report_ready: reportReady,
    progress: { cleared: clearedCount, total: stages.length },
    balance: rules.wrong_is_fatal ? (lastMainFailed ? 0 : rules.start_balance) : balanceV2,
    lost: rules.wrong_is_fatal ? null : rules.start_balance - balanceV2,
    last_loss: rules.wrong_is_fatal ? null : lastLoss,
    link_clicks: linkClicks,
    strikes: rules.wrong_is_fatal ? null : lossEvents.length,
    stages,
    found_flags: content.flags.filter(f => found.has(f.id)).map(f => f.id),
    flag_total: content.flags.length,
    stats,
    weak_scenarios: weak,
    mistakes,
    avg_trust: avgTrust,
    score,
    grade: grade && { grade: grade.grade, title: grade.title, message: grade.message },
    confidence: { pre, post, delta: pre != null && post != null ? post - pre : null }
  };
}

module.exports = { evaluateSession };
