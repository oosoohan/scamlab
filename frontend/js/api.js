/**
 * ScamLab API 클라이언트 — index.html 에서 <script src="js/api.js"></script> 로 불러 쓴다.
 * 백엔드가 같은 주소에서 프론트를 서빙하면 API_BASE는 '/api' 그대로 두면 된다.
 * Live Server(:5500)로 따로 띄울 때는 index.html 에서 이 파일보다 먼저
 *   <script>window.SCAMLAB_API_BASE = 'http://localhost:3000/api'</script>
 * 를 넣는다.
 */
(function () {
  const API_BASE = window.SCAMLAB_API_BASE || '/api';

  // 로그인 없이 쓰는 익명 플레이어 id. 같은 브라우저면 계속 같은 값.
  function playerToken() {
    let t = null;
    try { t = localStorage.getItem('scamlab_player'); } catch (e) {}
    if (!t) {
      t = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^\w-]/g, '');
      try { localStorage.setItem('scamlab_player', t); } catch (e) {}
    }
    return t;
  }

  class ApiError extends Error {
    constructor(status, error) { super(error?.message || `HTTP ${status}`); this.status = status; this.code = error?.code; this.detail = error; }
  }

  async function request(method, path, body) {
    const res = await fetch(API_BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Player-Token': playerToken() },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.error);
    return data;
  }

  // 새로고침해도 이어 하도록 세션 id를 기억해 둔다
  const SESSION_KEY = 'scamlab_session';
  const saveSession = id => { try { id ? localStorage.setItem(SESSION_KEY, id) : localStorage.removeItem(SESSION_KEY); } catch (e) {} };
  const savedSession = () => { try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; } };

  window.ScamApi = {
    ApiError,
    /** 시나리오·턴·선택지(정답 없음)·위험 신호·교훈 */
    content: () => request('GET', '/content'),

    /** 사전 자가진단(1~5)을 고른 순간 호출 */
    async startSession(preConfidence) {
      const r = await request('POST', '/sessions', { player_token: playerToken(), pre_confidence: preConfidence });
      saveSession(r.session_id);
      return r;
    },
    /** 저장된 세션 이어 하기. 없거나 만료면 null */
    async resumeSession() {
      const id = savedSession();
      if (!id) return null;
      try { return await request('GET', `/sessions/${id}`); }
      catch (e) { if (e.status === 404) saveSession(null); return null; }
    },
    getSession: id => request('GET', `/sessions/${id}`),
    forgetSession: () => saveSession(null),

    /** 사건 시작 (이미 막은 사건이면 서버가 자동으로 다시 해 보기로 만든다) */
    startAttempt: (sessionId, scenarioId) => request('POST', `/sessions/${sessionId}/attempts`, { scenario_id: scenarioId }),

    /** 선택지 제출 → { type, feedback, trust, trust_delta, revealed_flags, status, next_turn_id, game_over_reason, stage_result, summary } */
    answer: (attemptId, turnId, optionId, hintUsed) =>
      request('POST', `/attempts/${attemptId}/answers`, { turn_id: turnId, option_id: optionId, hint_used: !!hintUsed }),

    /** 직접 답장 → answer 와 같은 응답 + { reply(사기꾼 한마디), model_answer(정답 예시, 맞혔으면 null) }.
     *  AI가 꺼져 있거나 실패하면 503(AI_DISABLED / AI_FAILED), 개인정보로 보이면 400(PERSONAL_INFO) */
    freeAnswer: (attemptId, turnId, text, hintUsed) =>
      request('POST', `/attempts/${attemptId}/free-answers`, { turn_id: turnId, text, hint_used: !!hintUsed }),

    /** 사후 자가진단 → 최종 리포트 */
    finish: (sessionId, postConfidence) => request('POST', `/sessions/${sessionId}/finish`, { post_confidence: postConfidence }),
    report: sessionId => request('GET', `/sessions/${sessionId}/report`)
  };
})();
