# 배포 안내 — Vercel + Turso

화면(`frontend/`)과 API(`/api`, Express)는 **Vercel**에, 플레이 기록 DB는 **Turso**(SQLite 호환 클라우드 DB)에 둔다. 둘 다 무료 플랜으로 충분하다.

```
브라우저 ──▶ Vercel ─┬─ frontend/  (화면·이미지·영상, Vercel CDN)
                    └─ /api/*  ──▶ Express 함수 (서울 icn1) ──▶ Turso DB
```

할 일은 네 단계다. 1~3은 처음 한 번만 하면 되고, 이후에는 `main`에 merge할 때마다 자동으로 배포된다.

---

## 1. 저장소를 공개로 바꾸기 (조직 관리자)

Vercel 무료(Hobby) 플랜은 GitHub **조직의 비공개 저장소**를 배포하지 못한다. 공개 저장소는 무료로 팀 협업까지 된다.

1. GitHub `oosoohan/scamlab` → **Settings** → 맨 아래 **Danger Zone** → **Change visibility** → **Make public**
2. 공개 전 확인: 저장소에 비밀번호·토큰·`.env` 파일이 없는지 (2026-11-25 검사 결과 없음). 앞으로도 `.env`는 커밋하지 않는다.

> 공개되면 `content/scenarios.json`의 정답도 GitHub에서 보인다. 게임 화면(브라우저)에는 여전히 정답이 내려가지 않는다.

## 2. Turso에서 DB 만들기

1. [turso.tech](https://turso.tech) → GitHub 계정으로 가입
2. 데이터베이스 생성
   - 이름: `scamlab`
   - 위치(region): 한국에서 가까운 곳 (예: 도쿄)
   - 종류를 묻는다면 **libSQL**을 고른다 (새 "Turso" 엔진은 아직 미리보기)
3. 두 값을 복사해 둔다
   - **Database URL**: `libsql://scamlab-<계정이름>.turso.io` 모양
   - **Auth Token**: DB 화면에서 토큰 생성 (읽기·쓰기 권한)

CLI를 쓴다면:

```bash
turso db create scamlab
turso db show scamlab --url        # Database URL
turso db tokens create scamlab     # Auth Token
```

테이블과 문제 데이터는 서버가 처음 켜질 때 **자동으로** 만들어진다. 따로 할 일 없음.

## 3. Vercel에 프로젝트 연결

1. [vercel.com](https://vercel.com) → GitHub 계정으로 가입 (Hobby)
2. **Add New… → Project** → GitHub 저장소 목록에서 `oosoohan/scamlab` **Import**
   - 목록에 조직 저장소가 안 보이면, 안내에 따라 Vercel GitHub 앱을 `oosoohan` 조직에 설치한다 (조직 관리자 승인 필요할 수 있음)
3. 설정 화면
   - Framework Preset: **Other** (나머지는 저장소의 `vercel.json`이 정한다 — 건드리지 않아도 됨)
   - **Environment Variables**에 두 개 추가 (Production·Preview 모두 체크)

     | Name | Value |
     |---|---|
     | `TURSO_DATABASE_URL` | 2단계의 Database URL |
     | `TURSO_AUTH_TOKEN` | 2단계의 Auth Token |
     | `ANTHROPIC_API_KEY` | (선택) 직접 답장 AI 채점용. 없으면 선택지로만 진행 |
4. **Deploy**

> Vercel은 `main` 브랜치를 실서비스(Production)로, 다른 브랜치·PR은 미리보기(Preview) 주소로 배포한다.
> PR #1 → #2 → #3 을 merge하기 전이라면 `main`에는 아직 코드가 없으니, PR #3 브랜치(`feat/deploy-vercel`)의 **Preview 주소**로 먼저 확인하면 된다.

## 4. 확인

배포 주소(예: `https://scamlab.vercel.app`) 뒤에 `/api/health`를 붙여 연다.

```json
{ "ok": true, "db": "turso", "scenarios": 9, "flags": 30 }
```

- `"db": "turso"`가 보이면 연결 성공 → 주소 루트(`/`)에서 게임을 해 본다
- `NOT_READY` 오류가 나오면 → Vercel 프로젝트 **Settings → Environment Variables** 두 값을 확인하고 **Redeploy**
- 그 밖의 오류 → Vercel 프로젝트 **Logs**에서 `/api` 요청의 오류 메시지 확인

---

## 운영 메모

- **문제 수정**: `content/*.json` 고치고 PR → merge. 배포 후 서버가 켜질 때 자동으로 DB에 반영된다.
- **채점 규칙**: 기본은 `backend/rules/v2.json`(목숨 3개, 치명타·링크마다 돈이 조금씩 빠짐). Vercel 환경변수에 `SCORING_VERSION=v1`이 남아 있으면 예전 규칙(치명타 즉시 실패)이 되니 지우거나 `v2`로 바꾼다. 세션마다 버전이 저장되므로 예전 기록은 예전 규칙으로 채점된다.
- **문항 통계**: Vercel 환경변수에 `ADMIN_TOKEN`을 정하면 `GET /api/stats/items` (헤더 `X-Admin-Token`)이 열린다.
- **로컬에서 Turso에 붙여 보기**: `backend/.env`에 두 값을 넣고 `npm start`.
- **무료 한도(2026-11 기준)**: Turso 무료 — 저장 5GB, 월 쓰기 1천만 행. 이 게임은 답 하나에 한 행이라 학교 프로젝트 규모로 충분하다.
