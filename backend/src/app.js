const fs = require('fs');
const path = require('path');
const express = require('express');
const { initSchema } = require('./db');
const { seedIfChanged } = require('./seed');
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

/**
 * DB 준비(스키마 → 콘텐츠가 바뀌었으면 시드 → 메모리 로드) 후 Express 앱을 만든다.
 * 로컬 서버(server.js)와 Vercel 함수(api/index.js)가 같은 함수를 쓴다.
 * @returns {Promise<{ app: import('express').Express, seeded: object|null }>}
 */
async function buildApp({ db, corsOrigins = [], serveFrontend = true } = {}) {
  await initSchema(db);
  const seeded = await seedIfChanged(db);
  const content = await loadContent(db);
  if (!content.scenarios.length) throw new Error('콘텐츠가 비어 있습니다. content/*.json 을 확인하세요.');

  const app = express();
  app.disable('x-powered-by');
  app.use('/api', cors(corsOrigins), createApiRouter({ store: createStore(db), content }));

  // 로컬에서는 같은 주소로 프론트도 서빙한다 (Vercel에서는 frontend/를 Vercel이 직접 서빙)
  if (serveFrontend && fs.existsSync(FRONTEND_DIR)) app.use(express.static(FRONTEND_DIR));

  return { app, seeded };
}

module.exports = { buildApp };
