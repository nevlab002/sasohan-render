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
  // 로그인 체크 - 토큰 없으면 로그인 페이지로
  requireAuth: (adminRequired = false) => {
    const token = localStorage.getItem('ss_token');
    if (!token) {
      window.location.href = `${window.location.origin}/pages/login.html`;
      return false;
    }
    if (adminRequired) {
      const user = (() => { try { return JSON.parse(localStorage.getItem('ss_user')); } catch { return null; } })();
      if (!user || user.role !== 'admin') {
        alert('관리자만 접근 가능합니다.');
        window.location.href = `${window.location.origin}/pages/match.html`;
        return false;
      }
    }
    return true;
  }
};

async function loadNavProfilePic() {
  const token = API.getToken?.() || localStorage.getItem('ss_token');
  if (!token) return;
  const nav = document.querySelector('.site-nav-links');
  if (!nav || document.getElementById('navProfilePic')) return;

  try {
    const res = await fetch(`${API.BASE}/api/profiles/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return;
    const profile = await res.json();
    const raw = profile?.photos?.[0];
    if (!raw) return;
    const src = raw.startsWith('http') ? raw : API.BASE + raw;

    const btn = document.createElement('a');
    btn.id = 'navProfilePic';
    btn.href = 'profile.html';
    btn.setAttribute('aria-label', '내 프로필 보기');
    btn.title = '내 프로필';
    btn.style.cssText = 'width:30px;height:30px;border-radius:50%;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;border:2px solid var(--champagne);margin-left:2px;vertical-align:middle;background:var(--paper);';
    btn.innerHTML = `<img src="${src}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
    nav.appendChild(btn);
  } catch {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadNavProfilePic);
} else {
  loadNavProfilePic();
}

// ══════════════════════════════════════════
// GlobalWS: 전역 실시간 연결
// ══════════════════════════════════════════
const GlobalWS = (() => {
  let ws = null;
  let reconnectTimer = null;
  let connecting = false;
  const handlers = {};

  function on(type, fn) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(fn);
  }
  function off(type, fn) {
    if (!handlers[type]) return;
    handlers[type] = handlers[type].filter(f => f !== fn);
  }
  function emit(type, data) {
    (handlers[type] || []).forEach(fn => { try { fn(data); } catch(e) { console.error('GlobalWS:', e); } });
  }
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function getWS() { return ws; }

  function connect() {
    const token = localStorage.getItem('ss_token');
    if (!token || connecting || (ws && ws.readyState === WebSocket.OPEN)) return;
    connecting = true;
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    } catch(e) { connecting = false; reconnectTimer = setTimeout(connect, 5000); return; }

    ws.onopen = () => {
      connecting = false;
      clearTimeout(reconnectTimer); reconnectTimer = null;
      ws.send(JSON.stringify({ type: 'auth', token }));
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      emit(msg.type, msg);
      if (msg.type === 'notification' && msg.event) emit('notification:' + msg.event, msg);
    };
    ws.onclose = () => {
      connecting = false; ws = null;
      if (localStorage.getItem('ss_token')) reconnectTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => { connecting = false; };
  }

  if (localStorage.getItem('ss_token')) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', connect);
    else connect();
  }

  return { on, off, send, connect, getWS };
})();



// ══════════════════════════════════════════
// 알림 센터 (NotifCenter)
// ══════════════════════════════════════════
const NotifCenter = (() => {
  const BASE = window.location.origin;
  let notifs = [];
  let panelOpen = false;

  const TYPE_MAP = {
    match_request:    { icon: '💌', label: '소개팅 신청', color: '#C9A48F' },
    match_accepted:   { icon: '💕', label: '매칭 성사',   color: '#27AE60' },
    proposal:         { icon: '📅', label: '만남 제안',   color: '#3498DB' },
    proposal_accept:  { icon: '✅', label: '만남 수락',   color: '#27AE60' },
    cancel:           { icon: '💔', label: '매칭 종료',   color: '#C0392B' },
    match_cancelled:  { icon: '💔', label: '매칭 종료',   color: '#C0392B' },
    inquiry_answered: { icon: '📩', label: '문의 답변',   color: '#9B59B6' },
    account_approved: { icon: '🎉', label: '계정 승인',   color: '#27AE60' },
    profile_like:     { icon: '💗', label: '좋아요',      color: '#E91E63' },
    chemi:            { icon: '✦',  label: '캐미라인',    color: '#C9A48F' },
    default:          { icon: '🔔', label: '알림',        color: '#7F8C8D' }
  };

  function getTypeMeta(type) {
    return TYPE_MAP[type] || TYPE_MAP.default;
  }

  function isNotificationBadgeType(n) {
    const t = String(n?.type || '');
    const ev = String(n?.event || '');
    return !['message', 'chat', 'new_message'].includes(t) && ev !== 'new_message';
  }

  function createPanel() {
    if (document.getElementById('_nc_panel')) return;

    const panel = document.createElement('div');
    panel.id = '_nc_panel';
    panel.style.cssText = `
      position:fixed;top:58px;right:16px;z-index:99990;
      width:340px;max-width:calc(100vw - 32px);
      background:#fff;border:1px solid #e5e5e5;
      border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,.15);
      display:none;flex-direction:column;overflow:hidden;
      max-height:80vh;
    `;
    panel.innerHTML = `
      <div style="padding:16px 20px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between;background:#fafafa;">
        <span style="font-weight:700;font-size:14px;color:#1a0708;">알림</span>
        <button onclick="NotifCenter.markAllRead()" style="font-size:11px;color:#9B7275;background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px;">모두 확인</button>
      </div>
      <div id="_nc_list" style="overflow-y:auto;flex:1;"></div>
      <div style="padding:12px 20px;border-top:1px solid #f0f0f0;text-align:center;background:#fafafa;">
        <span style="font-size:12px;color:#aaa;">최근 50개 알림 표시</span>
      </div>
    `;
    document.body.appendChild(panel);

    document.addEventListener('click', (e) => {
      if (!document.getElementById('_nc_panel')?.contains(e.target) &&
          !document.getElementById('_nc_btn')?.contains(e.target)) {
        closePanel();
      }
    });
  }

  function renderList() {
    const list = document.getElementById('_nc_list');
    if (!list) return;

    const visibleNotifs = (notifs || []).filter(isNotificationBadgeType);

    if (!visibleNotifs.length) {
      list.innerHTML = '<div style="padding:40px 20px;text-align:center;color:#bbb;font-size:13px;">알림이 없습니다</div>';
      return;
    }

    list.innerHTML = visibleNotifs.map(n => {
      const m = getTypeMeta(n.type);
      const time = _relTime(n.created_at);
      const link = n.link || '#';
      const bg = n.is_read ? '#fff' : '#FFF8F5';

      return `<div onclick="NotifCenter.clickNotif('${n.id}','${link}')"
        style="padding:14px 20px;border-bottom:1px solid #f5f5f5;cursor:pointer;background:${bg};transition:background .15s;">
        <div style="display:flex;gap:12px;align-items:flex-start;">
          <div style="width:36px;height:36px;border-radius:50%;background:${m.color}20;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">${m.icon}</div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:600;color:${m.color};margin-bottom:2px;">${m.label}</div>
            <div style="font-size:13px;color:#333;line-height:1.5;margin-bottom:4px;">${n.message || ''}</div>
            <div style="font-size:11px;color:#aaa;">${time}</div>
          </div>
          ${!n.is_read ? '<div style="width:8px;height:8px;border-radius:50%;background:#C0392B;flex-shrink:0;margin-top:4px;"></div>' : ''}
        </div>
      </div>`;
    }).join('');
  }

  async function loadChatUnreadCount() {
    const token = localStorage.getItem('ss_token');
    if (!token) return 0;

    try {
      const r = await fetch(`${BASE}/api/chat/unread-count`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) return 0;

      const d = await r.json();
      const count = Number(d.unread || 0);
      _setNavBadge('chat.html', count);
      return count;
    } catch {
      return 0;
    }
  }

  function updateBadge() {
    const unread = (notifs || []).filter(n => !n.is_read && isNotificationBadgeType(n)).length;
    const btn = document.getElementById('_nc_btn');
    if (!btn) return;

    let badge = btn.querySelector('._nc_badge');

    if (unread > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = '_nc_badge';
        badge.style.cssText = 'position:absolute;top:-4px;right:-4px;min-width:16px;height:16px;border-radius:8px;background:#C0392B;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 3px;';
        btn.style.position = 'relative';
        btn.appendChild(badge);
      }
      badge.textContent = unread > 99 ? '99+' : unread;
    } else {
      badge?.remove();
    }
  }

  async function load() {
    const token = localStorage.getItem('ss_token');
    if (!token) return;

    try {
      const r = await fetch(`${BASE}/api/room/notifications/list`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) return;

      notifs = await r.json();
      updateBadge();
      renderList();
      await NotifCenter.loadChatUnreadCount?.();
    } catch {}
  }

  function addNotif(n) {
    if (!isNotificationBadgeType(n)) {
      NotifCenter.loadChatUnreadCount?.();
      return;
    }

    notifs.unshift(n);
    updateBadge();
    renderList();
  }

  async function markAllRead() {
    const token = localStorage.getItem('ss_token');
    if (!token) return;

    try {
      await fetch(`${BASE}/api/room/notifications/read-notifs`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });

      notifs.forEach(n => {
        if (isNotificationBadgeType(n)) n.is_read = true;
      });

      updateBadge();
      renderList();
    } catch {}
  }

  async function clickNotif(id, link) {
    const token = localStorage.getItem('ss_token');

    if (token) {
      fetch(`${BASE}/api/room/notifications/${id}/read`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => {});
    }

    const n = notifs.find(x => x.id === id);
    if (n) {
      n.is_read = true;
      updateBadge();
      renderList();
    }

    closePanel();

    if (link && link !== '#') {
      if (link.startsWith('/pages/')) {
        window.location.href = link.replace('/pages/', '');
      } else {
        window.location.href = link;
      }
    }
  }

  function togglePanel() {
    const panel = document.getElementById('_nc_panel');
    if (!panel) return;

    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? 'flex' : 'none';

    if (panelOpen) {
      load();
      renderList();
    }
  }

  function closePanel() {
    const panel = document.getElementById('_nc_panel');
    if (panel) panel.style.display = 'none';
    panelOpen = false;
  }

  function injectNavBtn() {
    if (document.getElementById('_nc_btn')) return;

    const nav = document.querySelector('.site-nav-links');
    if (!nav) return;

    const btn = document.createElement('button');
    btn.id = '_nc_btn';
    btn.type = 'button';
    btn.onclick = togglePanel;
    btn.style.cssText = 'background:none;border:1px solid rgba(58,14,20,.15);border-radius:999px;cursor:pointer;padding:6px 10px;font-size:15px;color:var(--bordeaux,#3a0e14);display:inline-flex;align-items:center;justify-content:center;position:relative;min-height:34px;';
    btn.title = '알림';
    btn.innerHTML = '🔔';

    const logout = nav.querySelector('.logout');
    if (logout) nav.insertBefore(btn, logout);
    else nav.appendChild(btn);

    createPanel();
  }

  function init() {
    injectNavBtn();
    load();
    setInterval(load, 120000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    load,
    addNotif,
    markAllRead,
    clickNotif,
    togglePanel,
    closePanel,
    updateBadge,
    loadChatUnreadCount
  };
})();


// ══════════════════════════════════════════
// 전역 실시간 이벤트 처리
// ══════════════════════════════════════════

// ── 새 채팅 메시지 ────────────────────────
GlobalWS.on('message', (msg) => {
  const d = msg.data;
  if (!d) return;

  const isChatPage  = location.pathname.includes('chat.html');
  const activeRoom  = window.activeRoomId;
  const incomingRoom = d.room_id || d.roomId;

  // 현재 보고 있는 방이면 채팅 화면 자체가 처리
  if (isChatPage && activeRoom === incomingRoom) return;

  // 채팅은 알림센터에 넣지 않고, 채팅 카테고리 숫자로만 표시
  NotifCenter.loadChatUnreadCount?.();
  _setNavBadge('chat.html', 1, true);

  if (!isChatPage) {
    _showToast(`💬 ${d.sender_name || '상대방'}: ${(d.msg_type === 'photo' ? '사진' : (d.content || '새 메시지')).slice(0,30)}`, 'chat');
  }
});

// ── 다른 페이지에서 수신한 메시지 알림 ────
GlobalWS.on('notification', (msg) => {
  if (msg.event === 'new_message') {
    NotifCenter.loadChatUnreadCount?.();
    _setNavBadge('chat.html', 1, true);

    const isChatPage = location.pathname.includes('chat.html');
    if (!isChatPage) _showToast(`💬 새 메시지: ${msg.preview || '새 메시지'}`, 'chat');
    return;
  }

  const ev   = msg.event || '';
  const text = msg.message || '';

  // 알림 센터에 저장
  const notifObj = {
    id: 'ws_' + Date.now(),
    type: ev === 'match_request' ? 'match_request'
        : ev === 'match_accepted' ? 'match_accepted'
        : ev === 'proposal' ? 'proposal'
        : ev === 'proposal_accepted' ? 'proposal_accept'
        : ev === 'match_cancelled' ? 'cancel'
        : ev === 'inquiry_answered' ? 'inquiry_answered'
        : ev === 'profile_like' ? 'profile_like'
        : ev === 'blocked_by' ? 'blocked_by'
        : ev === 'unblocked_by' ? 'unblocked_by'
        : 'default',
    message: text || '새 알림이 도착했습니다.',
    link: msg.link || '#',
    is_read: false,
    created_at: new Date().toISOString()
  };

  NotifCenter.addNotif(notifObj);
  NotifCenter.load?.();

  // 이벤트별 팝업
  if (ev === 'match_request') {
    _showToast(text, 'info');
    _showPopup({ icon:'💌', title:'소개팅 신청 도착', body:'새로운 소개팅 신청이 도착했습니다.',
      actions:[{label:'확인하기',href:'match.html',primary:true},{label:'나중에',close:true}] });
    return;
  }
  if (ev === 'match_accepted') {
    _showToast(text, 'success');
    _showPopup({ icon:'💕', title:'소개팅 성사!', body:'소개팅이 성사됐습니다. 지금 채팅을 시작해보세요!',
      actions:[{label:'채팅방으로',href:msg.roomId?`chat.html?room=${msg.roomId}`:'chat.html',primary:true},{label:'나중에',close:true}] });
    if (typeof window.loadRooms === 'function') window.loadRooms();
    return;
  }
  if (ev === 'proposal') {
    _showToast(text, 'info');
    _showPopup({ icon:'📅', title:'만남 제안 도착',
      body: msg.place ? `${msg.place}에서 만남을 제안했습니다.` : '새로운 만남 제안이 도착했습니다.',
      actions:[{label:'채팅으로',href:msg.roomId?`chat.html?room=${msg.roomId}`:'chat.html',primary:true},{label:'나중에',close:true}] });
    return;
  }
  if (ev === 'proposal_accepted') {
    _showToast(text, 'success');
    _showPopup({ icon:'✅', title:'만남 확정!', body:'상대방이 만남 제안을 수락했습니다!',
      actions:[{label:'채팅으로',href:msg.roomId?`chat.html?room=${msg.roomId}`:'chat.html',primary:true},{label:'닫기',close:true}] });
    return;
  }
  if (ev === 'match_cancelled') {
    _showToast(text, 'error');
    _showPopup({ icon:'💔', title:'매칭 종료', body:'상대방이 매칭을 종료했습니다.',
      actions:[{label:'매칭 보기',href:'match.html',primary:true},{label:'닫기',close:true}] });
    if (typeof window.loadRooms === 'function') window.loadRooms();
    return;
  }
  if (ev === 'inquiry_answered') {
    _showToast(text, 'info');
    _showPopup({ icon:'📩', title:'문의 답변 도착', body:`"${msg.title||'문의'}"에 답변이 등록됐습니다.`,
      actions:[{label:'확인하기',href:'inquiry.html',primary:true},{label:'닫기',close:true}] });
    return;
  }
  if (ev === 'account_approved') {
    _showToast(text, 'success');
    _showPopup({ icon:'🎉', title:'계정 승인 완료', body:'이제 모든 서비스를 이용할 수 있습니다!',
      actions:[{label:'시작하기',href:'match.html',primary:true}] });
    setTimeout(() => location.reload(), 3000);
    return;
  }
  if (ev === 'blocked_by') {
    _showToast(text || '상대방이 회원님을 차단했습니다.', 'error');
    _showPopup({ icon:'🚫', title:'차단 알림',
      body: text || '상대방이 회원님을 차단했습니다. 해당 채팅방에서 메시지를 보낼 수 없습니다.',
      actions:[{label:'채팅으로',href:'chat.html',primary:true},{label:'닫기',close:true}] });
    return;
  }
  if (ev === 'unblocked_by') {
    _showToast(text || '상대방이 차단을 해제했습니다.', 'success');
    _showPopup({ icon:'🔓', title:'차단 해제 알림',
      body: text || '상대방이 차단을 해제했습니다. 이제 다시 메시지를 보낼 수 있습니다.',
      actions:[{label:'채팅으로',href:'chat.html',primary:true},{label:'닫기',close:true}] });
    return;
  }
  if (text) _showToast(text, 'info');
});

// ── 캐미 게임 이벤트 ─────────────────────
GlobalWS.on('chemi_event', (msg) => {
  const d = msg.data || msg;
  const ev = d.event || d.data?.event;

  // 채팅 페이지면 chat.html 자체가 처리
  if (location.pathname.includes('chat.html')) return;

  // 다른 페이지에서 캐미 초대 수신
  if (ev === 'invite' || ev === 'invite_from_other_page') {
    const roomId = d.roomId || d.data?.roomId || '';
    // 채팅방 링크 (roomId 있으면 해당 방으로 직접)
    const chatLink = roomId ? `chat.html?room=${roomId}` : 'chat.html';

    // 알림 센터에 추가
    NotifCenter.addNotif({
      id: 'chemi_' + Date.now(),
      type: 'chemi',
      message: '상대방이 캐미라인 게임을 제안했습니다.',
      link: chatLink,
      is_read: false,
      created_at: new Date().toISOString()
    });

    // 팝업: 채팅방으로 이동 유도 (게임 자동 시작 X)
    _showPopup({
      icon: '✦',
      title: '캐미라인 게임 초대!',
      body: '상대방이 캐미라인 게임을 제안했습니다.\n채팅방에서 수락하거나 거절할 수 있습니다.',
      actions: [
        { label: '채팅방으로 이동', href: chatLink, primary: true },
        { label: '나중에', close: true }
      ]
    });
    _showToast('✦ 캐미라인 게임 초대가 왔습니다!', 'info');
  }
});

// ── refresh 이벤트 ────────────────────────
GlobalWS.on('refresh', (msg) => {
  if (msg.target === 'chatrooms' && typeof window.loadRooms === 'function') window.loadRooms();
  if (msg.target === 'notifs') NotifCenter.load();
});


// ══════════════════════════════════════════
// UI 헬퍼 함수들
// ══════════════════════════════════════════

// 토스트
function _showToast(message, type) {
  let wrap = document.getElementById('_gToastWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = '_gToastWrap';
    wrap.style.cssText = 'position:fixed;top:68px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:300px;pointer-events:none;';
    document.body.appendChild(wrap);
  }
  if (!document.getElementById('_gStyle')) {
    const s = document.createElement('style');
    s.id = '_gStyle';
    s.textContent = `
      @keyframes _tin{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}
      @keyframes _popIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
    `;
    document.head.appendChild(s);
  }
  const bg = type==='success'?'#1e4d2b':type==='error'?'#5c1a1a':type==='chat'?'#1a2340':'#1a0708';
  const t = document.createElement('div');
  t.style.cssText = `padding:11px 16px;border-radius:10px;font-size:12px;line-height:1.5;color:#fff;background:${bg};box-shadow:0 4px 16px rgba(0,0,0,.25);animation:_tin .25s ease;pointer-events:auto;cursor:pointer;`;
  t.textContent = message;
  t.onclick = () => t.remove();
  wrap.appendChild(t);
  setTimeout(() => t?.remove(), 5000);
}

// 팝업
function _showPopup({ icon, title, body, actions = [] }) {
  document.getElementById('_gPopup')?.remove();
  const pop = document.createElement('div');
  pop.id = '_gPopup';
  pop.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:99998;max-width:300px;width:calc(100vw - 48px);background:#1a0708;color:#f5efe6;border:1px solid rgba(212,182,121,.2);border-radius:14px;padding:20px 22px;box-shadow:0 8px 40px rgba(0,0,0,.4);animation:_popIn .3s ease;';
  const btns = actions.map(a => {
    if (a.close) return `<button onclick="document.getElementById('_gPopup')?.remove()" style="flex:1;padding:10px;border-radius:999px;background:transparent;color:rgba(245,239,230,.5);border:1px solid rgba(245,239,230,.15);cursor:pointer;font-size:12px;font-family:inherit;">${a.label}</button>`;
    return `<a href="${a.href}" onclick="document.getElementById('_gPopup')?.remove()" style="flex:1;padding:10px;border-radius:999px;background:${a.primary?'rgba(212,182,121,.9)':'transparent'};color:${a.primary?'#1a0708':'rgba(245,239,230,.7)'};border:1px solid ${a.primary?'transparent':'rgba(245,239,230,.15)'};cursor:pointer;font-size:12px;font-weight:${a.primary?'600':'400'};text-align:center;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">${a.label}</a>`;
  }).join('');
  pop.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:${btns?'14':'0'}px;">
      <div style="font-size:28px;flex-shrink:0;">${icon}</div>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:700;margin-bottom:4px;">${title}</div>
        <div style="font-size:12px;color:rgba(245,239,230,.65);line-height:1.6;">${body}</div>
      </div>
      <button onclick="document.getElementById('_gPopup')?.remove()" style="background:none;border:none;color:rgba(245,239,230,.3);cursor:pointer;font-size:16px;padding:0;flex-shrink:0;">✕</button>
    </div>
    ${btns ? `<div style="display:flex;gap:8px;">${btns}</div>` : ''}
  `;
  document.body.appendChild(pop);
  setTimeout(() => pop?.remove(), 12000);
}

// nav 배지 (절대값 또는 누적)
function _setNavBadge(page, count, accumulate = false) {
  const nav = document.querySelector(`a[href="${page}"].snb, a[href*="${page}"].snb`);
  if (!nav) return;
  if (count === 0) { nav.querySelector('._nb')?.remove(); return; }
  let badge = nav.querySelector('._nb');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = '_nb';
    badge.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 3px;border-radius:8px;background:#C0392B;color:#fff;font-size:9px;font-weight:700;margin-left:3px;vertical-align:middle;';
    nav.appendChild(badge);
  }
  if (accumulate) {
    const cur = parseInt(badge.textContent) || 0;
    const next = cur + count;
    badge.textContent = next > 99 ? '99+' : String(next);
  } else {
    badge.textContent = count > 99 ? '99+' : String(count);
  }
}

// 상대 시간 표시
function _relTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr), now = new Date();
  const diff = Math.floor((now - d) / 1000);
  if (diff < 60)   return '방금 전';
  if (diff < 3600) return Math.floor(diff/60) + '분 전';
  if (diff < 86400)return Math.floor(diff/3600) + '시간 전';
  return d.toLocaleDateString('ko', {month:'numeric',day:'numeric'});
}
