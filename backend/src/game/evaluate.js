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
function evaluateSession({ content, attempts, rules, pre = null, post = null }) {
  const stats = { correct: 0, trap: 0, wrong: 0, hints: 0, retries: 0 };
  const found = new Set();
  const mistakes = [];
  const stageMap = new Map(content.scenarios.map(s => [s.id, { scenario_id: s.id, is_scam: s.is_scam !== false, cleared: false, failed: false, first_try: null, best_trust: null, misses: 0, attempts: 0 }]));
  let lastMainFailed = false;
  // 규칙 v2: 본 도전의 치명타·링크 열기로 잃은 돈이 게임 전체에서 누적된다 (다시 해 보기는 돈을 잃지 않음)
  let lost = 0, linkClicks = 0;

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
      lost += result.wrongs * (rules.wrong_loss || 0);
      linkClicks += (at.clicks || []).length;
      lost += (at.clicks || []).length * (rules.link_loss || 0);
      if (result.status === 'failed') stats.retries++;
      // 돈을 잃는 건 사기에 당했을 때만. 진짜 메시지를 놓친 실패는 잔고를 건드리지 않는다
      lastMainFailed = result.status === 'failed' && scenario.is_scam !== false;
    }
  }

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
    balance: rules.wrong_is_fatal ? (lastMainFailed ? 0 : rules.start_balance) : Math.max(0, rules.start_balance - lost),
    lost: rules.wrong_is_fatal ? null : Math.min(lost, rules.start_balance),
    link_clicks: linkClicks,
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
