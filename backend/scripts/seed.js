#!/usr/bin/env node
// content/*.json 을 DB에 넣는다.   npm run seed
// TURSO_DATABASE_URL·TURSO_AUTH_TOKEN 이 설정돼 있으면 Turso에, 없으면 로컬 파일 DB에 넣는다.
// (서버도 켜질 때 콘텐츠가 바뀌었으면 자동으로 시드하므로, 보통은 직접 실행할 필요가 없다)
const { openDb, initSchema } = require('../src/db');
const { seedContent } = require('../src/seed');

try { process.loadEnvFile?.(); } catch { /* .env 없으면 기본값 */ }

(async () => {
  const db = openDb();
  await initSchema(db);
  const s = await seedContent(db);
  console.log(`✓ 시드 완료 (${process.env.TURSO_DATABASE_URL ? 'Turso' : '로컬 파일'}) — 사건 ${s.scenarios} · 턴 ${s.turns} · 선택지 ${s.options} · 위험 신호 ${s.flags} · 턴-신호 연결 ${s.turnFlags} · 교훈 ${s.lessons}`);

  // 패턴에 한 번도 걸리지 않은 위험 신호가 있으면 알려 준다 (도감을 다 채울 수 없게 됨)
  const unused = (await db.execute('SELECT id, label FROM flags WHERE id NOT IN (SELECT DISTINCT flag_id FROM turn_flags)')).rows;
  if (unused.length) console.warn('⚠ 어떤 메시지에도 나오지 않는 위험 신호:', unused.map(f => `${f.id}(${f.label})`).join(', '));
  db.close();
})().catch(err => { console.error('시드 실패:', err.message); process.exit(1); });
