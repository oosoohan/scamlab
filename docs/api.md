# ScamLab API 명세 (v1)

- 기본 주소: 백엔드가 프론트를 같이 서빙하면 `/api`, 따로 띄우면 `http://localhost:3000/api`
- 요청·응답 본문은 JSON, 필드 이름은 `snake_case`
- 플레이어 식별: 로그인 없음. 브라우저가 만든 익명 UUID를 `X-Player-Token` 헤더로 보낸다 (`/content`, `/sessions` 생성 제외 모든 세션·도전 요청에 필요)
- 오류 형식은 하나로 통일:

```json
{ "error": { "code": "WRONG_TURN", "message": "지금 답할 차례의 턴이 아닙니다.", "expected_turn_id": 101 } }
```

| HTTP | code | 언제 |
|---|---|---|
| 400 | `INVALID_TOKEN` `INVALID_CONFIDENCE` `INVALID_SCENARIO` `INVALID_OPTION` `INVALID_JSON` | 입력값이 잘못됨 |
| 401 | `NO_TOKEN` | `X-Player-Token` 헤더가 없음 |
| 404 | `SESSION_NOT_FOUND` `ATTEMPT_NOT_FOUND` | 없거나 다른 플레이어의 것 |
| 409 | `WRONG_TURN` | 답할 차례가 아닌 턴 (`expected_turn_id` 포함) |
| 409 | `ATTEMPT_ENDED` | 이미 끝났거나 다른 사건으로 넘어가 버려진 도전 (`status` 포함) |
| 409 | `NOT_READY` | 모든 사건을 막기 전에 리포트 요청 (`progress` 포함) |

---

## 1. 콘텐츠

### `GET /content`
시나리오·턴·선택지·위험 신호·교훈. **선택지의 정답 여부(`type`)와 피드백, 게임오버 사유는 들어 있지 않다** — 답을 제출해야 서버가 알려 준다. `ETag`를 지원하므로 브라우저 캐시가 그대로 쓰인다.

```json
{
  "scenarios": [{
    "stage_id": 1,
    "scam_type": "중고거래 3자 사기 및 가짜 안전결제 URL",
    "platform": "Karrot",
    "title": null, "icon": null,
    "scammer_profile": { "name": "미니멀라이프", "status_message": "매너거래 원해요" },
    "turns": [{
      "turn_id": 101, "turn": 1,
      "scammer_msg": "안녕하세요~ 맥북 프로 올리신거 ...",
      "options": [{ "option_id": "o_9fa8747c", "text": "네~ 2만원 빼드릴게요 ..." }, "..."]
    }],
    "lessons": ["거래 대화와 결제는 처음부터 끝까지 앱 안에서만 합니다.", "..."]
  }],
  "flags": [{ "id": "link", "label": "출처 불명 링크", "pattern": "(https?:\\/\\/...)", "pattern_flags": "g", "why": "..." }]
}
```

- `turn_id` = `단계 × 100 + 턴번호` (3단계 2번 턴 → `302`)
- `title`, `icon`이 `null`이면 프론트 `THEMES[platform]` 값을 쓴다 (지금 `themeOf()`와 같음)
- 메시지 속 위험 신호 하이라이트는 지금처럼 프론트가 `new RegExp(pattern, pattern_flags)`로 처리한다

---

## 2. 세션 (한 번의 훈련 = 사전 자가진단 ~ 리포트)

### `POST /sessions`
요청 `{ "player_token": "<uuid>", "pre_confidence": 1~5 }` → `201`

```json
{ "session_id": "2170464f-...", "scoring_version": "v1",
  "rules": { "start_trust": 100, "start_balance": 3200000, "trap_penalty": 25 } }
```

### `GET /sessions/:id`
새로고침 후 이어 하기, 오른쪽 메뉴(진행 상황·도감 수) 갱신용.

```json
{
  "session_id": "...", "pre_confidence": 2, "post_confidence": null, "finished": false,
  "summary": { "...": "아래 summary 형식" },
  "playing_attempt": { "attempt_id": 7, "scenario_id": 2, "trust": 75, "next_turn_id": 203, "...": "" }
}
```

`summary` 형식 (답안 제출 응답에도 같이 온다):

```json
{
  "balance": 3200000,
  "progress": { "cleared": 3, "total": 9 },
  "found_flags": ["offapp", "safepay", "avoid"],
  "flag_total": 30,
  "report_ready": false,
  "stages": [{ "scenario_id": 1, "cleared": true, "best_trust": 75 }, "..."],
  "avg_trust": null
}
```

---

## 3. 사건 도전

### `POST /sessions/:id/attempts`
요청 `{ "scenario_id": 1 }` → `201`

- 진행 중이던 다른 도전은 자동으로 `abandoned`가 된다 (지금 프론트처럼 대화 중에 다른 사건을 눌러도 됨)
- 이미 막아 낸 사건이면 서버가 알아서 **다시 해 보기**(`is_replay: true`)로 만든다

```json
{ "attempt_id": 1, "scenario_id": 1, "attempt_no": 1, "is_replay": false,
  "status": "playing", "trust": 100, "next_turn_id": 101 }
```

### `POST /attempts/:id/answers`  ← 게임의 중심
요청 `{ "turn_id": 102, "option_id": "o_b4e5c40a", "hint_used": true }`

```json
{
  "type": "trap",
  "feedback": "'모른다'는 사실을 드러냈습니다 ...",
  "trust": 75,
  "trust_delta": -25,
  "revealed_flags": ["offapp", "safepay", "avoid"],
  "status": "continue",
  "next_turn_id": 103,
  "fail_cause": null,
  "game_over_reason": null,
  "stage_result": null,
  "summary": { "...": "" }
}
```

| `status` | 뜻 | 함께 오는 값 |
|---|---|---|
| `continue` | 다음 턴으로 | `next_turn_id` |
| `cleared` | 사건 방어 성공 | `stage_result: { trust, previous_best, improved }` |
| `failed` | 게임 오버 | `fail_cause`: `fatal`(치명적 실수) / `trust_depleted`(신뢰도 0), `game_over_reason` |

`revealed_flags`는 이 메시지에 들어 있는 위험 신호 id 목록이다 (서버가 시드할 때 미리 계산해 둔 값).

---

## 4. 마무리·리포트

### `POST /sessions/:id/finish`
요청 `{ "post_confidence": 1~5 }` → 리포트. 모든 사건을 막기 전이면 `409 NOT_READY`.

### `GET /sessions/:id/report`
리포트 다시 보기 (다시 해 보기로 최고 기록이 바뀌면 점수도 다시 계산된다).

```json
{
  "scoring_version": "v1",
  "report_ready": true,
  "progress": { "cleared": 9, "total": 9 },
  "balance": 3200000,
  "stages": [{ "scenario_id": 1, "cleared": true, "best_trust": 75, "misses": 2, "attempts": 3 }],
  "found_flags": ["link", "..."], "flag_total": 30,
  "stats": { "correct": 57, "trap": 1, "wrong": 1, "hints": 3, "retries": 1 },
  "weak_scenarios": [1],
  "mistakes": [{ "scenario_id": 1, "platform": "Karrot", "turn": 2, "type": "wrong",
                 "mine": "내가 고른 답", "right": "모범 답", "why": "모범 답 해설" }],
  "avg_trust": 97,
  "score": 89,
  "grade": { "grade": "A", "title": "철벽 방어자", "message": "빈틈이 조금 있었지만 끝까지 지켜냈습니다." },
  "confidence": { "pre": 2, "post": 4, "delta": 2 }
}
```

---

## 5. 운영자용

### `GET /stats/items`  (헤더 `X-Admin-Token`, 서버에 `ADMIN_TOKEN`을 설정했을 때만 열림)
턴별 응답 수·정답률·힌트 사용률·선택지별 선택 수 (다시 해 보기 제외). 너무 쉽거나 어려운 문항을 찾는 데 쓴다.

---

## 채점 규칙 (rules/v1.json)

| 항목 | 값 |
|---|---|
| 시작 신뢰도 | 100 |
| 빈틈(trap) | 신뢰도 −25, 0이 되면 실패 |
| 치명적 실수(wrong) | 즉시 실패 |
| 단계 신뢰도 | 그 사건을 막아 낸 도전 중 최고 기록 |
| 방어 점수 | `max(0, round(단계 신뢰도 평균) − 재도전×5 − 힌트×1)` |
| 등급 | 95 이상 S · 75 이상 A · 50 이상 B · 그 밖 C |
| 통계에서 빠지는 것 | 다시 해 보기의 빈틈·치명타·힌트 (최고 기록과 찾은 위험 신호에는 반영) |

규칙을 바꿀 때는 `rules/v2.json`을 새로 만들고 `SCORING_VERSION=v2`로 바꾼다. 세션마다 버전이 저장되어 있어서 예전 기록은 예전 규칙으로 채점된다.
