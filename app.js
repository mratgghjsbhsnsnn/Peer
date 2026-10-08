(() => {
  'use strict';

  const APP_KEY = 'linka:v3';
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MAX_IMAGE_BYTES = 180 * 1024;
  const RETRY_DELAYS = [1500, 4000, 9000, 18000];

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const state = {
    db: loadDB(),
    peer: null,
    connections: new Map(),
    pending: new Map(),
    retryTimers: new Map(),
    currentFriend: null,
    currentView: 'chats',
    deferredInstall: null,
    incomingCall: null,
    activeCall: null,
    localStream: null,
    callType: 'voice'
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    wireStaticEvents();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    await bootPeerApp();
    if (state.db.account) showApp(); else showAuth();
    refreshIcons();
    setTimeout(() => $('#boot')?.classList.add('hidden'), 250);
  }

  function defaultDB() {
    return {
      account: null,
      friends: [],
      chats: {},
      settings: { notifications: false },
      installedAt: null
    };
  }

  function loadDB() {
    try {
      let raw = JSON.parse(localStorage.getItem(APP_KEY) || '{}');
      if (!raw.account) {
        const legacy = JSON.parse(localStorage.getItem('linka:v2') || 'null');
        if (legacy?.account) {
          raw = legacy;
          localStorage.setItem(APP_KEY, JSON.stringify(raw));
        }
      }
      return {
        ...defaultDB(),
        ...raw,
        chats: raw.chats || {},
        friends: Array.isArray(raw.friends) ? raw.friends : [],
        settings: { ...defaultDB().settings, ...(raw.settings || {}) }
      };
    } catch {
      return defaultDB();
    }
  }

  function saveDB() {
    localStorage.setItem(APP_KEY, JSON.stringify(state.db));
  }

  function wireStaticEvents() {
    $('#toRegister')?.addEventListener('click', () => toggleAuth('register'));
    $('#toLogin')?.addEventListener('click', () => toggleAuth('login'));
    $('#registerForm')?.addEventListener('submit', onRegister);
    $('#loginForm')?.addEventListener('submit', onLogin);

    $$('[data-view]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.view)));
    $$('[data-go]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.go)));

        $('#newChatBtn')?.addEventListener('click', openAddFriendModal);
    $('#openAddFriendBtn')?.addEventListener('click', openAddFriendModal);
    $('#copyCodeBtn')?.addEventListener('click', copyMyCode);
    $('#shareCodeBtn')?.addEventListener('click', shareMyCode);
    $('#chatSearch')?.addEventListener('input', renderChatList);
    $('#homeFriendSearch')?.addEventListener('input', renderFriends);
    $('#messageForm')?.addEventListener('submit', sendTextMessage);
    $('#attachBtn')?.addEventListener('click', () => $('#imageInput')?.click());
    $('#imageInput')?.addEventListener('change', onImageSelected);
    $('#cancelReply')?.addEventListener('click', clearReply);
    $('#voiceCallBtn')?.addEventListener('click', () => startCall('voice'));
    $('#videoCallBtn')?.addEventListener('click', () => startCall('video'));
    $('#closeConversationBtn')?.addEventListener('click', closeMobileConversation);
    $('#profileBtn')?.addEventListener('click', () => navigate('profile'));
    $('#homeBtn')?.addEventListener('click', () => navigate('friends'));
    $('#notificationBtn')?.addEventListener('click', requestNotifications);
    $('#notificationBtn2')?.addEventListener('click', requestNotifications);
    $('#installAppBtn')?.addEventListener('click', installApp);
    $('#settingsInstallBtn')?.addEventListener('click', installApp);
    $('#changeAvatarBtn')?.addEventListener('click', () => $('#avatarInput')?.click());
    $('#avatarInput')?.addEventListener('change', onAvatarSelected);
    $('#profileAvatarBtn')?.addEventListener('click', () => $('#avatarInput')?.click());
    $('#profileNameInput')?.addEventListener('change', () => {
      const value = $('#profileNameInput').value.trim();
      if (!value || !state.db.account) return;
      state.db.account.name = value;
      saveDB();
      renderUser();
      sendProfileToFriends();
    });
    $('#resetAccountBtn')?.addEventListener('click', resetAccount);
    $$('[data-legal]').forEach(el => el.addEventListener('click', () => openLegal(el.dataset.legal)));

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      state.deferredInstall = e;
      $('#installAppBtn')?.classList.remove('hidden');
      $('#settingsInstallBtn')?.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => {
      state.deferredInstall = null;
      $('#installAppBtn')?.classList.add('hidden');
      $('#settingsInstallBtn')?.classList.add('hidden');
      toast('ติดตั้ง LINKA แล้ว');
    });
    window.addEventListener('online', () => state.peer?.disconnected && state.peer.reconnect());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        for (const f of state.db.friends) connectFriend(f, { notify: false });
      }
    });
  }

  function refreshIcons() { /* Tabler Icons use static classes. */ }

  function toggleAuth(mode) {
    $('#loginFormWrap')?.classList.toggle('hidden', mode !== 'login');
    $('#registerFormWrap')?.classList.toggle('hidden', mode !== 'register');
    refreshIcons();
  }

  function showAuth() {
    $('#appView')?.classList.add('hidden');
    $('#authView')?.classList.remove('hidden');
    toggleAuth(state.db.account ? 'login' : 'register');
  }

  function showApp() {
    $('#authView')?.classList.add('hidden');
    $('#appView')?.classList.remove('hidden');
    renderUser();
    renderChatList();
    renderFriends();
    navigate('friends');
    updateNotificationStatus();
    refreshIcons();
  }

  async function onRegister(e) {
    e.preventDefault();
    const name = $('#regName').value.trim();
    const username = $('#regUsername').value.trim().toLowerCase();
    const pin = $('#regPin').value;
    const pin2 = $('#regPin2').value;

    if (!name || !/^[A-Za-z0-9._-]{3,24}$/.test(username)) {
      return toast('ชื่อผู้ใช้ต้องยาว 3–24 ตัว และใช้ A-Z, 0-9, จุด หรือขีด');
    }
    if (pin !== pin2) return toast('รหัสผ่านไม่ตรงกัน');

    state.db.account = {
      name,
      username,
      pinHash: await hash(pin),
      code: generateCode(),
      avatar: ''
    };
    state.db.friends = [];
    state.db.chats = {};
    saveDB();

    await bootPeerApp(true);
    showApp();
    toast('สร้างบัญชีแล้ว');
  }

  async function onLogin(e) {
    e.preventDefault();
    if (!state.db.account) return toggleAuth('register');
    const username = $('#loginUsername').value.trim().toLowerCase();
    const pin = $('#loginPin').value;
    const account = state.db.account;
    if (username !== account.username || (await hash(pin)) !== account.pinHash) {
      return toast('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    showApp();
    if (!state.peer || state.peer.destroyed) await bootPeerApp(true);
    for (const friend of state.db.friends) connectFriend(friend, { notify: false });
  }

  async function hash(text) {
    const data = new TextEncoder().encode(text);
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function generateCode() {
    const bytes = new Uint32Array(6);
    crypto.getRandomValues(bytes);
    return [...bytes].map(n => CODE_ALPHABET[n % CODE_ALPHABET.length]).join('');
  }

  function esc(text = '') {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function formatTime(ts) {
    return new Intl.DateTimeFormat('th-TH', { hour: '2-digit', minute: '2-digit' }).format(ts);
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function dayLabel(ts) {
    return new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }).format(ts);
  }

  function lastChat(friend) {
    const list = state.db.chats[friend.code] || [];
    return list[list.length - 1] || null;
  }

  function findFriend(code) {
    return state.db.friends.find(f => f.code === code);
  }

  function ensureChat(code) {
    if (!state.db.chats[code]) state.db.chats[code] = [];
    return state.db.chats[code];
  }

  function upsertFriend(info) {
    if (!info?.code || !state.db.account || info.code === state.db.account.code) return;
    let friend = findFriend(info.code);
    if (!friend) {
      friend = {
        code: info.code,
        name: info.name || info.code,
        username: info.username || '',
        avatar: info.avatar || '',
        addedAt: Date.now(),
        online: false
      };
      state.db.friends.push(friend);
    } else {
      friend.name = info.name || friend.name;
      friend.username = info.username ?? friend.username;
      friend.avatar = info.avatar || friend.avatar;
    }
    saveDB();
    renderFriends();
    renderChatList();
    return friend;
  }

  function renderUser() {
    const account = state.db.account;
    if (!account) return;
    $('#profileMiniName') && ($('#profileMiniName').textContent = account.name);
    $('#profileMiniCode') && ($('#profileMiniCode').textContent = account.code);
    $('#myCodeLarge') && ($('#myCodeLarge').textContent = account.code);
    $('#profileUsername') && ($('#profileUsername').textContent = '@' + account.username);
    $('#profileUsername2') && ($('#profileUsername2').textContent = '@' + account.username);
    $('#profileCode') && ($('#profileCode').textContent = account.code);
    $('#profileCode2') && ($('#profileCode2').textContent = account.code);
    if ($('#profileNameInput')) $('#profileNameInput').value = account.name;
    setAvatar($('#profileMiniAvatar'), account.avatar, account.name);
    setAvatar($('#profileAvatarBtn'), account.avatar, account.name);
  }

  function setAvatar(el, src, name) {
    if (!el) return;
    el.textContent = '';
    if (src) {
      el.style.backgroundImage = `url(${src})`;
      el.classList.add('has-image');
    } else {
      el.style.backgroundImage = 'none';
      el.classList.remove('has-image');
      el.textContent = (name || 'L').trim().charAt(0).toUpperCase();
    }
  }

  function navigate(view) {
    state.currentView = view;
    $$('[data-view-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.viewPanel !== view));
    $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    $$('#mobileNav button[data-view]').forEach(item => item.classList.toggle('active', item.dataset.view === view));
    if (view !== 'chats') closeMobileConversation();
    renderUser();
    refreshIcons();
  }

  function closeMobileConversation() {
    if (window.innerWidth <= 760) {
      $('.conversation-panel')?.classList.remove('open');
      $('.chat-list-panel')?.classList.remove('hidden-mobile');
    }
  }

  function renderChatList() {
    const list = $('#chatList');
    if (!list) return;
    const q = ($('#chatSearch')?.value || '').trim().toLowerCase();
    list.innerHTML = '';
    const friends = state.db.friends.filter(f => !q || f.name.toLowerCase().includes(q) || f.code.toLowerCase().includes(q));
    $('#chatEmpty')?.classList.toggle('hidden', friends.length > 0 || !!q);

    for (const friend of friends) {
      const last = lastChat(friend);
      const row = document.createElement('button');
      row.className = `chat-row ${state.currentFriend?.code === friend.code ? 'active' : ''}`;
      row.type = 'button';
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      setAvatar(avatar, friend.avatar, friend.name);
      const statusDot = friend.online ? '<span class="presence-dot online"></span>' : '';
      row.innerHTML = `
        <div class="chat-row-avatar"></div>
        <div class="chat-row-main">
          <div class="chat-row-top"><strong>${esc(friend.name)}</strong><span class="chat-time">${last ? formatTime(last.ts) : ''}</span></div>
          <div class="chat-preview">${last ? (last.type === 'image' ? 'รูปภาพ' : esc(last.text || '')) : 'แตะเพื่อเริ่มสนทนา'} ${statusDot}</div>
        </div>`;
      $('.chat-row-avatar', row)?.appendChild(avatar);
      row.addEventListener('click', () => openConversation(friend.code));
      list.appendChild(row);
    }
    refreshIcons();
  }

  function renderFriends() {
    const grid = $('#friendsGrid');
    if (!grid) return;
    grid.innerHTML = '';
    const q = ($('#homeFriendSearch')?.value || '').trim().toLowerCase();
    const visibleFriends = state.db.friends.filter(f => !q || f.name.toLowerCase().includes(q) || f.code.toLowerCase().includes(q));
    $('#friendCount').textContent = `${visibleFriends.length} คน`;
    if (!visibleFriends.length && !q) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><i class="ti ti-users"></i></div>
          <strong>ยังไม่มีเพื่อน</strong>
          <p>เพิ่มคนที่คุณรู้จักด้วยรหัส LINKA ของเขา</p>
          <button class="btn secondary" id="emptyAddFriend">เพิ่มเพื่อน</button>
        </div>`;
      $('#emptyAddFriend')?.addEventListener('click', openAddFriendModal);
      refreshIcons();
      return;
    }

    for (const friend of visibleFriends) {
      const card = document.createElement('article');
      card.className = 'friend-card';
      const avatar = document.createElement('div');
      avatar.className = 'avatar large';
      setAvatar(avatar, friend.avatar, friend.name);
      card.innerHTML = `
        <div class="friend-avatar-wrap"></div>
        <div class="friend-info"><strong>${esc(friend.name)}</strong><span>@${esc(friend.username || 'เพื่อน')} · ${esc(friend.code)}</span><small class="friend-status ${friend.online ? 'is-online' : ''}">${friend.online ? 'ออนไลน์' : 'พร้อมติดต่อ'}</small></div>
        <div class="friend-actions">
          <button class="icon-btn" data-chat title="เปิดแชต" aria-label="เปิดแชต"><i class="ti ti-message-circle"></i></button>
          <button class="icon-btn" data-call title="โทรเสียง" aria-label="โทรเสียง"><i class="ti ti-phone"></i></button>
        </div>`;
      $('.friend-avatar-wrap', card)?.appendChild(avatar);
      $('[data-chat]', card)?.addEventListener('click', () => { navigate('chats'); openConversation(friend.code); });
      $('[data-call]', card)?.addEventListener('click', () => { navigate('chats'); openConversation(friend.code); setTimeout(() => startCall('voice'), 50); });
      grid.appendChild(card);
    }
    refreshIcons();
  }

  function openConversation(code) {
    const friend = findFriend(code);
    if (!friend) return;
    state.currentFriend = friend;
    $('#conversationEmpty')?.classList.add('hidden');
    $('#conversation')?.classList.remove('hidden');
    $('#conversationName').textContent = friend.name;
    setAvatar($('#conversationAvatar'), friend.avatar, friend.name);
    updateConversationStatus();
    renderMessages();
    renderChatList();
    connectFriend(friend, { notify: true });
    if (window.innerWidth <= 760) {
      $('.chat-list-panel')?.classList.add('hidden-mobile');
      $('.conversation-panel')?.classList.add('open');
    }
    refreshIcons();
  }

  function updateConversationStatus() {
    if (!state.currentFriend) return;
    const connected = isConnected(state.currentFriend.code);
    const friend = findFriend(state.currentFriend.code);
    $('#conversationPresence').textContent = connected ? 'ออนไลน์ · เชื่อมต่อแล้ว' : 'กำลังรอการเชื่อมต่อ';
    $('#conversationPresence').classList.toggle('is-online', connected);
    if (friend) friend.online = connected;
  }

  function renderMessages() {
    const box = $('#messages');
    if (!box || !state.currentFriend) return;
    box.innerHTML = '';
    let lastDay = '';
    for (const message of ensureChat(state.currentFriend.code)) {
      const dk = dayKey(message.ts);
      if (dk !== lastDay) {
        const d = document.createElement('div');
        d.className = 'day-divider';
        d.innerHTML = `<span>${dayLabel(message.ts)}</span>`;
        box.appendChild(d);
        lastDay = dk;
      }

      const row = document.createElement('div');
      row.className = `msg-row ${message.mine ? 'mine' : ''}`;
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';

      if (message.type === 'image') {
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = message.data;
        img.alt = 'รูปภาพ';
        bubble.appendChild(img);
      } else {
        bubble.innerHTML = esc(message.text || '').replace(/\n/g, '<br>');
      }
      if (message.replyText) {
        const quote = document.createElement('div');
        quote.className = 'quoted';
        quote.textContent = message.replyText;
        bubble.prepend(quote);
      }
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = `${formatTime(message.ts)}${message.mine ? `<span class="delivery ${message.sent ? 'sent' : ''}"><i class="ti ti-${message.sent ? 'checks' : 'clock'}"></i></span>` : ''}`;
      if (message.mine) {
        row.appendChild(meta);
        row.appendChild(bubble);
      } else {
        row.appendChild(bubble);
        row.appendChild(meta);
      }
      box.appendChild(row);
    }
    const scroller = $('#messageScroller');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    refreshIcons();
  }

  function clearReply() {
    $('#replyBar')?.classList.add('hidden');
  }

  async function sendTextMessage(e) {
    e.preventDefault();
    const input = $('#messageInput');
    const text = input.value.trim();
    if (!text || !state.currentFriend) return;
    const message = {
      id: crypto.randomUUID(), type: 'text', text, ts: Date.now(), mine: true,
      sent: false, replyText: ''
    };
    ensureChat(state.currentFriend.code).push(message);
    saveDB();
    input.value = '';
    clearReply();
    renderMessages();
    renderChatList();
    await flushOutbox(state.currentFriend.code);
    if (!message.sent) toast('บันทึกข้อความไว้แล้ว จะส่งอัตโนมัติเมื่อเพื่อนเชื่อมต่อ');
  }

  async function onImageSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !state.currentFriend) return;
    const data = await compressImage(file);
    if (data.length > MAX_IMAGE_BYTES * 1.4) return toast('รูปใหญ่เกินไป กรุณาเลือกรูปที่เล็กลง');
    const message = { id: crypto.randomUUID(), type: 'image', data, ts: Date.now(), mine: true, sent: false };
    ensureChat(state.currentFriend.code).push(message);
    saveDB();
    renderMessages();
    renderChatList();
    await flushOutbox(state.currentFriend.code);
    if (!message.sent) toast('บันทึกรูปไว้แล้ว จะส่งอัตโนมัติเมื่อเพื่อนเชื่อมต่อ');
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 1200;
          const ratio = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * ratio));
          canvas.height = Math.max(1, Math.round(img.height * ratio));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', .68));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function isConnected(code) {
    return !!state.connections.get(code)?.open;
  }

  function profilePacket() {
    const account = state.db.account;
    return { code: account.code, name: account.name, username: account.username, avatar: account.avatar || '' };
  }

  function connectFriend(friend, opts = {}) {
    const { notify = false } = opts;
    if (!state.peer || state.peer.destroyed || !friend?.code || friend.code === state.db.account.code) return Promise.resolve(null);
    if (isConnected(friend.code)) {
      friend.online = true;
      updateConversationStatus();
      void flushOutbox(friend.code);
      return Promise.resolve(state.connections.get(friend.code));
    }
    const existingPending = state.pending.get(friend.code);
    if (existingPending) return existingPending;

    let resolvePending;
    let rejectPending;
    const promise = new Promise((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    state.pending.set(friend.code, promise);

    let settled = false;
    let conn;
    try {
      conn = state.peer.connect(friend.code, {
        reliable: true,
        serialization: 'json',
        metadata: profilePacket()
      });
    } catch {
      state.pending.delete(friend.code);
      rejectPending(null);
      scheduleRetry(friend.code);
      return promise;
    }

    attachConnection(conn, friend.code, {
      incoming: false,
      onOpen: () => {
        settled = true;
        state.pending.delete(friend.code);
        if (notify) toast(`เชื่อมต่อกับ ${friend.name} แล้ว`);
        resolvePending(conn);
      },
      onFail: () => {
        state.pending.delete(friend.code);
        if (!settled) { settled = true; resolvePending(null); }
        scheduleRetry(friend.code);
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        state.pending.delete(friend.code);
        scheduleRetry(friend.code);
        resolvePending(isConnected(friend.code) ? state.connections.get(friend.code) : null);
      }
    }, 6500);

    return promise;
  }

  function attachConnection(conn, code, { incoming = false, onOpen, onFail } = {}) {
    if (!conn) return;

    const existing = state.connections.get(code);
    if (existing && existing !== conn && existing.open) {
      try { conn.close(); } catch {}
      return;
    }

    if (!state.connections.has(code) || !state.connections.get(code)?.open) {
      state.connections.set(code, conn);
    }

    conn.on('open', async () => {
      const current = state.connections.get(code);
      if (current && current !== conn && current.open) {
        try { conn.close(); } catch {}
        return;
      }
      state.connections.set(code, conn);
      const friend = upsertFriend({ code });
      if (friend) friend.online = true;
      const packet = { t: 'hello', p: profilePacket(), recent: ensureChat(code).slice(-50) };
      try { conn.send(packet); } catch {}
      await flushOutbox(code);
      updatePresence();
      updateConversationStatus();
      onOpen?.();
      void incoming;
    });

    conn.on('data', data => handleData(code, data));
    conn.on('close', () => {
      if (state.connections.get(code) === conn) state.connections.delete(code);
      const friend = findFriend(code);
      if (friend) friend.online = false;
      updatePresence();
      updateConversationStatus();
      scheduleRetry(code);
    });
    conn.on('error', () => {
      if (state.connections.get(code) === conn) state.connections.delete(code);
      onFail?.();
      updatePresence();
    });
  }

  function handleData(code, data) {
    if (!data) return;
    if (data.t === 'hello') {
      const friend = upsertFriend(data.p);
      if (friend) friend.online = true;
      if (Array.isArray(data.recent)) mergeMessages(code, data.recent);
      const conn = state.connections.get(code);
      if (conn?.open) {
        try { conn.send({ t: 'sync', messages: ensureChat(code).slice(-50) }); } catch {}
      }
      renderChatList();
      renderMessages();
      updateConversationStatus();
      return;
    }

    if (data.t === 'sync') {
      if (Array.isArray(data.messages)) mergeMessages(code, data.messages);
      return;
    }

    if (data.t === 'message' && data.m?.id) {
      const list = ensureChat(code);
      if (!list.some(m => m.id === data.m.id)) {
        list.push({ ...data.m, mine: false, sent: true });
        list.sort((a, b) => a.ts - b.ts);
        saveDB();
      }
      const active = state.currentFriend?.code === code;
      renderChatList();
      if (active) renderMessages();
      if (!active || document.hidden) {
        const friend = findFriend(code);
        showExternalNotification(friend?.name || code, data.m.type === 'image' ? 'ส่งรูปภาพ' : data.m.text || 'ข้อความใหม่');
      }
      return;
    }

    if (data.t === 'ack' && data.id) {
      const message = ensureChat(code).find(m => m.id === data.id);
      if (message) {
        message.sent = true;
        saveDB();
        if (state.currentFriend?.code === code) renderMessages();
        renderChatList();
      }
      return;
    }

    if (data.t === 'profile' && data.p) {
      upsertFriend(data.p);
    }
  }

  function mergeMessages(code, incoming) {
    const local = ensureChat(code);
    let changed = false;
    for (const item of incoming) {
      if (!item?.id || local.some(existing => existing.id === item.id)) continue;
      local.push({ ...item, mine: item.mine === true && item.sent === true });
      changed = true;
    }
    if (changed) {
      local.sort((a, b) => a.ts - b.ts);
      saveDB();
      if (state.currentFriend?.code === code) renderMessages();
      renderChatList();
    }
  }

  async function flushOutbox(code) {
    const conn = state.connections.get(code);
    if (!conn?.open) return false;
    const pending = ensureChat(code).filter(m => m.mine && m.sent === false);
    for (const message of pending) {
      try {
        conn.send({ t: 'message', m: { ...message, mine: false, sent: true } });
        message.sent = true;
        conn.send({ t: 'ack', id: message.id });
      } catch {
        break;
      }
    }
    saveDB();
    if (state.currentFriend?.code === code) renderMessages();
    return true;
  }

  function scheduleRetry(code) {
    const friend = findFriend(code);
    if (!friend || state.retryTimers.has(code)) return;
    let attempt = friend.retryAttempt || 0;
    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    friend.retryAttempt = Math.min(attempt + 1, RETRY_DELAYS.length - 1);
    saveDB();
    const timer = setTimeout(async () => {
      state.retryTimers.delete(code);
      const f = findFriend(code);
      if (!f) return;
      await connectFriend(f, { notify: false });
      if (!isConnected(code)) scheduleRetry(code);
      else { f.retryAttempt = 0; saveDB(); }
    }, delay);
    state.retryTimers.set(code, timer);
  }

  function updatePresence() {
    const connected = !!state.peer?.open;
    const count = [...state.connections.values()].filter(c => c?.open).length;
    const status = $('#connectionStatus');
    if (status) {
      status.classList.toggle('online', connected);
      const span = $('span', status);
      if (span) span.textContent = connected ? `${count ? count + ' คน · ' : ''}พร้อมใช้งาน` : 'กำลังเชื่อมต่อ…';
    }
    renderChatList();
    renderFriends();
    updateConversationStatus();
  }

  async function bootPeerApp(force = false) {
    if (!state.db.account || typeof Peer === 'undefined') return;
    if (state.peer && !force) return;
    try { state.peer?.destroy(); } catch {}

    const id = state.db.account.code;
    state.peer = new Peer(id, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        sdpSemantics: 'unified-plan'
      }
    });

    state.peer.on('open', peerId => {
      if (peerId !== state.db.account.code) return;
      updatePresence();
      for (const friend of state.db.friends) connectFriend(friend, { notify: false });
      toast('พร้อมใช้งาน');
    });

    state.peer.on('connection', conn => {
      const code = conn.peer;
      const existing = state.connections.get(code);
      if (existing?.open) {
        try { conn.close(); } catch {}
        return;
      }
      attachConnection(conn, code, { incoming: true });
    });

    state.peer.on('call', handleIncomingCall);

    state.peer.on('disconnected', () => {
      updatePresence();
      setTimeout(() => { if (state.peer?.disconnected) state.peer.reconnect(); }, 900);
    });

    state.peer.on('error', err => {
      if (err.type === 'unavailable-id') {
        toast('รหัส LINKA นี้กำลังถูกใช้งานจากอีกเครื่อง');
      } else if (err.type === 'peer-unavailable') {
        updatePresence();
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        toast('การเชื่อมต่อเซิร์ฟเวอร์มีปัญหา กำลังลองใหม่');
      }
      updatePresence();
    });
  }

  function openAddFriendModal() {
    const root = $('#modalRoot');
    root.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal small-modal">
          <div class="modal-header">
            <div><div class="modal-kicker">CONTACT</div><h3>เพิ่มเพื่อน</h3></div>
            <button class="icon-btn" data-close aria-label="ปิด"><i class="ti ti-x"></i></button>
          </div>
          <div class="modal-body">
            <p class="modal-intro">กรอกรหัส LINKA ของอีกฝ่ายเพื่อเริ่มการติดต่อ</p>
            <label class="form-stack">
              <span>รหัส LINKA</span>
              <input id="friendCodeInput" class="code-input" inputmode="text" maxlength="6" autocomplete="off" placeholder="เช่น A7K2XM">
            </label>
            <div class="helper-line"><i class="ti ti-info-circle"></i><span>เมื่ออีกฝ่ายเปิด LINKA ระบบจะเชื่อมต่อให้อัตโนมัติ</span></div>
          </div>
          <div class="modal-actions">
            <button class="btn ghost" data-close>ยกเลิก</button>
            <button class="btn primary" id="confirmAddFriend"><i class="ti ti-user-plus"></i> เพิ่มเพื่อน</button>
          </div>
        </div>
      </div>`;

    $$('[data-close]', root).forEach(btn => btn.onclick = () => root.innerHTML = '');
    $('#confirmAddFriend').onclick = async () => {
      const code = $('#friendCodeInput').value.trim().toUpperCase();
      if (!/^[A-Z2-9]{5,6}$/.test(code)) return toast('รหัสต้องมี 5–6 ตัวอักษรหรือตัวเลข');
      if (code === state.db.account.code) return toast('นี่คือรหัสของคุณเอง');
      const friend = upsertFriend({ code, name: code, username: '', avatar: '' });
      root.innerHTML = '';
      navigate('chats');
      openConversation(friend.code);
      await connectFriend(friend, { notify: true });
      if (!isConnected(friend.code)) toast('เพิ่มเพื่อนแล้ว · จะเชื่อมต่ออัตโนมัติเมื่ออีกฝ่ายออนไลน์');
    };
    $('#friendCodeInput')?.focus();
    refreshIcons();
  }

  async function startCall(type) {
    const friend = state.currentFriend;
    if (!friend) return;
    if (!isConnected(friend.code)) await connectFriend(friend, { notify: false });
    if (!isConnected(friend.code)) return toast('อีกฝ่ายยังไม่พร้อมสำหรับการโทร');

    try {
      const stream = await navigator.mediaDevices.getUserMedia(
        type === 'video' ? { audio: true, video: { facingMode: 'user' } } : { audio: true, video: false }
      );
      state.localStream = stream;
      state.callType = type;
      const call = state.peer.call(friend.code, stream, {
        metadata: { type, name: state.db.account.name, avatar: state.db.account.avatar || '' }
      });
      state.activeCall = call;
      showCallStage('outgoing', friend, call, type);
      bindMediaCall(call, type, friend);
    } catch {
      toast('เปิดไมโครโฟนหรือกล้องไม่ได้');
    }
  }

  function handleIncomingCall(call) {
    const friend = findFriend(call.peer) || { code: call.peer, name: call.peer, avatar: '' };
    state.incomingCall = call;
    state.callType = call.metadata?.type || 'voice';
    showCallStage('incoming', friend, call, state.callType);
    showExternalNotification(friend.name, state.callType === 'video' ? 'วิดีโอคอลเข้า' : 'สายเสียงเข้า');
  }

  function bindMediaCall(call, type) {
    call.on('stream', remote => {
      const video = $('#remoteVideo');
      if (video) {
        video.srcObject = remote;
        video.play?.().catch(() => {});
      }
    });
    call.on('close', cleanupCall);
    call.on('error', () => {
      toast('การโทรขัดข้อง');
      cleanupCall();
    });
    $('#localVideo') && ($('#localVideo').srcObject = state.localStream);
  }

  function callMarkup(friend, type) {
    return `
      <div class="call-stage">
        <video id="remoteVideo" class="remote-video ${type === 'voice' ? 'voice-mode' : ''}" playsinline autoplay></video>
        <video id="localVideo" class="local-video ${type === 'voice' ? 'hidden' : ''}" playsinline autoplay muted></video>
        <div class="call-topbar"><div><strong>${esc(friend.name)}</strong><span>${type === 'video' ? 'วิดีโอคอล' : 'เสียงเรียกเข้า'}</span></div><span class="call-live">● LIVE</span></div>
        <div class="call-actions">
          <button class="round-btn" id="toggleMute" aria-label="ปิดไมค์"><i class="ti ti-microphone"></i></button>
          ${type === 'video' ? '<button class="round-btn" id="toggleCamera" aria-label="ปิดกล้อง"><i class="ti ti-video"></i></button>' : ''}
          <button class="round-btn end" id="endCall" aria-label="วางสาย"><i class="ti ti-phone-off"></i></button>
        </div>
      </div>`;
  }

  function showCallStage(mode, friend, call, type) {
    const root = $('#modalRoot');
    const incoming = mode === 'incoming';
    root.innerHTML = `<div class="modal-backdrop"><div class="modal call-modal">${incoming ? `
      <div class="incoming-stage">
        <div class="incoming-avatar" id="incomingAvatar">L</div>
        <div class="modal-kicker">INCOMING CALL</div>
        <h3>${esc(friend.name)}</h3>
        <p>${type === 'video' ? 'ต้องการวิดีโอคอลกับคุณ' : 'กำลังโทรหาคุณ'}</p>
        <div class="incoming-actions">
          <button class="round-btn decline" id="rejectCall" aria-label="ปฏิเสธ"><i class="ti ti-phone-off"></i></button>
          <button class="round-btn accept" id="answerCall" aria-label="รับสาย"><i class="ti ti-phone"></i></button>
        </div>
      </div>` : callMarkup(friend, type)}</div></div>`;

    if (incoming) {
      setAvatar($('#incomingAvatar'), friend.avatar, friend.name);
      $('#rejectCall').onclick = () => { call.close(); cleanupCall(); };
      $('#answerCall').onclick = async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(
            type === 'video' ? { audio: true, video: { facingMode: 'user' } } : { audio: true, video: false }
          );
          state.localStream = stream;
          state.activeCall = call;
          call.answer(stream);
          $('#modalRoot').querySelector('.modal').innerHTML = callMarkup(friend, type);
          bindMediaCall(call, type, friend);
          bindCallControls(call, type);
          refreshIcons();
        } catch {
          toast('เปิดไมโครโฟนหรือกล้องไม่ได้');
          cleanupCall();
        }
      };
    } else {
      bindCallControls(call, type);
      refreshIcons();
    }
    refreshIcons();
  }

  function bindCallControls(call, type) {
    $('#endCall')?.addEventListener('click', () => { call.close(); cleanupCall(); });
    $('#toggleMute')?.addEventListener('click', () => {
      const track = state.localStream?.getAudioTracks?.()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      $('#toggleMute').innerHTML = `<i class="ti ti-${track.enabled ? 'microphone' : 'microphone-off'}"></i>`;
      refreshIcons();
    });
    $('#toggleCamera')?.addEventListener('click', () => {
      const track = state.localStream?.getVideoTracks?.()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      $('#toggleCamera').innerHTML = `<i class="ti ti-${track.enabled ? 'video' : 'video-off'}"></i>`;
      refreshIcons();
    });
  }

  function cleanupCall() {
    try { state.activeCall?.close?.(); } catch {}
    try { state.incomingCall?.close?.(); } catch {}
    state.activeCall = null;
    state.incomingCall = null;
    state.localStream?.getTracks?.().forEach(track => track.stop());
    state.localStream = null;
    $('#modalRoot').innerHTML = '';
  }

  async function copyMyCode() {
    try {
      await navigator.clipboard.writeText(state.db.account.code);
      toast('คัดลอกรหัสแล้ว');
    } catch {
      toast('คัดลอกไม่ได้ในเบราว์เซอร์นี้');
    }
  }

  async function shareMyCode() {
    const text = `เพิ่มฉันใน LINKA ด้วยรหัส ${state.db.account.code}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'LINKA', text }); } catch {}
    } else {
      await copyMyCode();
    }
  }

  async function requestNotifications() {
    if (!('Notification' in window)) return toast('เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน');
    const permission = await Notification.requestPermission();
    state.db.settings.notifications = permission === 'granted';
    saveDB();
    updateNotificationStatus();
    toast(permission === 'granted' ? 'เปิดการแจ้งเตือนแล้ว' : 'ไม่ได้อนุญาตการแจ้งเตือน');
  }

  function updateNotificationStatus() {
    const el = $('#notificationStatus');
    if (!el) return;
    if (!('Notification' in window)) el.textContent = 'ไม่รองรับ';
    else if (Notification.permission === 'granted') el.textContent = 'เปิดใช้งานแล้ว';
    else if (Notification.permission === 'denied') el.textContent = 'ถูกปฏิเสธ';
    else el.textContent = 'ยังไม่ได้เปิด';
  }

  async function showExternalNotification(title, body) {
    if (!state.db.settings.notifications || Notification.permission !== 'granted') return;
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, {
        body,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: 'linka-message',
        renotify: true
      });
    } catch {}
  }

  async function onAvatarSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const data = await compressImage(file);
    if (data.length > MAX_IMAGE_BYTES) return toast('รูปโปรไฟล์ใหญ่เกินไป');
    state.db.account.avatar = data;
    saveDB();
    renderUser();
    sendProfileToFriends();
  }

  function sendProfileToFriends() {
    for (const conn of state.connections.values()) {
      if (conn?.open) {
        try { conn.send({ t: 'profile', p: profilePacket() }); } catch {}
      }
    }
  }

  function resetAccount() {
    if (!confirm('ลบบัญชีและข้อมูล LINKA จากอุปกรณ์นี้ทั้งหมด?')) return;
    try { state.peer?.destroy(); } catch {}
    localStorage.removeItem(APP_KEY);
    location.reload();
  }

  function openLegal(kind) {
    const title = kind === 'terms' ? 'ข้อตกลงการใช้งาน' : 'นโยบายความเป็นส่วนตัว';
    const body = kind === 'terms' ? `
      <div class="legal-copy">
        <p>LINKA เป็นแอปสื่อสารบนเว็บ การใช้งานหมายถึงคุณตกลงใช้บริการโดยเคารพสิทธิของผู้อื่นและกฎหมายที่ใช้บังคับ</p>
        <h4>การใช้งานที่ยอมรับได้</h4><p>ห้ามใช้บริการเพื่อหลอกลวง คุกคาม ข่มขู่ สแปม ทำลายระบบ หรือส่งเนื้อหาที่ผิดกฎหมาย</p>
        <h4>บัญชีและรหัส LINKA</h4><p>บัญชีรุ่นนี้เก็บไว้ในอุปกรณ์ของผู้ใช้ รหัส LINKA ใช้สำหรับค้นหาและเริ่มการเชื่อมต่อ ไม่ใช่รหัสผ่านหรือหลักฐานยืนยันตัวบุคคล</p>
        <h4>บริการบุคคลที่สาม</h4><p>การเชื่อมต่อแบบ peer-to-peer ใช้ PeerJS/WebRTC และอาจได้รับผลกระทบจากเครือข่าย อุปกรณ์ และบริการภายนอก</p>
        <h4>การยอมรับ</h4><p>การใช้ LINKA ต่อไปหลังจากอ่านข้อตกลงนี้ถือว่าคุณยอมรับข้อกำหนดนี้</p>
      </div>` : `
      <div class="legal-copy">
        <p>LINKA รุ่นนี้ออกแบบให้ข้อมูลบัญชี รายชื่อ และประวัติแชตเก็บอยู่ใน Local Storage ของเบราว์เซอร์เป็นหลัก</p>
        <h4>ข้อมูลบนอุปกรณ์</h4><p>ชื่อผู้ใช้ ชื่อที่แสดง รหัส LINKA รูปโปรไฟล์ รายชื่อเพื่อน และข้อความที่บันทึกไว้ในแอปอาจอยู่บนอุปกรณ์ของคุณ</p>
        <h4>การเชื่อมต่อ</h4><p>ข้อความ เสียง และวิดีโอส่งผ่าน WebRTC หลังการจับคู่โดยบริการ signaling ของ PeerJS ข้อมูลเครือข่ายอาจถูกใช้เพื่อสร้างการเชื่อมต่อ</p>
        <h4>การแจ้งเตือน</h4><p>การแจ้งเตือนทำงานเมื่อคุณอนุญาตผ่านเบราว์เซอร์ และระบบปฏิบัติการอาจแสดงการแจ้งเตือนบนอุปกรณ์</p>
        <h4>การลบข้อมูล</h4><p>การลบบัญชีจากหน้าโปรไฟล์จะลบข้อมูล LINKA ที่เก็บไว้ในอุปกรณ์เครื่องนี้</p>
      </div>`;

    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal"><div class="modal-header"><div><div class="modal-kicker">LINKA</div><h3>${title}</h3></div><button class="icon-btn" data-close aria-label="ปิด"><i class="ti ti-x"></i></button></div><div class="modal-body">${body}</div><div class="modal-actions"><button class="btn secondary" data-close>ปิด</button></div></div></div>`;
    $$('[data-close]', root).forEach(btn => btn.onclick = () => root.innerHTML = '');
    refreshIcons();
  }

  async function installApp() {
    if (!state.deferredInstall) return toast('เปิดเมนูเบราว์เซอร์แล้วเลือก “ติดตั้งแอป” ได้');
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
  }

  function toast(message) {
    const root = $('#toastRoot');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
})();
