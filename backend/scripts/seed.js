#!/usr/bin/env node
// content/*.json 을 DB에 넣는다.   npm run seed
const { openDb } = require('../src/db');
const { seedContent } = require('../src/seed');

const db = openDb();
const s = seedContent(db);
console.log(`✓ 시드 완료 — 사건 ${s.scenarios} · 턴 ${s.turns} · 선택지 ${s.options} · 위험 신호 ${s.flags} · 턴-신호 연결 ${s.turnFlags} · 교훈 ${s.lessons}`);

// 패턴에 한 번도 걸리지 않은 위험 신호가 있으면 알려 준다 (도감을 다 채울 수 없게 됨)
const unused = db.prepare('SELECT id, label FROM flags WHERE id NOT IN (SELECT DISTINCT flag_id FROM turn_flags)').all();
if (unused.length) console.warn('⚠ 어떤 메시지에도 나오지 않는 위험 신호:', unused.map(f => `${f.id}(${f.label})`).join(', '));
db.close();
