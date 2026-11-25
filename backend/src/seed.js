/**
 * content/*.json → DB 콘텐츠 테이블.
 * 여러 번 실행해도 된다(upsert). 턴·선택지 id가 고정이라 기존 플레이 기록이 깨지지 않는다.
 */
const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.resolve(__dirname, '../../content');
const turnIdOf = (stageId, turnNo) => stageId * 100 + turnNo;

function loadContentFiles(dir = CONTENT_DIR) {
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  return { scenarios: read('scenarios.json'), flags: read('flags.json'), lessons: read('lessons.json') };
}

/** 메시지 원문에 어떤 위험 신호가 들어 있는지 (프론트 formatMsg와 같은 정규식) */
function detectFlags(text, flags) {
  return flags
    .filter(f => new RegExp(f.pattern, f.pattern_flags.replace('g', '')).test(text))
    .map(f => f.id);
}

function seedContent(db, content = loadContentFiles()) {
  const { scenarios, flags, lessons } = content;

  const upScenario = db.prepare(`
    INSERT INTO scenarios (id, sort_order, scam_type, platform, title, icon, scammer_name, scammer_status, game_over_reason, is_active)
    VALUES (@id, @sort_order, @scam_type, @platform, @title, @icon, @scammer_name, @scammer_status, @game_over_reason, 1)
    ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order, scam_type=excluded.scam_type, platform=excluded.platform,
      title=excluded.title, icon=excluded.icon, scammer_name=excluded.scammer_name, scammer_status=excluded.scammer_status,
      game_over_reason=excluded.game_over_reason, is_active=1`);
  const upTurn = db.prepare(`
    INSERT INTO turns (id, scenario_id, turn_no, scammer_msg) VALUES (@id, @scenario_id, @turn_no, @scammer_msg)
    ON CONFLICT(id) DO UPDATE SET scammer_msg=excluded.scammer_msg`);
  const upOption = db.prepare(`
    INSERT INTO options (id, turn_id, text, type, feedback) VALUES (@id, @turn_id, @text, @type, @feedback)
    ON CONFLICT(id) DO UPDATE SET text=excluded.text, type=excluded.type, feedback=excluded.feedback`);
  const upFlag = db.prepare(`
    INSERT INTO flags (id, sort_order, label, pattern, pattern_flags, why) VALUES (@id, @order, @label, @pattern, @pattern_flags, @why)
    ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order, label=excluded.label, pattern=excluded.pattern,
      pattern_flags=excluded.pattern_flags, why=excluded.why`);
  const insTurnFlag = db.prepare('INSERT OR IGNORE INTO turn_flags (turn_id, flag_id) VALUES (?, ?)');
  const insLesson = db.prepare('INSERT INTO lessons (scenario_id, sort_order, text) VALUES (?, ?, ?)');

  const stats = { scenarios: 0, turns: 0, options: 0, flags: 0, turnFlags: 0, lessons: 0 };

  db.transaction(() => {
    for (const f of flags) { upFlag.run(f); stats.flags++; }

    // 이번 콘텐츠에 없는 사건은 지우지 않고 숨긴다 (예전 기록 보존)
    const ids = scenarios.map(s => s.stage_id);
    db.prepare(`UPDATE scenarios SET is_active = 0 WHERE id NOT IN (${ids.map(() => '?').join(',')})`).run(...ids);

    db.exec('DELETE FROM turn_flags; DELETE FROM lessons;');

    for (const s of scenarios) {
      upScenario.run({
        id: s.stage_id, sort_order: s.order, scam_type: s.scam_type, platform: s.platform,
        title: s.title, icon: s.icon, scammer_name: s.scammer_profile.name,
        scammer_status: s.scammer_profile.status_message, game_over_reason: s.game_over_reason
      });
      stats.scenarios++;
      for (const t of s.turns) {
        const turnId = turnIdOf(s.stage_id, t.turn);
        upTurn.run({ id: turnId, scenario_id: s.stage_id, turn_no: t.turn, scammer_msg: t.scammer_msg });
        stats.turns++;
        for (const o of t.options) { upOption.run({ ...o, turn_id: turnId }); stats.options++; }
        for (const fid of detectFlags(t.scammer_msg, flags)) { insTurnFlag.run(turnId, fid); stats.turnFlags++; }
      }
      (lessons[s.stage_id] || []).forEach((text, i) => { insLesson.run(s.stage_id, i + 1, text); stats.lessons++; });
    }
  })();

  return stats;
}

module.exports = { seedContent, loadContentFiles, detectFlags, turnIdOf };
