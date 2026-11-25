/**
 * 한 번의 도전(stage attempt)을 답안·사건 기록으로부터 다시 계산한다. DB도 HTTP도 모르는 순수 함수.
 *
 * 턴마다 순서: (그 턴에 일어난 사건들 → 그 턴의 답)
 *  - 사건 'bait'(가짜 링크 페이지에 낚임): 신뢰도 −bait_penalty
 *  - 답 trap: 신뢰도 −trap_penalty / 답 wrong: 즉시 실패
 *  - 신뢰도가 0이 되면 실패
 *
 * @param {{ turns: { id:number, options: { id:string, type:'correct'|'trap'|'wrong' }[] }[] }} scenario
 * @param {{ turn_id:number, option_id:string }[]} answers  턴 순서대로
 * @param {object} rules  rules/<version>.json
 * @param {{ turn_id:number, kind:string }[]} [events]
 * @returns {{ trust:number, status:'playing'|'cleared'|'failed', failCause:null|'fatal'|'trust_depleted', nextTurnIndex:number }}
 */
function foldAttempt(scenario, answers, rules, events = []) {
  let trust = rules.start_trust;
  let status = 'playing';
  let failCause = null;
  const baitPenalty = rules.bait_penalty ?? rules.trap_penalty;

  const eventsByTurn = new Map();
  for (const e of events) {
    if (!eventsByTurn.has(e.turn_id)) eventsByTurn.set(e.turn_id, []);
    eventsByTurn.get(e.turn_id).push(e);
  }
  const deplete = amount => {
    trust = Math.max(0, trust - amount);
    if (trust <= 0) { status = 'failed'; failCause = 'trust_depleted'; }
  };

  // 답한 턴들 + 지금 답을 기다리는 턴(사건만 있을 수 있음)
  for (let i = 0; i <= answers.length && i < scenario.turns.length && status === 'playing'; i++) {
    const turn = scenario.turns[i];
    for (const e of eventsByTurn.get(turn.id) || []) {
      if (e.kind === 'bait') deplete(baitPenalty);
      if (status !== 'playing') break;
    }
    if (status !== 'playing' || i === answers.length) break;

    const a = answers[i];
    if (a.turn_id !== turn.id) throw new Error(`답안 순서가 맞지 않습니다 (index ${i})`);
    const opt = turn.options.find(o => o.id === a.option_id);
    if (!opt) throw new Error(`턴 ${turn.id}에 없는 선택지: ${a.option_id}`);

    if (opt.type === 'trap') deplete(rules.trap_penalty);
    else if (opt.type === 'wrong' && rules.wrong_is_fatal) { status = 'failed'; failCause = 'fatal'; }
  }

  if (status === 'playing' && answers.length === scenario.turns.length) status = 'cleared';
  return { trust, status, failCause, nextTurnIndex: answers.length };
}

module.exports = { foldAttempt };
