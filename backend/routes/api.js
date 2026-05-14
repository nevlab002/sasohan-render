// ── API 유틸 ──────────────────────────────
const API = {
  getToken: () => localStorage.getItem('ss_token'),
  getUser:  () => { try { return JSON.parse(localStorage.getItem('ss_user')); } catch { return null; } },
  setSession: (token, user) => {
    localStorage.setItem('ss_token', token);
    localStorage.setItem('ss_user', JSON.stringify(user));
  },
  clearSession: () => {
    localStorage.removeItem('ss_token');
    localStorage.removeItem('ss_user');
  },
  BASE: window.location.origin,
  headers: () => ({ Authorization: `Bearer ${localStorage.getItem('ss_token')}` }),
};

// ── GlobalWS: 전역 실시간 연결 ────────────
// 로그인된 모든 페이지에서 자동 실행
// 채팅 메시지, 알림, 캐미 초대 등 모든 실시간 이벤트 처리
const GlobalWS = (() => {
  let ws = null;
  let reconnectTimer = null;
  let isConnecting = false;
  const handlers = {};   // type → [callback, ...]

  // 이벤트 핸들러 등록
  function on(type, fn) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(fn);
  }

  // 이벤트 핸들러 해제
  function off(type, fn) {
    if (!handlers[type]) return;
    handlers[type] = handlers[type].filter(f => f !== fn);
  }

  // 이벤트 발생
  function emit(type, data) {
    (handlers[type] || []).forEach(fn => { try { fn(data); } catch(e) { console.error('GlobalWS handler error:', e); } });
    (handlers['*']  || []).forEach(fn => { try { fn({type, data}); } catch(e) {} });
  }

  // WS 전송
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function getWS() { return ws; }

  // 연결
  function connect() {
    const token = localStorage.getItem('ss_token');
    if (!token || isConnecting) return;
    if (ws && ws.readyState === WebSocket.OPEN) return;

    isConnecting = true;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

    try {
      ws = new WebSocket(url);
    } catch(e) {
      isConnecting = false;
      reconnectTimer = setTimeout(connect, 5000);
      return;
    }

    ws.onopen = () => {
      isConnecting = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      ws.send(JSON.stringify({ type: 'auth', token }));
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      // 전체 메시지를 타입별로 emit
      emit(msg.type, msg);

      // notification 이벤트는 event 필드 기반으로도 emit
      if (msg.type === 'notification' && msg.event) {
        emit('notification:' + msg.event, msg);
      }
    };

    ws.onclose = () => {
      isConnecting = false;
      ws = null;
      const token = localStorage.getItem('ss_token');
      if (token) reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = () => {
      isConnecting = false;
    };
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  // 로그인 상태면 자동 연결
  if (localStorage.getItem('ss_token')) {
    // DOM 준비 후 연결
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', connect);
    } else {
      connect();
    }
  }

  return { on, off, send, connect, disconnect, getWS };
})();

// ── 전역 실시간 UI 처리 ──────────────────
// 어느 페이지에 있든 동작하는 공통 이벤트

// 1. 채팅 메시지 수신 → 네비게이션 배지 표시
GlobalWS.on('message', (msg) => {
  // 실시간 채팅 메시지 (방 안에 있을 때)
  const d = msg.data;
  if (!d) return;
  const isChatPage = location.pathname.includes('chat.html');
  const activeRoom = window.activeRoomId;
  if (isChatPage && activeRoom === d.room_id) return; // 현재 보고 있는 방이면 스킵

  // 다른 페이지이거나 다른 방 → 배지 + 토스트
  _bumpBadge('chat.html', 1);
  if (!isChatPage) {
    _showToast(`💬 새 메시지: ${d.preview || (d.content||'').slice(0,20) || '사진'}`, 'info');
  }
});

// 1-1. 다른 페이지에 있을 때 새 메시지 알림 (notification 타입)
GlobalWS.on('notification', (msg) => {
  if (msg.event !== 'new_message') return;

  const isChatPage = location.pathname.includes('chat.html');
  _bumpBadge('chat.html', 1);

  if (!isChatPage) {
    _showToast(`💬 새 메시지: ${msg.preview || '새 메시지가 도착했습니다'}`, 'info');
  }

  if (typeof window.loadRooms === 'function') window.loadRooms();
});

// 2. 알림 수신 → 이벤트별 토스트 + 배지 + 팝업
GlobalWS.on('notification', (msg) => {
  if (msg.event === 'new_message') return; // 위에서 처리
  const ev   = msg.event  || '';
  const text = msg.message || '';

  // ── 이벤트별 처리 ──────────────────────

  // 좋아요 수신
  if (ev === 'profile_like') {
    _showToast(text || '💗 누군가 회원님에게 좋아요를 눌렀습니다.', 'success');
    _bumpBadge('match.html', 1);
    _showPopup({
      icon: '💗',
      title: '좋아요 도착',
      body: text || '누군가 회원님에게 좋아요를 눌렀습니다.',
      actions: [
        { label: '확인하기', href: 'match.html', primary: true },
        { label: '나중에', close: true }
      ]
    });
    return;
  }

  // 소개팅 신청 수신
  if (ev === 'match_request') {
    _showToast(text || '💌 새로운 소개팅 신청이 도착했습니다!', 'info');
    _bumpBadge('match.html', 1);
    _showPopup({
      icon: '💌',
      title: '소개팅 신청 도착',
      body: '새로운 소개팅 신청이 도착했습니다.',
      actions: [
        { label: '확인하기', href: 'match.html', primary: true },
        { label: '나중에', close: true }
      ]
    });
    return;
  }

  // 매칭 성사
  if (ev === 'match_accepted') {
    _showToast(text || '💕 소개팅이 성사됐습니다!', 'success');
    _bumpBadge('chat.html', 1);
    _showPopup({
      icon: '💕',
      title: '소개팅 성사!',
      body: '소개팅이 성사됐습니다. 지금 바로 채팅방에서 대화를 시작해보세요!',
      actions: [
        { label: '채팅방으로', href: 'chat.html', primary: true },
        { label: '나중에', close: true }
      ]
    });
    if (typeof window.loadRooms === 'function') window.loadRooms();
    return;
  }

  // 날짜 잡기 (만남 제안 수신)
  if (ev === 'proposal') {
    _showToast(text || '📅 새로운 만남 제안이 도착했습니다!', 'info');
    _bumpBadge('chat.html', 1);
    const roomId = msg.roomId || '';
    _showPopup({
      icon: '📅',
      title: '만남 제안 도착',
      body: `${msg.place ? msg.place + '에서 만남을 제안했습니다.' : '새로운 만남 제안이 도착했습니다.'}`,
      actions: [
        { label: '확인하기', href: roomId ? `room.html?room=${roomId}` : 'chat.html', primary: true },
        { label: '나중에', close: true }
      ]
    });
    return;
  }

  // 만남 제안 수락됨
  if (ev === 'proposal_accepted') {
    _showToast(text || '✅ 만남 제안이 수락됐습니다!', 'success');
    _showPopup({
      icon: '✅',
      title: '만남 확정!',
      body: '상대방이 만남 제안을 수락했습니다. 즐거운 만남이 되세요!',
      actions: [
        { label: '채팅으로', href: msg.roomId ? `chat.html?room=${msg.roomId}` : 'chat.html', primary: true },
        { label: '닫기', close: true }
      ]
    });
    return;
  }

  // 매칭 종료
  if (ev === 'match_cancelled') {
    _showToast(text || '💔 매칭이 종료됐습니다.', 'error');
    _showPopup({
      icon: '💔',
      title: '매칭 종료',
      body: '상대방이 매칭을 종료했습니다. 새로운 인연을 찾아보세요.',
      actions: [
        { label: '매칭 보기', href: 'match.html', primary: true },
        { label: '닫기', close: true }
      ]
    });
    if (typeof window.loadRooms === 'function') window.loadRooms();
    return;
  }

  // 문의 답변
  if (ev === 'inquiry_answered') {
    _showToast(text || '📩 문의 답변이 등록됐습니다.', 'info');
    _showPopup({
      icon: '📩',
      title: '문의 답변 도착',
      body: `"${msg.title || '문의'}"에 답변이 등록됐습니다.`,
      actions: [
        { label: '확인하기', href: 'inquiry.html', primary: true },
        { label: '닫기', close: true }
      ]
    });
    return;
  }

  // 계정 승인
  if (ev === 'account_approved') {
    _showToast(text || '🎉 계정이 승인됐습니다!', 'success');
    _showPopup({
      icon: '🎉',
      title: '계정 승인 완료',
      body: '계정이 승인됐습니다. 이제 모든 서비스를 이용할 수 있습니다!',
      actions: [
        { label: '시작하기', href: 'match.html', primary: true }
      ]
    });
    setTimeout(() => location.reload(), 3000);
    return;
  }

  // 기타 알림 - 토스트만
  if (text) _showToast(text, 'info');
});

// 3. refresh 이벤트 → 해당 페이지면 재로드
GlobalWS.on('refresh', (msg) => {
  const target = msg.target;
  if (target === 'chatrooms' && typeof window.loadRooms === 'function') window.loadRooms();
  if (target === 'members'   && typeof window.loadMembers === 'function') window.loadMembers();
  if (target === 'notifs'    && typeof window.checkNotifs === 'function') window.checkNotifs();
});

// 4. 캐미 초대 → 어느 페이지에서든 팝업
GlobalWS.on('chemi_event', (msg) => {
  const d = msg.data;
  if (!d || d.event !== 'invite') return;
  // 채팅 페이지면 chat.html 자체 처리에 맡김
  if (location.pathname.includes('chat.html')) return;

  // 다른 페이지에서 캐미 초대를 받으면 알림 팝업
  _showChemiInvitePopup(d);
});

// ── 토스트 알림 ──────────────────────────
function _showToast(message, type) {
  let wrap = document.getElementById('_gToastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = '_gToastWrap';
    wrap.style.cssText = 'position:fixed;top:72px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:320px;';
    document.body.appendChild(wrap);
  }

  const t = document.createElement('div');
  t.style.cssText = `
    padding:13px 18px;border-radius:10px;font-size:13px;line-height:1.55;
    color:#fff;cursor:pointer;
    background:${type==='success'?'#2C6B3F':type==='error'?'#8B2020':'#2C2020'};
    box-shadow:0 4px 20px rgba(0,0,0,.25);
    animation:_gSlideIn .25s ease;
  `;
  t.textContent = message;
  t.onclick = () => t.remove();

  if (!document.getElementById('_gToastStyle')) {
    const s = document.createElement('style');
    s.id = '_gToastStyle';
    s.textContent = '@keyframes _gSlideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}';
    document.head.appendChild(s);
  }

  wrap.appendChild(t);
  setTimeout(() => t?.remove(), 5000);
}

// ── 팝업 알림 ────────────────────────────
function _showPopup({ icon, title, body, actions = [] }) {
  // 기존 팝업 제거
  document.getElementById('_gPopup')?.remove();

  const pop = document.createElement('div');
  pop.id = '_gPopup';
  pop.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:99998;
    max-width:300px;width:calc(100vw - 48px);
    background:#1a0708;color:#f5efe6;
    border:1px solid rgba(212,182,121,.25);border-radius:14px;
    padding:20px 22px;
    box-shadow:0 8px 40px rgba(0,0,0,.4);
    animation:_popIn .3s ease;
  `;

  if (!document.getElementById('_gPopStyle')) {
    const s = document.createElement('style');
    s.id = '_gPopStyle';
    s.textContent = '@keyframes _popIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}';
    document.head.appendChild(s);
  }

  const btns = actions.map(a => {
    if (a.close) return `<button onclick="document.getElementById('_gPopup')?.remove()" style="flex:1;padding:10px 8px;border-radius:999px;background:transparent;color:rgba(245,239,230,.5);border:1px solid rgba(245,239,230,.15);cursor:pointer;font-size:12px;font-family:inherit;">${a.label}</button>`;
    return `<a href="${a.href}" onclick="document.getElementById('_gPopup')?.remove()" style="flex:1;padding:10px 8px;border-radius:999px;background:${a.primary?'rgba(212,182,121,.9)':'transparent'};color:${a.primary?'#1a0708':'rgba(245,239,230,.7)'};border:1px solid ${a.primary?'transparent':'rgba(245,239,230,.15)'};cursor:pointer;font-size:12px;font-weight:${a.primary?'600':'400'};text-align:center;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">${a.label}</a>`;
  }).join('');

  pop.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;">
      <div style="font-size:28px;line-height:1;flex-shrink:0;">${icon}</div>
      <div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px;">${title}</div>
        <div style="font-size:12px;color:rgba(245,239,230,.6);line-height:1.55;">${body}</div>
      </div>
      <button onclick="document.getElementById('_gPopup')?.remove()" style="background:none;border:none;color:rgba(245,239,230,.3);cursor:pointer;font-size:16px;padding:0;margin-left:auto;flex-shrink:0;">✕</button>
    </div>
    ${btns ? `<div style="display:flex;gap:8px;">${btns}</div>` : ''}
  `;
  document.body.appendChild(pop);

  // 10초 후 자동 닫힘
  setTimeout(() => pop?.remove(), 10000);
}

// ── 네비 배지 ────────────────────────────
function _bumpBadge(page, count) {
  const nav = document.querySelector(`a[href="${page}"].snb, a[href*="${page}"].snb`);
  if (!nav) return;
  let badge = nav.querySelector('._nb');
  if (count === 0) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = '_nb';
    badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 3px;border-radius:8px;background:#C0392B;color:#fff;font-size:9px;font-weight:700;margin-left:3px;vertical-align:middle;';
    nav.appendChild(badge);
  }
  const cur = parseInt(badge.textContent) || 0;
  badge.textContent = cur + count > 9 ? '9+' : (cur + count) || '!';
}

// ── 캐미 초대 팝업 (채팅 외 페이지) ─────
function _showChemiInvitePopup(data) {
  _showPopup({
    icon: '✦',
    title: '캐미라인 게임 초대!',
    body: '상대방이 캐미라인 게임을 제안했습니다. 채팅으로 이동해서 참여하세요.',
    actions: [
      { label: '채팅으로', href: 'chat.html', primary: true },
      { label: '나중에', close: true }
    ]
  });
}
function _showChemiInvitePopup_old(data) {
  const existing = document.getElementById('_gChemiInvite');
  if (existing) return;

  const pop = document.createElement('div');
  pop.id = '_gChemiInvite';
  pop.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99998;max-width:300px;background:#1a0708;color:#f5efe6;border:1px solid rgba(212,182,121,.3);border-radius:14px;padding:20px 24px;box-shadow:0 8px 32px rgba(0,0,0,.4);';
  pop.innerHTML = `
    <div style="font-family:monospace;font-size:10px;letter-spacing:.2em;color:rgba(212,182,121,.8);margin-bottom:8px;">CHEMI LINE ✦</div>
    <div style="font-size:14px;font-weight:600;margin-bottom:6px;">캐미라인 게임 초대!</div>
    <div style="font-size:12px;color:rgba(245,239,230,.6);margin-bottom:16px;">상대방이 게임을 제안했습니다.<br>채팅으로 이동해서 참여하세요.</div>
    <div style="display:flex;gap:8px;">
      <a href="chat.html" style="flex:1;padding:10px;border-radius:999px;background:rgba(212,182,121,.9);color:#1a0708;text-align:center;font-size:12px;font-weight:600;text-decoration:none;">채팅으로 이동</a>
      <button onclick="document.getElementById('_gChemiInvite').remove()" style="flex:1;padding:10px;border-radius:999px;background:transparent;color:rgba(245,239,230,.5);border:1px solid rgba(245,239,230,.15);cursor:pointer;font-size:12px;">나중에</button>
    </div>`;
  document.body.appendChild(pop);
  setTimeout(() => pop?.remove(), 15000);
}
