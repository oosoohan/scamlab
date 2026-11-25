# 사기 생존기 (ScamLab)

채팅으로 배우는 금융사기 방어 훈련 게임. 사기 메시지 9건에 답하며 위험 신호 30가지를 익힌다.

## 구조

```
scamlab/
├── frontend/              ← 화면 (HTML/CSS/JS) — 프론트 담당
│   ├── index.html
│   └── js/api.js          ← 백엔드 호출 모음 (ScamApi)
├── backend/               ← Node + SQLite — 백엔드 담당
│   ├── src/
│   │   ├── server.js      실행 진입점
│   │   ├── app.js         Express 앱 (API + 프론트 정적 서빙)
│   │   ├── routes/api.js  API 엔드포인트
│   │   ├── game/
│   │   │   ├── attempt.js   한 사건 도전 판정 (순수 함수)
│   │   │   ├── evaluate.js  세션 평가·점수·등급 (순수 함수)
│   │   │   └── rules.js     채점 규칙 로더
│   │   ├── content.js     문제 콘텐츠 메모리 로드, 공개용(정답 제거) 변환
│   │   ├── store.js       플레이 기록 SQL
│   │   ├── seed.js        content/*.json → DB
│   │   ├── db.js
│   │   └── schema.sql
│   ├── rules/v1.json      채점 규칙 (신뢰도 감점, 등급 기준 등)
│   ├── scripts/           extract-content.js, seed.js
│   └── test/              node:test 단위·통합 테스트
├── content/               ← 문제 원본 (시나리오·위험 신호·교훈 JSON)
└── docs/
    ├── api.md                   API 명세 ← 프론트·백엔드 합의 문서
    └── frontend-integration.md  index.html에서 고칠 6곳
```

## 실행

**Node 22.13 이상**이 필요하다 (`node -v`로 확인). DB는 Node에 내장된 `node:sqlite`를 쓰므로 따로 설치하거나 빌드할 것이 없다.

```bash
cd backend
npm install
npm run seed      # content/*.json → backend/data/scamlab.db (처음 한 번, 콘텐츠를 고친 뒤에도)
npm start         # http://localhost:3000  (프론트 + /api)
npm run dev       # 파일 저장하면 자동 재시작
npm test          # 채점·API 테스트
```

설정은 `backend/.env.example`을 `backend/.env`로 복사해서 바꾼다.

## 문제(콘텐츠) 고치기

문제의 원본은 `content/*.json`이다. 고친 뒤 `npm run seed`를 다시 실행하면 DB에 반영된다.
여러 번 실행해도 안전하다. 턴·선택지 id가 고정이라 기존 플레이 기록이 깨지지 않는다.

- 선택지 `id`는 무작위 값(`o_xxxxxxxx`)이다. 새 선택지를 손으로 추가할 때는 겹치지 않는 값을 넣는다.
- 위험 신호는 `flags.json`의 `pattern`(정규식)으로 메시지에서 자동으로 찾는다. 시드할 때 어떤 메시지에도 걸리지 않는 신호가 있으면 경고가 뜬다.
- HTML에서 다시 뽑아야 할 때: `npm run extract -- ../frontend/index.html` (같은 문장의 선택지는 예전 id를 유지한다)

## 작업 방식

- `main`에 직접 push하지 않고, `feat/…` 브랜치 → PR → 리뷰 → merge
- API를 바꿀 때는 `docs/api.md`를 같은 PR에서 고친다
- `.env`, `backend/data/`(DB 파일)는 커밋하지 않는다
