/**
 * 플레이 기록 읽기/쓰기. SQL은 여기에만 둔다.
 */
function createStore(db) {
  const q = {
    insertSession: db.prepare(`INSERT INTO play_sessions (id, player_token, pre_confidence, scoring_version) VALUES (?, ?, ?, ?)`),
    getSession: db.prepare('SELECT * FROM play_sessions WHERE id = ?'),
    finishSession: db.prepare(`UPDATE play_sessions SET post_confidence = ?, finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE id = ?`),

    getAttempt: db.prepare('SELECT * FROM stage_attempts WHERE id = ?'),
    attemptsOfSession: db.prepare('SELECT * FROM stage_attempts WHERE session_id = ? ORDER BY id'),
    playingAttempt: db.prepare(`SELECT * FROM stage_attempts WHERE session_id = ? AND status = 'playing' ORDER BY id DESC LIMIT 1`),
    abandonPlaying: db.prepare(`UPDATE stage_attempts SET status = 'abandoned', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = ? AND status = 'playing'`),
    countAttempts: db.prepare('SELECT COUNT(*) AS n FROM stage_attempts WHERE session_id = ? AND scenario_id = ?'),
    insertAttempt: db.prepare('INSERT INTO stage_attempts (session_id, scenario_id, attempt_no, is_replay) VALUES (?, ?, ?, ?)'),
    endAttempt: db.prepare(`UPDATE stage_attempts SET status = ?, ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`),

    answersOfAttempt: db.prepare(`SELECT a.turn_id, a.option_id, a.hint_used FROM answers a JOIN turns t ON t.id = a.turn_id WHERE a.attempt_id = ? ORDER BY t.turn_no`),
    answersOfSession: db.prepare(`SELECT a.attempt_id, a.turn_id, a.option_id, a.hint_used FROM answers a
                                  JOIN stage_attempts s ON s.id = a.attempt_id JOIN turns t ON t.id = a.turn_id
                                  WHERE s.session_id = ? ORDER BY a.attempt_id, t.turn_no`),
    insertAnswer: db.prepare('INSERT INTO answers (attempt_id, turn_id, option_id, hint_used) VALUES (?, ?, ?, ?)')
  };

  return {
    db,
    createSession: (id, token, pre, version) => q.insertSession.run(id, token, pre, version),
    getSession: id => q.getSession.get(id),
    finishSession: (id, post) => q.finishSession.run(post, id),

    getAttempt: id => q.getAttempt.get(id),
    playingAttempt: sessionId => q.playingAttempt.get(sessionId),
    answersOfAttempt: attemptId => q.answersOfAttempt.all(attemptId),
    insertAnswer: (attemptId, turnId, optionId, hint) => q.insertAnswer.run(attemptId, turnId, optionId, hint ? 1 : 0),
    endAttempt: (attemptId, status) => q.endAttempt.run(status, attemptId),

    /** 진행 중인 도전은 버리고(abandoned) 새 도전을 만든다 */
    startAttempt(sessionId, scenarioId, isReplay) {
      return db.transaction(() => {
        q.abandonPlaying.run(sessionId);
        const n = q.countAttempts.get(sessionId, scenarioId).n;
        const info = q.insertAttempt.run(sessionId, scenarioId, n + 1, isReplay ? 1 : 0);
        return q.getAttempt.get(info.lastInsertRowid);
      })();
    },

    /** 세션의 모든 도전과 답안을 평가 함수가 받는 모양으로 */
    sessionAttempts(sessionId) {
      const attempts = q.attemptsOfSession.all(sessionId).map(a => ({ ...a, answers: [] }));
      const byId = new Map(attempts.map(a => [a.id, a]));
      for (const ans of q.answersOfSession.all(sessionId)) byId.get(ans.attempt_id).answers.push(ans);
      return attempts;
    }
  };
}

module.exports = { createStore };
