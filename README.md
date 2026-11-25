# 사기 생존기 (ScamLab)

채팅으로 배우는 금융사기 방어 훈련 게임. 사기 메시지 9건에 답하며 위험 신호 30가지를 익힌다.

## 구조

```
scamlab/
├── frontend/              ← 화면 (HTML/CSS/JS) — 프론트 담당
│   ├── index.html
│   ├── assets/            ← 배경·인트로 영상·사건 그림
│   └── js/api.js          ← 백엔드 호출 모음 (ScamApi)
├── backend/               ← Node + SQLite — 백엔드 담당
│   ├── src/
│   │   ├── server.js      로컬 실행 진입점
│   │   ├── vercel.js      Vercel 함수 진입점 (api/index.js가 내보냄)
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
├── api/index.js           ← Vercel 함수 진입점
├── vercel.json            ← Vercel 설정 (화면=frontend/, /api=함수, 서울 리전)
├── content/               ← 문제 원본 (시나리오·위험 신호·교훈 JSON)
└── docs/
    ├── api.md                   API 명세 ← 프론트·백엔드 합의 문서
    ├── frontend-integration.md  프론트 연결 내용과 수정 규칙
    └── deploy.md                배포 안내 (Vercel + Turso)
```

## 실행

**Node 20.12 이상**이 필요하다 (`node -v`로 확인).

DB는 SQLite 호환 클라이언트(`@libsql/client`) 하나로 두 곳에 붙는다.
- 로컬: 설정이 없으면 `backend/data/scamlab.db` 파일
- 배포: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` 환경변수가 있으면 Turso 클라우드 DB

```bash
cd backend
npm install
npm start         # http://localhost:3000 을 브라우저로 열면 게임 (프론트 + /api 같은 주소)
npm run dev       # 파일 저장하면 자동 재시작
npm test          # 채점·API 테스트
```

설정은 `backend/.env.example`을 `backend/.env`로 복사해서 바꾼다.

## 문제(콘텐츠) 고치기

문제의 원본은 `content/*.json`이다. 고친 뒤 서버를 다시 켜면(배포라면 push하면) **자동으로 DB에 반영된다.**
서버가 켜질 때 JSON 내용이 DB와 다르면 다시 시드한다. 턴·선택지 id가 고정이라 기존 플레이 기록은 깨지지 않는다.
직접 넣고 싶으면 `npm run seed`.

- 선택지 `id`는 무작위 값(`o_xxxxxxxx`)이다. 새 선택지를 손으로 추가할 때는 겹치지 않는 값을 넣는다.
- 위험 신호는 `flags.json`의 `pattern`(정규식)으로 메시지에서 자동으로 찾는다. 시드할 때 어떤 메시지에도 걸리지 않는 신호가 있으면 경고가 뜬다.
- HTML에서 다시 뽑아야 할 때: `npm run extract -- ../frontend/index.html` (같은 문장의 선택지는 예전 id를 유지한다)

## 작업 방식

- `main`에 직접 push하지 않고, `feat/…` 브랜치 → PR → 리뷰 → merge
- API를 바꿀 때는 `docs/api.md`를 같은 PR에서 고친다
- `.env`, `backend/data/`(DB 파일)는 커밋하지 않는다
