const { openDb } = require('../src/db');
const { buildApp } = require('../src/app');
const { loadContent } = require('../src/content');

/** 실제 content/*.json 을 넣은 메모리 DB와 앱 */
async function seededApp() {
  const db = openDb(':memory:');
  const { app } = await buildApp({ db, serveFrontend: false });
  const content = await loadContent(db);
  return { db, app, content };
}

/** 서버 쪽 정답 키로 원하는 종류의 선택지 id 찾기 (테스트 전용) */
function picker(content) {
  return (turnId, type) => content.turnById.get(turnId).options.find(o => o.type === type).id;
}

async function startServer() {
  const { db, app, content } = await seededApp();
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Player-Token': token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  return { db, content, base, pick: picker(content), call, close: () => new Promise(r => server.close(r)) };
}

module.exports = { seededApp, picker, startServer };
