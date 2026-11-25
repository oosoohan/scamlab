const fs = require('fs');
const path = require('path');
const express = require('express');
const { loadContent } = require('./content');
const { createStore } = require('./store');
const { createApiRouter } = require('./routes/api');

const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

/** 개발 중 프론트를 따로 띄울 때(예: VS Code Live Server :5500)만 필요한 CORS 허용 */
function cors(origins) {
  return (req, res, next) => {
    const origin = req.get('Origin');
    if (origin && origins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type, X-Player-Token, X-Admin-Token');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

function createApp({ db, corsOrigins = [], serveFrontend = true } = {}) {
  const content = loadContent(db);
  if (!content.scenarios.length) {
    throw new Error('콘텐츠가 비어 있습니다. 먼저 `npm run seed` 를 실행하세요.');
  }
  const store = createStore(db);
  const app = express();
  app.disable('x-powered-by');

  app.use('/api', cors(corsOrigins), createApiRouter({ store, content }));

  // 같은 주소에서 프론트도 서빙한다 → CORS 설정 없이 바로 동작
  if (serveFrontend && fs.existsSync(FRONTEND_DIR)) app.use(express.static(FRONTEND_DIR));

  return app;
}

module.exports = { createApp };
