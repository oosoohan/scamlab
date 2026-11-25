// Vercel 함수 진입점. /api/* 요청이 모두 여기로 온다 (vercel.json의 rewrites).
// 실제 코드는 backend/src/vercel.js 에 있다.
// 코드를 불러오는 단계에서 실패해도 함수가 통째로 죽지 않고, 원인을 JSON으로 알려 준다.
let handler;
try {
  handler = require('../backend/src/vercel');
} catch (err) {
  console.error('백엔드 코드를 불러오지 못했습니다:', err);
  handler = (req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'BOOT_FAILED', message: '백엔드 코드를 불러오지 못했습니다.', detail: String(err && err.message).slice(0, 300) } }));
  };
}
module.exports = (req, res) => handler(req, res);
