/**
 * 플레이 기록 읽기/쓰기. SQL은 여기에만 둔다.
 * 함께 바뀌어야 하는 쓰기는 batch(한 트랜잭션)로 묶는다 — Turso에서도 요청 한 번.
 */
const { plain, rows } = require('./db');

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

function createStore(db) {
  const one = async (sql, args = []) => plain((await db.execute({ sql, args })).rows[0]);
  const all = async (sql, args = []) => rows(await db.execute({ sql, args }));

  return {
    db,

    createSession: (id, token, pre, version) => db.execute({
      sql: 'INSERT INTO play_sessions (id, player_token, pre_confidence, scoring_version) VALUES (?, ?, ?, ?)',
      args: [id, token, pre, version]
    }),
    getSession: id => one('SELECT * FROM play_sessions WHERE id = ?', [id]),
    finishSession: (id, post) => db.execute({
      sql: `UPDATE play_sessions SET post_confidence = ?, finished_at = COALESCE(finished_at, ${NOW}) WHERE id = ?`,
      args: [post, id]
    }),

    getAttempt: id => one('SELECT * FROM stage_attempts WHERE id = ?', [id]),
    playingAttempt: sessionId => one(`SELECT * FROM stage_attempts WHERE session_id = ? AND status = 'playing' ORDER BY id DESC LIMIT 1`, [sessionId]),
    answersOfAttempt: attemptId => all(`SELECT a.turn_id, a.option_id, a.hint_used FROM answers a JOIN turns t ON t.id = a.turn_id
                                        WHERE a.attempt_id = ? ORDER BY t.turn_no`, [attemptId]),

    /** 진행 중인 도전은 버리고(abandoned) 새 도전을 만든다 */
    async startAttempt(sessionId, scenarioId, isReplay) {
      const [, ins] = await db.batch([
        { sql: `UPDATE stage_attempts SET status = 'abandoned', ended_at = ${NOW} WHERE session_id = ? AND status = 'playing'`, args: [sessionId] },
        { sql: `INSERT INTO stage_attempts (session_id, scenario_id, attempt_no, is_replay)
                SELECT ?, ?, COUNT(*) + 1, ? FROM stage_attempts WHERE session_id = ? AND scenario_id = ?`,
          args: [sessionId, scenarioId, isReplay ? 1 : 0, sessionId, scenarioId] }
      ], 'write');
      return one('SELECT * FROM stage_attempts WHERE id = ?', [Number(ins.lastInsertRowid)]);
    },

    /** 답안 저장 + (끝났으면) 도전 상태 변경을 한 번에. 같은 턴에 두 번 답하면 UNIQUE 제약으로 실패한다 */
    recordAnswer(attemptId, turnId, optionId, hintUsed, endStatus) {
      const stmts = [{ sql: 'INSERT INTO answers (attempt_id, turn_id, option_id, hint_used) VALUES (?, ?, ?, ?)',
                       args: [attemptId, turnId, optionId, hintUsed ? 1 : 0] }];
      if (endStatus) stmts.push({ sql: `UPDATE stage_attempts SET status = ?, ended_at = ${NOW} WHERE id = ?`, args: [endStatus, attemptId] });
      return db.batch(stmts, 'write');
    },

    /** 링크를 연 기록. 같은 도전에서 같은 링크를 다시 열면 기록하지 않고 false */
    async recordLinkClick(attemptId, url) {
      const r = await db.execute({ sql: 'INSERT OR IGNORE INTO link_clicks (attempt_id, url) VALUES (?, ?)', args: [attemptId, url] });
      return r.rowsAffected > 0;
    },

    /** 세션의 모든 도전과 답안(+연 링크)을 평가 함수가 받는 모양으로 */
    async sessionAttempts(sessionId) {
      const [atRs, ansRs, clickRs] = await db.batch([
        { sql: 'SELECT * FROM stage_attempts WHERE session_id = ? ORDER BY id', args: [sessionId] },
        { sql: `SELECT a.attempt_id, a.turn_id, a.option_id, a.hint_used, a.answered_at FROM answers a
                JOIN stage_attempts s ON s.id = a.attempt_id JOIN turns t ON t.id = a.turn_id
                WHERE s.session_id = ? ORDER BY a.attempt_id, t.turn_no`, args: [sessionId] },
        { sql: `SELECT c.attempt_id, c.url, c.clicked_at FROM link_clicks c JOIN stage_attempts s ON s.id = c.attempt_id
                WHERE s.session_id = ? ORDER BY c.clicked_at`, args: [sessionId] }
      ], 'read');
      const attempts = rows(atRs).map(a => ({ ...a, answers: [], clicks: [] }));
      const byId = new Map(attempts.map(a => [a.id, a]));
      for (const ans of rows(ansRs)) byId.get(ans.attempt_id).answers.push(ans);
      for (const c of rows(clickRs)) byId.get(c.attempt_id).clicks.push({ url: c.url, at: c.clicked_at });
      return attempts;
    },

    /** 운영자용 문항 통계 원자료 (다시 해 보기 제외) */
    itemStats: () => all(`SELECT a.turn_id, a.option_id, COUNT(*) AS n, SUM(a.hint_used) AS hinted
                          FROM answers a JOIN stage_attempts s ON s.id = a.attempt_id
                          WHERE s.is_replay = 0 GROUP BY a.turn_id, a.option_id`)
  };
}

module.exports = { createStore };
