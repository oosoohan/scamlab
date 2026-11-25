const { openDb } = require('./db');
const { seedContent } = require('./seed');
const { createApp } = require('./app');

try { process.loadEnvFile?.(); } catch { /* .env 없으면 기본값 */ }

const PORT = Number(process.env.PORT) || 3000;
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500')
  .split(',').map(s => s.trim()).filter(Boolean);

const db = openDb();
// 처음 실행이라 콘텐츠가 비어 있으면 자동으로 시드
if (db.prepare('SELECT COUNT(*) AS n FROM scenarios').get().n === 0) {
  const s = seedContent(db);
  console.log(`콘텐츠 자동 시드: 사건 ${s.scenarios}개, 위험 신호 ${s.flags}개`);
}

createApp({ db, corsOrigins }).listen(PORT, () => {
  console.log(`ScamLab 백엔드: http://localhost:${PORT}  (API: /api)`);
});
