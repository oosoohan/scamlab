const fs = require('fs');
const path = require('path');

const RULES_DIR = path.resolve(__dirname, '../../rules');
const CURRENT_VERSION = process.env.SCORING_VERSION || 'v2';
const cache = new Map();

/** rules/<version>.json 을 읽는다. 세션마다 저장된 버전으로 채점하므로 규칙을 바꿔도 예전 기록은 그대로다. */
function loadRules(version = CURRENT_VERSION) {
  if (!/^[\w.-]+$/.test(version)) throw new Error(`잘못된 규칙 버전: ${version}`);
  if (!cache.has(version)) {
    cache.set(version, JSON.parse(fs.readFileSync(path.join(RULES_DIR, `${version}.json`), 'utf8')));
  }
  return cache.get(version);
}

module.exports = { loadRules, CURRENT_VERSION };
