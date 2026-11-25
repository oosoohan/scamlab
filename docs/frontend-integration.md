# 프론트(index.html) ↔ 백엔드 연결 가이드

> **적용 완료:** `frontend/index.html`에는 아래 내용이 이미 들어가 있다 (+ 새로고침 이어 하기, 오류 처리).
> 이 문서는 무엇을 왜 바꿨는지 기록하고, 앞으로 프론트를 고칠 때 지킬 규칙을 정리한 것이다.
>
> **프론트를 고칠 때 규칙**
> - 문제 문장·선택지·위험 신호는 `index.html`이 아니라 `content/*.json`에서 고친다 → `npm run seed`
> - 선택지의 정답 여부는 브라우저에 없다. 판정은 `ScamApi.answer()` 응답(`type`, `trust`, `status`)으로 분기한다
> - 점수·등급·오답 노트는 서버 리포트(`ScamApi.report()`) 값을 그린다. 화면에서 따로 계산하지 않는다
> - 이미지·영상은 `frontend/assets/`에 파일로 두고 경로로 쓴다 (base64로 넣지 않는다)
> - **화면 파일은 `frontend/index.html` 하나다.** 저장소 맨 위에 `index.html`을 따로 만들지 않는다 (배포에 쓰이지 않음)
> - 신뢰도를 바꾸는 새 기능(예: 가짜 링크 낚임)은 화면에서 직접 깎지 말고 서버 API로 기록한다 → `ScamApi.bait()`
> - 서버 준비가 필요한 기능은 `FEATURES`(서버 `/api/content`의 `features`)로 켜고 끈다 — 직접 답장은 `FEATURES.ai_chat`

원래 `index_v2.html`은 문제 데이터와 채점을 모두 브라우저 안에서 처리했다. 아래 6곳을 고쳐 서버와 연결했다.
말풍선·흔들림·사이렌 같은 연출 코드는 손대지 않았다.

> 줄 번호는 `index_v2.html` 기준이다. 파일이 바뀌면 함수 이름으로 찾는다.

## 0. 준비

```html
<!-- 메인 <script> 보다 앞에 -->
<script src="js/api.js"></script>
```

프론트를 Live Server(:5500)로 따로 띄울 때만 그 앞에 한 줄을 더 넣는다.

```html
<script>window.SCAMLAB_API_BASE = 'http://localhost:3000/api';</script>
```

백엔드가 프론트를 같이 서빙하면(`npm start` 후 `http://localhost:3000`) 이 줄은 필요 없다.

## 1. 데이터 상수 → 서버에서 받기  (`const SCENARIOS = …` ~ `Object.assign(LESSONS, …)`)

긴 데이터 줄(SCENARIOS, FLAGS, LESSONS)을 지우고 아래로 바꾼다. 나머지 코드가 쓰는 모양(`FLAGS[i].re`, `LESSONS[id]`, `stage().turns[i].options`)은 그대로 유지된다.

```js
let SCENARIOS = [], FLAGS = [], LESSONS = {};
let RULES = { start_balance: 3200000, trap_penalty: 25 };

async function loadContent() {
  const c = await ScamApi.content();
  SCENARIOS = c.scenarios;
  FLAGS = c.flags.map(f => ({ ...f, re: new RegExp(f.pattern, f.pattern_flags) }));
  LESSONS = Object.fromEntries(c.scenarios.map(s => [s.stage_id, s.lessons]));
}
```

`START_BALANCE`, `TRAP_PENALTY` 상수는 남겨 둬도 되고, 세션을 만든 뒤 `RULES`로 바꿔도 된다.

## 2. 시작 순서  (파일 맨 끝 `resetGame(); Intro.boot({...})`)

`freshState()`가 `SCENARIOS`를 쓰므로 콘텐츠를 먼저 받아야 한다.

```js
loadContent().then(() => {
  resetGame();
  Intro.boot({ /* 기존 그대로 */ });
}).catch(() => {
  document.body.insertAdjacentHTML('beforeend',
    '<p style="position:fixed;inset:auto 0 20px;text-align:center;color:#fff">서버에 연결하지 못했습니다. 잠시 후 새로고침해 주세요.</p>');
});
```

## 3. 사전 자가진단 → 세션 생성  (`renderTitle()` 안 `bindScale(v => { S.pre = v; … })`)

```js
bindScale(async v => {
  S.pre = v;
  const ses = await ScamApi.startSession(v);
  S.sessionId = ses.session_id;
  RULES = ses.rules;
  setTimeout(() => Intro.enter(), 180);
});
```

## 4. 사건 시작 → 도전 생성  (`startStage(idx, replay)`)

함수를 `async`로 바꾸고 `playTurn()` 직전에 넣는다.

```js
async function startStage(idx, replay = false) {
  // … 기존 코드 그대로 (beginReplay, closeOverlay, Object.assign, 테마, 헤더) …
  const a = await ScamApi.startAttempt(S.sessionId, s.stage_id);
  S.attemptId = a.attempt_id;
  playTurn();
}
```

## 5. 답 고르기 → 서버 판정  (`choose(opt, turn)`)  ★ 가장 큰 변경

선택지에 더 이상 `type`/`feedback`이 없으므로, 서버 응답 `r`로 분기한다.

```js
async function choose(opt, turn) {
  if (S.busy) return;
  S.busy = true;
  clearOptions('');
  if (/^\(.*\)$/.test(opt.text.trim())) addSys('info', '', '🎬 ' + esc(opt.text.replace(/^\(|\)$/g, '')));
  else addBubble('out', esc(opt.text));

  let r;
  try {
    [r] = await Promise.all([ScamApi.answer(S.attemptId, turn.turn_id, opt.option_id, S.hintUsed), sleep(550)]);
  } catch (e) {
    addSys('info', '', '서버에 연결하지 못했습니다. 다시 골라 주세요.');
    S.busy = false; showOptions(turn); return;
  }

  S.stats[r.type]++;
  S.trust = r.trust;
  if (r.type === 'correct') {
    addSys('correct', '✅ 방어 성공', esc(r.feedback));
    await sleep(450); revealFlags(S.hintUsed);
    await sleep(900);
  } else if (r.type === 'trap') {
    S.stageMiss[stage().stage_id]++;
    updateHud(); shakePhone(false); flashSiren();
    addSys('trap', `⚠️ 빈틈 노출 (신뢰도 ${r.trust_delta})`, esc(r.feedback));
    await sleep(450); revealFlags(S.hintUsed);
    await sleep(1200);
  } else {
    S.stageMiss[stage().stage_id]++;
    shakePhone(true); flashSiren();
    addSys('wrong', '❌ 치명적 실수', esc(r.feedback));
    await sleep(450); revealFlags(S.hintUsed);
    await sleep(1500);
  }

  if (r.status === 'failed') return gameOver(r.game_over_reason);
  if (r.status === 'cleared') { S.lastStageResult = r.stage_result; return stageClear(); }
  nextTurn();
}
```

- `logMistake()` 호출은 지운다. 오답 노트는 서버 리포트(`mistakes`)로 받는다.
  → 그래서 5번만 고치고 6번을 안 고치면 리포트의 **오답 노트가 비어 보인다.** 5·6번은 같이 고친다.
- `stageClear()`의 다시 해 보기 비교(`best`, `better`)는 `S.lastStageResult.previous_best`, `.improved`로 바꿔도 되고, 지금처럼 로컬 값으로 둬도 결과는 같다.

## 6. 리포트 → 서버 계산 결과 그리기  (`showPostCheck()`, `showReport()`)

```js
// showPostCheck() 의 리포트 버튼
$('toReport').onclick = async () => { S.report = await ScamApi.finish(S.sessionId, S.post); showReport(); };

// showReport() 맨 앞에서 로컬 계산을 서버 값으로 바꾼다
async function showReport() {
  const R = S.report || (S.report = await ScamApi.report(S.sessionId));
  const score = R.score;
  const grade = [R.grade.grade, R.grade.title, R.grade.message];
  const weak = R.weak_scenarios.map(id => themeOf(SCENARIOS.find(s => s.stage_id === id)).title);
  const trustOf = id => R.stages.find(s => s.scenario_id === id).best_trust;   // 막대그래프용
  const delta = R.confidence.delta;
  // 오답 노트: S.mistakes 대신 R.mistakes (m.stage → m.scenario_id)
  // 통계 줄: S.stats 대신 R.stats, 찾은 위험 신호: R.found_flags.length / R.flag_total
  // … 이하 HTML 그리는 코드는 그대로 …
}
```

다시 해 보기 뒤에 리포트를 다시 열 때는 `S.report = null`로 비우고 `ScamApi.report()`로 새로 받는다 (최고 기록이 바뀌면 점수도 바뀜).

## 선택: 새로고침해도 이어 하기

```js
const saved = await ScamApi.resumeSession();
if (saved && !saved.finished) {
  S.sessionId = saved.session_id;
  S.pre = saved.pre_confidence;
  saved.summary.stages.filter(s => s.cleared).forEach(s => { S.cleared[s.scenario_id] = { trust: s.best_trust }; });
  saved.summary.found_flags.forEach(id => S.found.add(id));
}
```

## 연결 확인 체크리스트

- [ ] 개발자도구 Network 탭에서 `/api/content` 응답에 `type`이 없다
- [ ] 1단계에서 빈틈을 고르면 신뢰도가 75가 되고 `/answers` 응답 `trust`도 75다
- [ ] 치명적 실수 → 게임오버 화면의 사유가 응답 `game_over_reason`과 같다
- [ ] 대화 중 다른 사건을 눌러도 에러 없이 새 사건이 시작된다
- [ ] 9개를 모두 막은 뒤 리포트 점수가 `/finish` 응답 `score`와 같다
