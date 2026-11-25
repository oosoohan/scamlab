-- 사기 생존기 (ScamLab) SQLite 스키마 — 로컬 파일 DB와 Turso(libSQL)에서 똑같이 쓴다
-- 콘텐츠(문제) 테이블은 content/*.json 에서 시드로 채우고, 플레이 기록 테이블은 API가 채운다.
-- 참조 관계(REFERENCES)는 구조를 설명하는 용도이고, 값 검사는 API 코드가 한다.

-- 콘텐츠 버전 등 작은 설정값
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

/* ===================== 콘텐츠 ===================== */

CREATE TABLE IF NOT EXISTS scenarios (
  id               INTEGER PRIMARY KEY,          -- = stage_id
  sort_order       INTEGER NOT NULL,
  scam_type        TEXT    NOT NULL,
  platform         TEXT    NOT NULL,             -- Karrot | SMS | KakaoTalk | Instagram | Telegram
  title            TEXT,                         -- 없으면 프론트 THEMES[platform].title 사용
  icon             TEXT,
  scammer_name     TEXT    NOT NULL,
  scammer_status   TEXT    NOT NULL,
  game_over_reason TEXT    NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS turns (
  id           INTEGER PRIMARY KEY,              -- 고정 id = 단계*100 + 턴 (예: 3단계 2번 턴 → 302)
  scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  turn_no      INTEGER NOT NULL,                 -- 1부터
  scammer_msg  TEXT    NOT NULL,
  UNIQUE (scenario_id, turn_no)
);

CREATE TABLE IF NOT EXISTS options (
  id        TEXT    PRIMARY KEY,                 -- 무작위 고정 id (예: o_3f9a1c2b) — 정답 종류가 드러나지 않게
  turn_id   INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  text      TEXT    NOT NULL,
  type      TEXT    NOT NULL CHECK (type IN ('correct', 'trap', 'wrong')),
  feedback  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS flags (
  id             TEXT    PRIMARY KEY,            -- 예: link, rush
  sort_order     INTEGER NOT NULL,
  label          TEXT    NOT NULL,
  pattern        TEXT    NOT NULL,               -- JS 정규식 source
  pattern_flags  TEXT    NOT NULL DEFAULT 'g',
  why            TEXT    NOT NULL
);

-- 메시지에 들어 있는 위험 신호 (시드할 때 pattern으로 자동 계산)
CREATE TABLE IF NOT EXISTS turn_flags (
  turn_id  INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  flag_id  TEXT    NOT NULL REFERENCES flags(id) ON DELETE CASCADE,
  PRIMARY KEY (turn_id, flag_id)
);

CREATE TABLE IF NOT EXISTS lessons (
  scenario_id  INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  sort_order   INTEGER NOT NULL,
  text         TEXT    NOT NULL,
  PRIMARY KEY (scenario_id, sort_order)
);

/* ===================== 플레이 기록 ===================== */
-- 원칙: 사용자가 한 행동(어느 선택지를 골랐는지)만 원본으로 저장하고,
-- 신뢰도·점수·등급·찾은 신호는 모두 이 기록에서 계산한다.

CREATE TABLE IF NOT EXISTS play_sessions (
  id               TEXT    PRIMARY KEY,          -- UUID
  player_token     TEXT    NOT NULL,             -- 브라우저 localStorage에 둔 익명 UUID
  pre_confidence   INTEGER NOT NULL CHECK (pre_confidence BETWEEN 1 AND 5),
  post_confidence  INTEGER CHECK (post_confidence BETWEEN 1 AND 5),
  scoring_version  TEXT    NOT NULL,             -- rules/<version>.json
  started_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON play_sessions(player_token);

CREATE TABLE IF NOT EXISTS stage_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL REFERENCES play_sessions(id) ON DELETE CASCADE,
  scenario_id  INTEGER NOT NULL REFERENCES scenarios(id),
  attempt_no   INTEGER NOT NULL,                 -- 세션 안에서 이 사건을 몇 번째 하는지
  is_replay    INTEGER NOT NULL DEFAULT 0,       -- 이미 막아 낸 사건을 다시 하는 연습
  status       TEXT    NOT NULL DEFAULT 'playing'
               CHECK (status IN ('playing', 'cleared', 'failed', 'abandoned')),
  started_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_session ON stage_attempts(session_id);

CREATE TABLE IF NOT EXISTS answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id   INTEGER NOT NULL REFERENCES stage_attempts(id) ON DELETE CASCADE,
  turn_id      INTEGER NOT NULL REFERENCES turns(id),
  option_id    TEXT    NOT NULL REFERENCES options(id),
  hint_used    INTEGER NOT NULL DEFAULT 0,
  answered_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (attempt_id, turn_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_turn ON answers(turn_id);
