// Vercel 함수 진입점. /api/* 요청이 모두 여기로 온다 (vercel.json의 rewrites).
// 실제 코드는 backend/src/vercel.js 에 있다.
module.exports = require('../backend/src/vercel');
