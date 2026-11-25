const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const DEFAULT_PATH = path.resolve(__dirname, '../data/scamlab.db');
const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

/**
 * DB 연결. 같은 코드로 두 곳에 붙는다.
 *  - 배포(Vercel): TURSO_DATABASE_URL + TURSO_AUTH_TOKEN → Turso 클라우드 DB
 *  - 로컬 개발   : 설정이 없으면 backend/data/scamlab.db 파일 (DB_PATH로 바꿀 수 있음)
 *  - 테스트      : ':memory:'
 */
function openDb(url) {
  if (!url) {
    if (process.env.TURSO_DATABASE_URL) url = process.env.TURSO_DATABASE_URL;
    else {
      const file = path.resolve(process.env.DB_PATH || DEFAULT_PATH);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      url = 'file:' + file;
    }
  }
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

/** 테이블이 없으면 만든다 (여러 번 실행해도 안전) */
async function initSchema(db) {
  await db.executeMultiple(SCHEMA_SQL);
}

/** libsql Row → 평범한 객체 */
const plain = row => (row ? { ...row } : undefined);
const rows = rs => rs.rows.map(plain);

/** 같은 내용이면 같은 값 (콘텐츠가 바뀌었는지 알아볼 때 사용) */
const hashOf = data => crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex');

module.exports = { openDb, initSchema, plain, rows, hashOf, DEFAULT_PATH };
