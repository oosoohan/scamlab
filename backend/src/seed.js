/**
 * content/*.json → DB 콘텐츠 테이블.
 * 여러 번 실행해도 된다(upsert). 턴·선택지 id가 고정이라 기존 플레이 기록이 깨지지 않는다.
 * 모든 문장을 한 번의 batch(트랜잭션)로 보내므로 Turso에서도 요청 한 번이다.
 */
const fs = require('fs');
const path = require('path');
const { hashOf } = require('./db');

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

async function seedContent(db, content = loadContentFiles()) {
  const { scenarios, flags, lessons } = content;
  const stmts = [];
  const add = (sql, args = []) => stmts.push({ sql, args });
  const stats = { scenarios: 0, turns: 0, options: 0, flags: 0, turnFlags: 0, lessons: 0 };

  for (const f of flags) {
    add(`INSERT INTO flags (id, sort_order, label, pattern, pattern_flags, why) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order, label=excluded.label, pattern=excluded.pattern,
           pattern_flags=excluded.pattern_flags, why=excluded.why`,
        [f.id, f.order, f.label, f.pattern, f.pattern_flags, f.why]);
    stats.flags++;
  }

  // 이번 콘텐츠에 없는 사건은 지우지 않고 숨긴다 (예전 기록 보존)
  const ids = scenarios.map(s => s.stage_id);
  add(`UPDATE scenarios SET is_active = 0 WHERE id NOT IN (${ids.map(() => '?').join(',')})`, ids);
  add('DELETE FROM turn_flags');
  add('DELETE FROM lessons');

  for (const s of scenarios) {
    add(`INSERT INTO scenarios (id, sort_order, scam_type, platform, title, icon, scammer_name, scammer_status, game_over_reason, is_active, is_scam)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order, scam_type=excluded.scam_type, platform=excluded.platform,
           title=excluded.title, icon=excluded.icon, scammer_name=excluded.scammer_name, scammer_status=excluded.scammer_status,
           game_over_reason=excluded.game_over_reason, is_active=1, is_scam=excluded.is_scam`,
        [s.stage_id, s.order, s.scam_type, s.platform, s.title, s.icon, s.scammer_profile.name, s.scammer_profile.status_message, s.game_over_reason, s.is_scam === false ? 0 : 1]);
    stats.scenarios++;
    for (const t of s.turns) {
      const turnId = turnIdOf(s.stage_id, t.turn);
      add(`INSERT INTO turns (id, scenario_id, turn_no, scammer_msg) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET scammer_msg=excluded.scammer_msg`, [turnId, s.stage_id, t.turn, t.scammer_msg]);
      stats.turns++;
      for (const o of t.options) {
        add(`INSERT INTO options (id, turn_id, text, type, feedback) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET text=excluded.text, type=excluded.type, feedback=excluded.feedback`,
            [o.id, turnId, o.text, o.type, o.feedback]);
        stats.options++;
      }
      for (const fid of detectFlags(t.scammer_msg, flags)) {
        add('INSERT OR IGNORE INTO turn_flags (turn_id, flag_id) VALUES (?, ?)', [turnId, fid]);
        stats.turnFlags++;
      }
    }
    (lessons[s.stage_id] || []).forEach((text, i) => {
      add('INSERT INTO lessons (scenario_id, sort_order, text) VALUES (?, ?, ?)', [s.stage_id, i + 1, text]);
      stats.lessons++;
    });
  }

  add(`INSERT INTO meta (key, value) VALUES ('content_hash', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [hashOf(content)]);
  await db.batch(stmts, 'write');
  return stats;
}

/**
 * content/*.json 이 DB에 들어 있는 것과 다를 때만 시드한다.
 * 서버가 켜질 때마다 부르면, JSON을 고쳐 배포하는 것만으로 DB가 따라온다.
 */
async function seedIfChanged(db, content = loadContentFiles()) {
  const rs = await db.execute(`SELECT value FROM meta WHERE key = 'content_hash'`);
  if (rs.rows[0]?.value === hashOf(content)) return null;
  return seedContent(db, content);
}

module.exports = { seedContent, seedIfChanged, loadContentFiles, detectFlags, turnIdOf };
