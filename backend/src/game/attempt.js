/**
 * 한 번의 도전(stage attempt)을 답안 기록으로부터 다시 계산한다. DB도 HTTP도 모르는 순수 함수.
 *
 * @param {{ turns: { id:number, options: { id:string, type:'correct'|'trap'|'wrong' }[] }[] }} scenario
 * @param {{ turn_id:number, option_id:string }[]} answers  턴 순서대로
 * @param {object} rules  rules/<version>.json
 * @returns {{ trust:number, status:'playing'|'cleared'|'failed', failCause:null|'fatal'|'trust_depleted', nextTurnIndex:number }}
 */
function foldAttempt(scenario, answers, rules) {
  let trust = rules.start_trust;
  let status = 'playing';
  let failCause = null;

  for (let i = 0; i < answers.length; i++) {
    const turn = scenario.turns[i];
    const a = answers[i];
    if (!turn || a.turn_id !== turn.id) throw new Error(`답안 순서가 맞지 않습니다 (index ${i})`);
    const opt = turn.options.find(o => o.id === a.option_id);
    if (!opt) throw new Error(`턴 ${turn.id}에 없는 선택지: ${a.option_id}`);

    if (opt.type === 'trap') {
      trust = Math.max(0, trust - rules.trap_penalty);
      if (trust <= 0) { status = 'failed'; failCause = 'trust_depleted'; break; }
    } else if (opt.type === 'wrong' && rules.wrong_is_fatal) {
      status = 'failed'; failCause = 'fatal'; break;
    }
  }

  if (status === 'playing' && answers.length === scenario.turns.length) status = 'cleared';
  return { trust, status, failCause, nextTurnIndex: answers.length };
}

module.exports = { foldAttempt };
