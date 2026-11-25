/**
 * DB 콘텐츠를 메모리로 읽어 둔다. 콘텐츠는 시드할 때만 바뀌므로 서버 시작 시 한 번 읽고 재사용한다.
 */
const { rows } = require('./db');

async function loadContent(db) {
  const [scenarios, turns, options, turnFlags, flags, lessons] = (await db.batch([
    'SELECT * FROM scenarios WHERE is_active = 1 ORDER BY sort_order',
    'SELECT * FROM turns ORDER BY scenario_id, turn_no',
    'SELECT * FROM options ORDER BY id',
    'SELECT tf.turn_id, tf.flag_id FROM turn_flags tf JOIN flags f ON f.id = tf.flag_id ORDER BY f.sort_order',
    'SELECT id, label, pattern, pattern_flags, why FROM flags ORDER BY sort_order',
    'SELECT * FROM lessons ORDER BY scenario_id, sort_order'
  ], 'read')).map(rows);

  const optionById = new Map();
  const turnById = new Map();
  const scenarioById = new Map();

  for (const s of scenarios) {
    s.is_scam = s.is_scam == null ? true : !!s.is_scam;
    s.turns = [];
    s.lessons = [];
    scenarioById.set(s.id, s);
  }
  for (const t of turns) {
    t.options = [];
    t.flags = [];
    turnById.set(t.id, t);
    scenarioById.get(t.scenario_id)?.turns.push(t);
  }
  // 선택지 id는 무작위 값이라 id만 보고는 정답을 알 수 없다. 화면에서 순서를 섞는 것은 프론트 몫이다.
  for (const o of options) {
    optionById.set(o.id, o);
    turnById.get(o.turn_id)?.options.push(o);
  }
  for (const tf of turnFlags) turnById.get(tf.turn_id)?.flags.push(tf.flag_id);
  for (const l of lessons) scenarioById.get(l.scenario_id)?.lessons.push(l.text);

  return { scenarios, flags, optionById, turnById, scenarioById };
}

/**
 * 브라우저로 보내는 콘텐츠. 정답 여부(type)·피드백·게임오버 사유는 빼고 보낸다.
 * 사기인지 진짜인지(is_scam)와 그걸 드러내는 제목·유형·교훈도 빼고, 대화가 끝났을 때 revealOf()로 알려 준다.
 */
function publicContent(content) {
  return {
    scenarios: content.scenarios.map(s => ({
      stage_id: s.id,
      platform: s.platform,
      icon: s.icon,
      scammer_profile: { name: s.scammer_name, status_message: s.scammer_status },
      turns: s.turns.map(t => ({
        turn_id: t.id,
        turn: t.turn_no,
        scammer_msg: t.scammer_msg,
        options: t.options.map(o => ({ option_id: o.id, text: o.text }))
      }))
    })),
    flags: content.flags
  };
}

/** 대화가 끝난 사건의 정체: 사기였는지, 어떤 수법(또는 어떤 정상 메시지)이었는지, 교훈 */
const revealOf = s => ({ is_scam: s.is_scam, title: s.title, scam_type: s.scam_type, lessons: s.lessons });

module.exports = { loadContent, publicContent, revealOf };
