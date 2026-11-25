// 로컬 개발 서버:  npm start  →  http://localhost:3000
const { openDb } = require('./db');
const { buildApp } = require('./app');

try { process.loadEnvFile?.(); } catch { /* .env 없으면 기본값 */ }

const PORT = Number(process.env.PORT) || 3000;
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500')
  .split(',').map(s => s.trim()).filter(Boolean);

(async () => {
  const db = openDb();
  const { app, seeded } = await buildApp({ db, corsOrigins });
  if (seeded) console.log(`콘텐츠 시드: 사건 ${seeded.scenarios}개, 위험 신호 ${seeded.flags}개`);
  app.listen(PORT, () => {
    console.log(`ScamLab: http://localhost:${PORT}  (API: /api, DB: ${process.env.TURSO_DATABASE_URL ? 'Turso' : '로컬 파일'})`);
  });
})().catch(err => {
  console.error('서버를 시작하지 못했습니다:', err.message);
  process.exit(1);
});
