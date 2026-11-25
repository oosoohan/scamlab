/**
 * Vercel 함수 진입점 (저장소 루트의 api/index.js 가 이 파일을 내보낸다).
 * 함수 인스턴스가 처음 뜰 때 한 번만 DB 준비·콘텐츠 로드를 하고, 이후 요청은 같은 앱을 재사용한다.
 * 화면 파일(frontend/)은 Vercel이 직접 서빙하므로 여기서는 /api 만 처리한다.
 */
const { openDb } = require('./db');
const { buildApp } = require('./app');

let ready = null;
function getApp() {
  // Vercel은 파일 시스템이 읽기 전용이라 로컬 파일 DB를 쓸 수 없다 → Turso 설정이 꼭 필요
  if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) {
    throw new Error('Vercel 환경변수 TURSO_DATABASE_URL 이 설정되지 않았습니다.');
  }
  if (!ready) {
    ready = buildApp({ db: openDb(), serveFrontend: false })
      .then(r => r.app)
      .catch(err => { ready = null; throw err; });   // 실패하면 다음 요청에서 다시 시도
  }
  return ready;
}

module.exports = async (req, res) => {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (err) {
    console.error('초기화 실패:', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'NOT_READY', message: '서버를 준비하지 못했습니다. TURSO_DATABASE_URL / TURSO_AUTH_TOKEN 설정을 확인하세요.', detail: String(err.message).slice(0, 200) } }));
  }
};
