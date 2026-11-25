const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  // 로컬 파일·메모리 DB만 네이티브 SQLite 모듈이 필요하다.
  // 원격(Turso)은 네이티브 모듈이 없는 웹 클라이언트(HTTP)를 써서 Vercel 같은 서버리스에서도 안전하게 뜬다.
  const isLocal = url === ':memory:' || url.startsWith('file:');
  const { createClient } = isLocal ? require('@libsql/client') : require('@libsql/client/web');
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

/** 테이블이 없으면 만든다 (여러 번 실행해도 안전) */
async function initSchema(db) {
  await db.executeMultiple(SCHEMA_SQL);
  // 예전 DB(Turso 포함)에 나중에 추가된 열을 붙인다. CREATE TABLE IF NOT EXISTS는 열을 추가하지 않기 때문
  const cols = (await db.execute('PRAGMA table_info(scenarios)')).rows.map(r => r.name);
  if (!cols.includes('is_scam')) await db.execute('ALTER TABLE scenarios ADD COLUMN is_scam INTEGER NOT NULL DEFAULT 1');
}

/** libsql Row → 평범한 객체 */
const plain = row => (row ? { ...row } : undefined);
const rows = rs => rs.rows.map(plain);

/** 같은 내용이면 같은 값 (콘텐츠가 바뀌었는지 알아볼 때 사용) */
const hashOf = data => crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex');

module.exports = { openDb, initSchema, plain, rows, hashOf, DEFAULT_PATH };
