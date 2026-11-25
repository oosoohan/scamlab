const fs = require('fs');
const path = require('path');
// Node 내장 SQLite (Node 22.13+). 따로 설치하거나 C++ 빌드할 필요가 없다.
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PATH = path.resolve(__dirname, '../data/scamlab.db');

/** DB를 열고 스키마를 적용한다. ':memory:' 를 넘기면 테스트용 메모리 DB. */
function openDb(dbPath = process.env.DB_PATH || DEFAULT_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  /** fn을 하나의 트랜잭션으로 감싼 함수를 돌려준다. 중간에 오류가 나면 전부 되돌린다. */
  db.transaction = fn => (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  return db;
}

module.exports = { openDb, DEFAULT_PATH };
