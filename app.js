(() => {
  'use strict';

  const APP_KEY = 'linka:v3';
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const MAX_IMAGE_BYTES = 180 * 1024;
  const RETRY_DELAYS = [1500, 4000, 9000, 18000];
  const MEDIA_CHUNK_SIZE = 12000;
  const MAX_ATTACHMENT_BYTES = 900 * 1024;
  const MAX_VOICE_SECONDS = 60;
  const LEGAL_VERSION = '1.1';

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
    callType: 'voice',
    recording: null,
    mediaIncoming: new Map()
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
    $('#attachBtn')?.addEventListener('click', () => $('#fileInput')?.click());
    $('#fileInput')?.addEventListener('change', onFileSelected);
    $('#voiceMessageBtn')?.addEventListener('click', toggleVoiceRecording);
    $('#cancelRecording')?.addEventListener('click', () => stopVoiceRecording(true));
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
    if (!$('#acceptTerms')?.checked) return toast('กรุณายอมรับข้อตกลงการใช้งานและนโยบายความเป็นส่วนตัว');

    state.db.account = {
      name,
      username,
      pinHash: await hash(pin),
      code: generateCode(),
      avatar: '',
      termsVersion: LEGAL_VERSION,
      termsAcceptedAt: Date.now(),
      privacyVersion: LEGAL_VERSION,
      privacyAcceptedAt: Date.now()
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
          <div class="chat-preview">${last ? (last.type === 'image' ? 'รูปภาพ' : last.type === 'audio' ? 'ข้อความเสียง' : last.type === 'file' ? `ไฟล์: ${esc(last.name || 'ไฟล์แนบ')}` : esc(last.text || '')) : 'แตะเพื่อเริ่มสนทนา'} ${statusDot}</div>
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
      } else if (message.type === 'audio') {
        const audio = document.createElement('audio');
        audio.className = 'msg-audio';
        audio.controls = true;
        audio.preload = 'metadata';
        audio.src = message.data;
        bubble.appendChild(audio);
      } else if (message.type === 'file') {
        const link = document.createElement('a');
        link.className = 'msg-file';
        link.href = message.data;
        link.download = message.name || 'ไฟล์';
        link.innerHTML = `<i class=\"ti ti-file-download\"></i><span>${esc(message.name || 'ไฟล์แนบ')}<small>${esc(formatBytes(message.size || 0))}</small></span>`;
        bubble.appendChild(link);
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
    const message = { id: crypto.randomUUID(), type: 'text', text, ts: Date.now(), mine: true, sent: false, replyText: '' };
    ensureChat(state.currentFriend.code).push(message);
    saveDB(); input.value = ''; clearReply(); renderMessages(); renderChatList();
    await flushOutbox(state.currentFriend.code);
    if (!message.sent) toast('ข้อความถูกเก็บไว้และจะส่งทันทีเมื่อเชื่อมต่อ');
  }

  async function onFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !state.currentFriend) return;
    if (file.size > MAX_ATTACHMENT_BYTES) return toast('ไฟล์ใหญ่เกิน 900 KB สำหรับโหมด P2P ฟรี');
    try {
      let dataUrl;
      let type = 'file';
      if (file.type.startsWith('image/')) {
        type = 'image';
        dataUrl = await compressImage(file);
      } else {
        dataUrl = await fileToDataURL(file);
      }
      if (dataUrl.length > MAX_ATTACHMENT_BYTES * 1.8) return toast('ไฟล์หลังเตรียมส่งยังใหญ่เกินไป');
      const message = { id: crypto.randomUUID(), type, data: dataUrl, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, ts: Date.now(), mine: true, sent: false };
      ensureChat(state.currentFriend.code).push(message);
      saveDB(); renderMessages(); renderChatList();
      await flushOutbox(state.currentFriend.code);
      if (!message.sent) toast('กำลังส่งไฟล์…');
    } catch { toast('เตรียมไฟล์ไม่สำเร็จ'); }
  }

  async function toggleVoiceRecording() {
    if (!state.currentFriend) return toast('เลือกเพื่อนก่อนส่งข้อความเสียง');
    if (state.recording) return stopVoiceRecording(false);
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('เบราว์เซอร์นี้ไม่รองรับการบันทึกเสียง');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus'].find(x => MediaRecorder.isTypeSupported(x)) || '';
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined);
      const chunks = [];
      const started = Date.now();
      const timer = setInterval(() => {
        if (!state.recording) return clearInterval(timer);
        const seconds = Math.floor((Date.now() - started) / 1000);
        $('#recordingTimer').textContent = `00:${String(seconds).padStart(2,'0')}`;
        if (seconds >= MAX_VOICE_SECONDS) stopVoiceRecording(false);
      }, 250);
      state.recording = { recorder, stream, chunks, started, timer };
      $('#recordingBar')?.classList.remove('hidden');
      $('#voiceMessageBtn')?.classList.add('recording');
      recorder.ondataavailable = ev => { if (ev.data?.size) chunks.push(ev.data); };
      recorder.onstop = async () => {
        clearInterval(timer); stream.getTracks().forEach(t => t.stop());
        $('#recordingBar')?.classList.add('hidden'); $('#voiceMessageBtn')?.classList.remove('recording');
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        if (!blob.size) return;
        if (blob.size > MAX_ATTACHMENT_BYTES) return toast('ข้อความเสียงยาวเกินไป กรุณาบันทึกใหม่ให้สั้นลง');
        const data = await blobToDataURL(blob);
        const message = { id: crypto.randomUUID(), type: 'audio', data, mime: blob.type, size: blob.size, duration: Math.min(MAX_VOICE_SECONDS, Math.round((Date.now() - started)/1000)), ts: Date.now(), mine: true, sent: false };
        if (!state.currentFriend) return;
        ensureChat(state.currentFriend.code).push(message); saveDB(); renderMessages(); renderChatList();
        await flushOutbox(state.currentFriend.code);
        if (!message.sent) toast('กำลังส่งข้อความเสียง…');
      };
      recorder.start(250);
    } catch { toast('ไม่สามารถเปิดไมโครโฟนได้'); }
  }

  function stopVoiceRecording(cancel = false) {
    const rec = state.recording;
    if (!rec) return;
    state.recording = null;
    clearInterval(rec.timer);
    if (cancel) { try { rec.recorder.onstop = null; rec.recorder.stop(); } catch {} rec.stream.getTracks().forEach(t => t.stop()); $('#recordingBar')?.classList.add('hidden'); $('#voiceMessageBtn')?.classList.remove('recording'); return; }
    try { rec.recorder.stop(); } catch {}
  }

  function fileToDataURL(file) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); }); }
  function blobToDataURL(blob) { return fileToDataURL(blob); }
  function formatBytes(n) { if (!n) return '0 B'; const units=['B','KB','MB']; let i=0,v=n; while(v>=1024&&i<units.length-1){v/=1024;i++;} return `${v.toFixed(v>=10||i===0?0:1)} ${units[i]}`; }

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
      if (conn?.open) { try { conn.send({ t: 'sync', messages: ensureChat(code).slice(-50) }); } catch {} }
      renderChatList(); renderMessages(); updateConversationStatus(); return;
    }
    if (data.t === 'sync') { if (Array.isArray(data.messages)) mergeMessages(code, data.messages); return; }
    if (data.t === 'message' && data.m?.id) {
      receiveMessage(code, data.m); return;
    }
    if (data.t === 'media-start' && data.id) {
      state.mediaIncoming.set(`${code}:${data.id}`, { ...data, chunks: new Array(data.total || 0) }); return;
    }
    if (data.t === 'media-chunk' && data.id) {
      const item = state.mediaIncoming.get(`${code}:${data.id}`); if (!item) return;
      item.chunks[data.i] = data.data; return;
    }
    if (data.t === 'media-end' && data.id) {
      const key = `${code}:${data.id}`; const item = state.mediaIncoming.get(key); if (!item) return;
      const raw = item.chunks.join('');
      const prefix = item.mime ? `data:${item.mime};base64,` : 'data:application/octet-stream;base64,';
      const message = { id: item.id, type: item.kind, data: prefix + raw, name: item.name || '', mime: item.mime || '', size: item.size || 0, ts: Date.now(), mine: false, sent: true };
      state.mediaIncoming.delete(key);
      receiveMessage(code, message, true);
      const conn = state.connections.get(code); if (conn?.open) { try { conn.send({ t: 'ack', id: item.id }); } catch {} }
      return;
    }
    if (data.t === 'ack' && data.id) {
      const message = ensureChat(code).find(m => m.id === data.id);
      if (message) { message.sent = true; saveDB(); if (state.currentFriend?.code === code) renderMessages(); renderChatList(); }
      return;
    }
    if (data.t === 'profile' && data.p) upsertFriend(data.p);
  }

  function receiveMessage(code, message, alreadySaved = false) {
    const list = ensureChat(code);
    if (!list.some(m => m.id === message.id)) {
      if (!alreadySaved) message = { ...message, mine: false, sent: true };
      list.push(message); list.sort((a,b) => a.ts - b.ts); saveDB();
    }
    const active = state.currentFriend?.code === code;
    renderChatList(); if (active) renderMessages();
    if (!active || document.hidden) {
      const friend = findFriend(code);
      const body = message.type === 'image' ? 'ส่งรูปภาพ' : message.type === 'audio' ? 'ส่งข้อความเสียง' : message.type === 'file' ? `ส่งไฟล์ ${message.name || ''}` : (message.text || 'ข้อความใหม่');
      showExternalNotification(friend?.name || code, body);
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
    const pending = ensureChat(code).filter(m => m.mine && m.sent === false && !m._sending);
    for (const message of pending) {
      message._sending = true;
      try {
        if (message.type === 'text') {
          conn.send({ t: 'message', m: { ...message, mine: false, sent: true } });
          conn.send({ t: 'ack', id: message.id });
          message.sent = true;
        } else {
          await sendMediaMessage(conn, message);
        }
      } catch {
        // Keep message unsent; retry later without taking down the connection.
      } finally {
        delete message._sending;
      }
      if (!conn.open) break;
      await delay(0);
    }
    saveDB();
    if (state.currentFriend?.code === code) renderMessages();
    return true;
  }

  async function sendMediaMessage(conn, message) {
    const comma = message.data.indexOf(',');
    const raw = comma >= 0 ? message.data.slice(comma + 1) : message.data;
    const total = Math.ceil(raw.length / MEDIA_CHUNK_SIZE);
    conn.send({ t: 'media-start', id: message.id, kind: message.type, mime: message.mime || '', name: message.name || '', size: message.size || 0, total });
    for (let i = 0; i < total; i++) {
      conn.send({ t: 'media-chunk', id: message.id, i, data: raw.slice(i * MEDIA_CHUNK_SIZE, (i + 1) * MEDIA_CHUNK_SIZE) });
      await delay(6);
      if (!conn.open) throw new Error('connection closed');
    }
    conn.send({ t: 'media-end', id: message.id });
  }

  function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
    const title = kind === 'terms' ? 'ข้อตกลงการใช้งาน LINKA' : 'นโยบายความเป็นส่วนตัว LINKA';
    const body = kind === 'terms' ? termsHtml() : privacyHtml();
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal legal-modal"><div class="modal-header"><div><div class="modal-kicker">LINKA · ฉบับ ${LEGAL_VERSION}</div><h3>${title}</h3></div><button class="icon-btn" data-close aria-label="ปิด"><i class="ti ti-x"></i></button></div><div class="modal-body legal-body">${body}</div><div class="modal-actions"><button class="btn secondary" data-close>ปิด</button></div></div></div>`;
    $$('[data-close]', root).forEach(btn => btn.onclick = () => root.innerHTML = '');
    refreshIcons();
  }

  function termsHtml() {
    return `<p><strong>มีผลตั้งแต่ 8 ตุลาคม 2569</strong></p>
      <p>เอกสารฉบับนี้กำหนดสิทธิ หน้าที่ และเงื่อนไขระหว่างผู้ให้บริการ LINKA (“ผู้ให้บริการ”) กับผู้ใช้งาน (“ผู้ใช้”) สำหรับการใช้เว็บไซต์และแอปพลิเคชัน LINKA ซึ่งให้บริการสื่อสารแบบเพียร์ทูเพียร์ บริการแชต การส่งข้อความ รูปภาพ ไฟล์ ข้อความเสียง การโทรเสียง และวิดีโอคอล ทั้งนี้ เอกสารนี้จัดทำขึ้นโดยคำนึงถึงกฎหมายไทยที่เกี่ยวข้อง เช่น กฎหมายว่าด้วยธุรกรรมทางอิเล็กทรอนิกส์ กฎหมายคุ้มครองผู้บริโภค กฎหมายคุ้มครองข้อมูลส่วนบุคคล กฎหมายว่าด้วยการกระทำความผิดเกี่ยวกับคอมพิวเตอร์ และกฎหมายทรัพย์สินทางปัญญาที่ใช้บังคับในแต่ละกรณี</p>
      ${legalSection('1. คำนิยาม', '<p>“บริการ” หมายถึงซอฟต์แวร์ เว็บไซต์ แอปแบบติดตั้ง และฟังก์ชันที่เกี่ยวข้องทั้งหมดของ LINKA; “บัญชี” หมายถึงข้อมูลโปรไฟล์ที่สร้างและเก็บไว้ในอุปกรณ์ของผู้ใช้; “รหัส LINKA” หมายถึงรหัสสำหรับเริ่มต้นการเชื่อมต่อกับผู้ใช้อื่น; “เนื้อหา” หมายถึงข้อความ รูปภาพ ไฟล์ เสียง วิดีโอ ชื่อผู้ใช้ รูปโปรไฟล์ และข้อมูลอื่นที่ผู้ใช้ส่งหรือจัดเก็บผ่านบริการ; “การเชื่อมต่อ P2P” หมายถึงการสื่อสารที่ข้อมูลสื่ออาจถูกส่งระหว่างอุปกรณ์ของคู่สนทนาโดยอาศัย WebRTC/PeerJS และโครงสร้างเครือข่ายที่เกี่ยวข้อง')}
      ${legalSection('2. การยอมรับข้อตกลง', '<p>การสร้างบัญชี การกดใช้งานบริการ หรือการใช้บริการต่อหลังจากได้รับทราบข้อตกลง ถือว่าผู้ใช้ได้อ่านและยอมรับข้อตกลงนี้ในขอบเขตที่กฎหมายอนุญาต หากไม่ยอมรับข้อกำหนด ผู้ใช้ต้องหยุดใช้บริการและลบข้อมูลที่จัดเก็บไว้ในอุปกรณ์</p><p>การยอมรับทางอิเล็กทรอนิกส์ของผู้ใช้ไม่ทำให้เอกสารหรือการตกลงสูญเสียผลเพียงเพราะอยู่ในรูปอิเล็กทรอนิกส์ โดยกฎหมายธุรกรรมทางอิเล็กทรอนิกส์รับรองสถานะของข้อมูลอิเล็กทรอนิกส์และการเก็บรักษาที่เข้าถึงและนำกลับมาใช้ได้โดยความหมายไม่เปลี่ยนแปลง</p>')}
      ${legalSection('3. คุณสมบัติและความสามารถในการเข้าทำข้อตกลง', '<p>ผู้ใช้ต้องมีความสามารถตามกฎหมายในการเข้าทำข้อตกลง หรือใช้บริการโดยมีความยินยอม/การดำเนินการของผู้แทนโดยชอบด้วยกฎหมายในกรณีที่กฎหมายกำหนด ห้ามผู้ใช้แอบอ้างเป็นบุคคลอื่น ใช้บัญชีของบุคคลอื่นโดยไม่ได้รับอนุญาต หรือใช้ข้อมูลที่ทำให้บุคคลอื่นเข้าใจผิดอย่างมีนัยสำคัญ</p>')}
      ${legalSection('4. การสร้างและดูแลบัญชี', '<p>ข้อมูลบัญชีรุ่นนี้ถูกจัดเก็บใน Local Storage ของเบราว์เซอร์เป็นหลัก รหัส LINKA มีหน้าที่เป็นตัวระบุสำหรับการเริ่มเชื่อมต่อ ไม่ใช่รหัสผ่าน ไม่ใช่บัตรประชาชน ไม่ใช่หลักฐานยืนยันตัวบุคคล และไม่ควรนำไปใช้เพื่อยืนยันตัวตนในกิจกรรมที่มีความเสี่ยง</p><p>ผู้ใช้มีหน้าที่รักษารหัสผ่าน อุปกรณ์ และช่องทางเข้าถึงบัญชี หากบุคคลอื่นเข้าถึงอุปกรณ์ที่มีข้อมูลบัญชีอยู่ ผู้ให้บริการไม่อาจรับประกันว่าจะป้องกันการเข้าถึงข้อมูลในเครื่องนั้นได้ ผู้ใช้ควรล็อกเครื่องและใช้มาตรการรักษาความปลอดภัยของระบบปฏิบัติการ</p>')}
      ${legalSection('5. การสื่อสารและความปลอดภัยของการเชื่อมต่อ', '<p>LINKA ใช้ WebRTC และ PeerJS ในการทำการเชื่อมต่อ การส่งข้อความและสื่ออาจต้องผ่านระบบ signaling เพื่อค้นหาคู่เชื่อมต่อก่อน หลังจากนั้นการส่งสื่ออาจเป็นการสื่อสารระหว่างอุปกรณ์โดยตรงหรือผ่านโครงสร้างเครือข่ายที่จำเป็น ผู้ให้บริการไม่รับประกันว่าการเชื่อมต่อจะสำเร็จในทุกเครือข่าย เนื่องจาก NAT ไฟร์วอลล์ เครือข่ายองค์กร การตั้งค่าเบราว์เซอร์ อุปกรณ์ หรือบริการภายนอก</p><p>ผู้ใช้รับทราบว่าข้อความหรือสื่อที่ผู้ใช้ส่งให้ผู้ติดต่อเป็นการส่งข้อมูลไปยังอุปกรณ์ของบุคคลอื่น ผู้ให้บริการจึงไม่อาจรับรองการจัดเก็บ การลบ หรือการคุ้มครองข้อมูลหลังจากข้อมูลเข้าสู่การควบคุมของผู้รับได้</p>')}
      ${legalSection('6. เนื้อหาที่ห้ามใช้บริการเพื่อเผยแพร่', '<p>ห้ามใช้บริการเพื่อกระทำหรือสนับสนุนการกระทำที่ผิดกฎหมาย รวมถึงการฉ้อโกง การปลอมแปลงตัวตน การข่มขู่ คุกคาม การสะกดรอย การละเมิดความเป็นส่วนตัว การเผยแพร่ข้อมูลส่วนบุคคลของผู้อื่นโดยไม่มีสิทธิ การเผยแพร่สื่อทางเพศที่ผิดกฎหมายหรือสื่อที่เกี่ยวข้องกับเด็ก การเผยแพร่เนื้อหาที่ละเมิดลิขสิทธิ์ เครื่องหมายการค้า หรือทรัพย์สินทางปัญญาของบุคคลอื่น การหลอกลวง การสแปม การส่งมัลแวร์หรือโค้ดอันตราย การโจมตีหรือรบกวนระบบ และการใช้บริการเพื่อการกระทำที่กฎหมายห้าม</p><p>ผู้ใช้ต้องไม่ใช้บริการเพื่อจัดเตรียมคำสั่งหรือข้อมูลที่มุ่งหมายให้บุคคลอื่นนำไปกระทำความผิดหรือหลบเลี่ยงการบังคับใช้กฎหมาย</p>')}
      ${legalSection('7. สิทธิในเนื้อหาและใบอนุญาตที่จำเป็นต่อการให้บริการ', '<p>ผู้ใช้ยังคงเป็นเจ้าของสิทธิในเนื้อหาที่ผู้ใช้มีสิทธิโดยชอบอยู่เดิม ผู้ใช้รับรองว่าตนมีสิทธิที่จำเป็นในการส่ง เผยแพร่ หรือแบ่งปันเนื้อหานั้น และไม่ละเมิดสิทธิของผู้อื่น</p><p>ในส่วนที่จำเป็นต่อการทำงานของ LINKA ผู้ใช้อนุญาตให้ระบบทำสำเนาชั่วคราว ประมวลผล แปลงรูปแบบ ส่งต่อ และจัดเก็บเนื้อหาบนอุปกรณ์ เพื่อให้สามารถส่งข้อความ แสดงผล ดาวน์โหลด หรือสื่อสารตามคำสั่งของผู้ใช้ได้ การอนุญาตนี้จำกัดเฉพาะวัตถุประสงค์ดังกล่าวและไม่ทำให้ผู้ให้บริการกลายเป็นเจ้าของเนื้อหาของผู้ใช้</p>')}
      ${legalSection('8. การแจ้งเบาะแสและการดำเนินการต่อเนื้อหาที่ผิดกฎหมาย', '<p>เมื่อมีรายงานที่น่าเชื่อถือเกี่ยวกับการใช้งานที่ผิดกฎหมายหรือเสี่ยงต่อความปลอดภัย ผู้ให้บริการอาจดำเนินมาตรการที่เหมาะสมตามความสามารถทางเทคนิคและข้อกฎหมาย เช่น ระงับบัญชีบนอุปกรณ์ที่ผู้ให้บริการควบคุม การปิดช่องทางการเชื่อมต่อที่จำเป็น การปรับปรุงระบบ หรือให้ความร่วมมือกับเจ้าหน้าที่รัฐเมื่อมีหน้าที่ตามกฎหมาย</p><p>เนื่องจาก LINKA รุ่นนี้มีการประมวลผลข้อมูลภายในเครื่องและใช้การสื่อสารแบบ P2P ความสามารถในการตรวจสอบ ลบ หรือเรียกคืนเนื้อหาที่อยู่ในอุปกรณ์ของผู้ใช้หรือผู้รับอาจมีข้อจำกัด</p>')}
      ${legalSection('9. การโทร เสียง และวิดีโอ', '<p>การโทรจำเป็นต้องได้รับสิทธิ์ไมโครโฟน/กล้องจากระบบปฏิบัติการหรือเบราว์เซอร์ ผู้ใช้ต้องไม่บันทึกหรือเผยแพร่เสียง/ภาพของบุคคลอื่นในลักษณะที่ละเมิดสิทธิหรือฝ่าฝืนกฎหมายที่ใช้บังคับ การบันทึกเสียงหรือภาพโดยผู้ใช้เองอยู่นอกการควบคุมของ LINKA และผู้ใช้ต้องรับผิดชอบต่อการปฏิบัติตามกฎหมายที่เกี่ยวข้อง</p>')}
      ${legalSection('10. ไฟล์ รูปภาพ และข้อความเสียง', '<p>เพื่อให้การส่งผ่าน P2P ทำงานได้ LINKA รุ่นนี้จำกัดขนาดสื่อที่ส่งต่อในระดับหนึ่ง และระบบอาจบีบอัดรูปภาพ เปลี่ยนรูปแบบเสียง หรือแบ่งสื่อออกเป็นส่วนย่อยก่อนส่ง คุณไม่ควรใช้บริการนี้เป็นพื้นที่สำรองข้อมูลหลักสำหรับไฟล์สำคัญ</p><p>ผู้ใช้มีหน้าที่ตรวจสอบไฟล์ก่อนเปิด ดาวน์โหลด หรือส่งต่อ และควรใช้ซอฟต์แวร์ความปลอดภัยที่เหมาะสมกับอุปกรณ์ของตน</p>')}
      ${legalSection('11. บริการของบุคคลภายนอก', '<p>LINKA อาจพึ่งพาบริการภายนอก เช่น PeerJS Cloud, WebRTC infrastructure, CDN สำหรับไลบรารี และบริการโฮสต์เว็บไซต์ บริการภายนอกเหล่านี้มีข้อกำหนดและนโยบายของตนเอง ผู้ใช้ยอมรับว่าการหยุดให้บริการ การเปลี่ยนนโยบาย หรือข้อจำกัดของบริการภายนอกอาจทำให้ LINKA บางฟังก์ชันใช้งานไม่ได้</p>')}
      ${legalSection('12. ความพร้อมใช้งานและการบำรุงรักษา', '<p>บริการให้ตามสภาพที่มีอยู่และอาจมีการแก้ไข ปรับปรุง หยุดชั่วคราว หรือยุติบางฟังก์ชันโดยไม่สามารถรับประกันความพร้อมใช้งานตลอดเวลาได้ ผู้ให้บริการจะใช้ความพยายามตามสมควรเพื่อรักษาการทำงาน แต่ไม่รับประกันว่าจะปราศจากข้อผิดพลาดหรือเหมาะสมกับทุกอุปกรณ์และทุกเครือข่าย</p>')}
      ${legalSection('13. การลบบัญชีและการยุติการใช้งาน', '<p>ผู้ใช้สามารถลบบัญชีและข้อมูลของตนจากอุปกรณ์ผ่านเมนูที่กำหนด การลบดังกล่าวลบข้อมูลที่ LINKA เก็บไว้ในอุปกรณ์นั้น ไม่ได้ลบสำเนาที่ผู้รับอาจมี หรือข้อมูลที่อยู่นอกการควบคุมของแอป</p><p>ผู้ให้บริการอาจจำกัดหรือหยุดการทำงานของส่วนหนึ่งส่วนใดของบริการเมื่อจำเป็นต่อความปลอดภัย การปฏิบัติตามกฎหมาย หรือการป้องกันการใช้งานที่ผิดวัตถุประสงค์เท่าที่กฎหมายอนุญาต</p>')}
      ${legalSection('14. ความรับผิดของผู้ใช้', '<p>ผู้ใช้รับผิดชอบต่อบัญชี การกระทำ เนื้อหา และผลจากการสื่อสารของตนเอง ผู้ใช้ต้องชดใช้ความเสียหายแก่ผู้ให้บริการเท่าที่กฎหมายอนุญาต หากความเสียหายเกิดจากการจงใจหรือประมาทเลินเล่อของผู้ใช้หรือการกระทำที่ฝ่าฝืนข้อตกลงนี้ ทั้งนี้ข้อกำหนดใดที่จำกัดสิทธิของผู้บริโภคตามกฎหมายที่ไม่สามารถสละหรือลดได้ จะไม่ใช้บังคับเกินขอบเขตที่กฎหมายอนุญาต</p>')}
      ${legalSection('15. ความรับผิดของผู้ให้บริการ', '<p>ไม่ว่าในกรณีใด ข้อจำกัดความรับผิดจะตีความภายใต้กฎหมายไทยและไม่ตัดหรือยกเว้นความรับผิดที่กฎหมายกำหนดให้ไม่สามารถยกเว้นได้ โดยเฉพาะกรณีการกระทำโดยจงใจหรือประมาทเลินเล่ออย่างร้ายแรงในกรณีที่กฎหมายกำหนด รวมถึงสิทธิของผู้บริโภคที่กฎหมายให้ความคุ้มครอง</p>')}
      ${legalSection('16. การเปลี่ยนแปลงข้อตกลง', '<p>ผู้ให้บริการอาจปรับปรุงข้อตกลงเพื่อให้สอดคล้องกับการเปลี่ยนแปลงทางเทคนิค บริการ หรือกฎหมาย หากเป็นการเปลี่ยนแปลงที่มีสาระสำคัญ จะพยายามแจ้งให้ทราบผ่านช่องทางที่เหมาะสม ผู้ใช้ที่ไม่ยอมรับฉบับใหม่สามารถหยุดใช้บริการและลบบัญชีจากอุปกรณ์</p>')}
      ${legalSection('17. กฎหมายที่ใช้บังคับและข้อพิพาท', '<p>ข้อตกลงนี้อยู่ภายใต้กฎหมายไทย เว้นแต่บทบัญญัติบังคับของกฎหมายที่คุ้มครองผู้บริโภคหรือสิทธิของบุคคลจะกำหนดเป็นอย่างอื่น คู่สัญญาควรพยายามแก้ไขข้อพิพาทโดยการติดต่อและเจรจาก่อน และหากไม่สามารถตกลงกันได้ ให้ดำเนินการตามกระบวนการและเขตอำนาจศาลที่กฎหมายกำหนด</p>')}
      ${legalSection('18. ความสมบูรณ์ของข้อตกลง', '<p>หากข้อกำหนดส่วนหนึ่งส่วนใดเป็นโมฆะหรือไม่สามารถบังคับใช้ได้ ให้ตีความหรือปรับใช้เท่าที่กฎหมายอนุญาต โดยไม่กระทบความสมบูรณ์ของส่วนอื่นของข้อตกลง</p>')}
      <p class="legal-note">เอกสารนี้เป็นแบบร่างข้อกำหนดสำหรับผลิตภัณฑ์ LINKA และควรได้รับการตรวจทานโดยผู้เชี่ยวชาญด้านกฎหมายก่อนเปิดให้บริการแก่สาธารณะหรือใช้ในเชิงพาณิชย์</p>`;
  }

  function privacyHtml() {
    return `<p><strong>มีผลตั้งแต่ 8 ตุลาคม 2569</strong></p>
      <p>นโยบายนี้อธิบายวิธีที่ LINKA เก็บ ใช้ เปิดเผย และปกป้องข้อมูลส่วนบุคคล โดยออกแบบให้สอดคล้องกับหลักของพระราชบัญญัติคุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 และกฎหมายที่เกี่ยวข้อง โดยเฉพาะหลักความโปร่งใส วัตถุประสงค์ การเก็บเท่าที่จำเป็น ความมั่นคงปลอดภัย และสิทธิของเจ้าของข้อมูล</p>
      ${legalSection('1. ผู้ควบคุมข้อมูลและขอบเขต', '<p>สำหรับการเปิดให้บริการจริง เจ้าของโครงการต้องระบุชื่อหรือชื่อนิติบุคคลของผู้ควบคุมข้อมูล ที่อยู่หรือช่องทางติดต่อ และช่องทางสำหรับคำขอใช้สิทธิให้ครบถ้วนก่อนเผยแพร่เชิงพาณิชย์ นโยบายฉบับนี้ใช้กับข้อมูลที่ LINKA จัดการผ่านเว็บไซต์และแอป รวมถึงข้อมูลที่เก็บไว้ภายในอุปกรณ์ของผู้ใช้ตามฟังก์ชันที่ผู้ใช้เลือกใช้</p>')}
      ${legalSection('2. ข้อมูลที่อาจถูกเก็บ', '<p>ข้อมูลบัญชี: ชื่อที่แสดง ชื่อผู้ใช้ รหัส LINKA ค่าแฮชรหัสผ่าน รูปโปรไฟล์ และเวลาที่ตอบรับเงื่อนไข; ข้อมูลการติดต่อ: รหัสเพื่อน ชื่อ โปรไฟล์ และข้อมูลสถานะที่ผู้ใช้เลือกให้แสดง; ข้อมูลเนื้อหา: ข้อความ รูปภาพ ไฟล์ และข้อความเสียงที่ผู้ใช้บันทึกในแอป; ข้อมูลทางเทคนิค: ประเภทเบราว์เซอร์ อุปกรณ์ สถานะการเชื่อมต่อ และข้อมูลที่จำเป็นต่อ WebRTC/PeerJS เพื่อให้การเชื่อมต่อเกิดขึ้น; ข้อมูลสิทธิ์: การอนุญาตกล้อง ไมโครโฟน และการแจ้งเตือนตามที่ผู้ใช้ให้ไว้กับระบบปฏิบัติการ/เบราว์เซอร์</p>')}
      ${legalSection('3. แหล่งที่มาของข้อมูล', '<p>ข้อมูลบัญชีและเนื้อหาส่วนใหญ่ได้จากผู้ใช้โดยตรง การเชื่อมต่อ P2P อาจแลกเปลี่ยนข้อมูลโปรไฟล์และข้อมูลเครือข่ายที่จำเป็นระหว่างคู่สนทนา การทำงานของ PeerJS/WebRTC อาจทำให้บริการภายนอกประมวลผลข้อมูลทางเทคนิคเพื่อจัดการการเชื่อมต่อ</p>')}
      ${legalSection('4. วัตถุประสงค์การใช้ข้อมูล', '<p>ใช้เพื่อสร้างและแสดงบัญชี จัดการรายชื่อเพื่อน เปิดการแชต ส่งข้อความ ส่งสื่อ โทรเสียงและวิดีโอ แสดงการแจ้งเตือน รักษาความปลอดภัย ป้องกันการใช้งานผิดวัตถุประสงค์ แก้ปัญหาทางเทคนิค และปฏิบัติตามหน้าที่ทางกฎหมายเมื่อจำเป็น</p>')}
      ${legalSection('5. ฐานทางกฎหมาย', '<p>ฐานการประมวลผลจะขึ้นอยู่กับกิจกรรม เช่น ความจำเป็นเพื่อทำสัญญาหรือให้บริการที่ผู้ใช้ร้องขอ การปฏิบัติตามกฎหมาย ประโยชน์โดยชอบด้วยกฎหมายที่ชั่งน้ำหนักสิทธิของผู้ใช้แล้ว และความยินยอมในกรณีที่กฎหมายกำหนดให้ต้องขอความยินยอม เช่น กิจกรรมบางประเภทที่ต้องใช้ข้อมูลเพื่อวัตถุประสงค์เฉพาะ</p>')}
      ${legalSection('6. การเก็บข้อมูลไว้ในอุปกรณ์', '<p>บัญชี เพื่อน และประวัติข้อความของรุ่นนี้ถูกเก็บใน Local Storage ของอุปกรณ์เป็นหลัก ผู้ใช้ควรตระหนักว่า Local Storage เป็นพื้นที่ของเบราว์เซอร์ หากล้างข้อมูลเว็บไซต์ ถอนการติดตั้ง รีเซ็ตเบราว์เซอร์ หรือเปลี่ยนอุปกรณ์ ข้อมูลอาจหายได้ และ LINKA อาจไม่สามารถกู้คืนได้</p>')}
      ${legalSection('7. กล้อง ไมโครโฟน และข้อความเสียง', '<p>กล้องและไมโครโฟนจะถูกใช้งานเมื่อผู้ใช้กดฟังก์ชันที่เกี่ยวข้องและให้สิทธิ์แก่อุปกรณ์ ข้อความเสียงจะถูกบันทึกชั่วคราวเพื่อสร้างไฟล์และส่งให้ผู้รับตามคำสั่งของผู้ใช้ ผู้ใช้สามารถปฏิเสธสิทธิ์เหล่านี้ได้ แต่อาจทำให้ฟังก์ชันโทรหรือข้อความเสียงใช้ไม่ได้</p>')}
      ${legalSection('8. การส่งต่อและการเปิดเผยข้อมูล', '<p>ข้อมูลอาจถูกส่งไปยังผู้ติดต่อที่ผู้ใช้เลือก และไปยังผู้ให้บริการโครงสร้างพื้นฐานที่จำเป็นต่อการทำงาน เช่น ผู้ให้บริการ signaling/โครงสร้าง WebRTC หรือ CDN ที่ใช้โหลดไลบรารี ทั้งนี้การเปิดเผยจะจำกัดตามความจำเป็นของการให้บริการและข้อกำหนดของกฎหมาย</p>')}
      ${legalSection('9. การโอนข้อมูลระหว่างประเทศ', '<p>บริการของบุคคลภายนอกอาจอยู่ในประเทศอื่น หากมีการโอนข้อมูลส่วนบุคคลออกนอกประเทศ ผู้ควบคุมข้อมูลต้องดำเนินการตามหลักเกณฑ์ที่กฎหมายคุ้มครองข้อมูลส่วนบุคคลกำหนด เช่น มาตรฐานการคุ้มครองที่เหมาะสม ข้อยกเว้นที่กฎหมายรับรอง หรือความยินยอมที่มีข้อมูลเพียงพอในกรณีที่ใช้เป็นฐาน</p>')}
      ${legalSection('10. ระยะเวลาเก็บรักษา', '<p>ข้อมูลที่เก็บในอุปกรณ์จะคงอยู่จนกว่าผู้ใช้จะลบข้อมูล ล้างข้อมูลเว็บไซต์ หรือจนระบบปฏิบัติการ/เบราว์เซอร์ลบข้อมูล ส่วนข้อมูลที่ผู้ให้บริการภายนอกอาจประมวลผลจะเป็นไปตามระยะเวลาของผู้ให้บริการนั้นและข้อตกลงที่เกี่ยวข้อง เมื่อหมดความจำเป็นควรลบ ทำลาย หรือทำให้ไม่สามารถระบุตัวบุคคลได้ตามที่กฎหมายอนุญาต</p>')}
      ${legalSection('11. มาตรการความมั่นคงปลอดภัย', '<p>LINKA ใช้ HTTPS, WebRTC และกลไกของเบราว์เซอร์เพื่อช่วยปกป้องการส่งข้อมูล แต่ไม่มีระบบใดรับประกันความปลอดภัยได้อย่างสมบูรณ์ ผู้ใช้ควรอัปเดตระบบ ใช้รหัสผ่านที่เหมาะสม ล็อกหน้าจอ และไม่เปิดเผยรหัสหรือข้อมูลสำคัญให้ผู้อื่น</p>')}
      ${legalSection('12. สิทธิของเจ้าของข้อมูล', '<p>ภายใต้เงื่อนไขและข้อยกเว้นของกฎหมาย ผู้ใช้มีสิทธิที่อาจรวมถึงสิทธิขอเข้าถึงข้อมูล แก้ไขข้อมูล ลบหรือทำลายข้อมูล ขอให้ระงับการประมวลผล คัดค้านการประมวลผล ถอนความยินยอมในกรณีที่ใช้ความยินยอมเป็นฐาน และสิทธิในการรับหรือโอนข้อมูลในกรณีที่กฎหมายกำหนด การใช้สิทธิจะขึ้นกับข้อมูลที่ LINKA หรือผู้ประมวลผลมีอยู่จริง</p>')}
      ${legalSection('13. การใช้สิทธิและการลบบัญชี', '<p>สำหรับข้อมูลที่อยู่ในเครื่อง ผู้ใช้สามารถลบได้ทันทีผ่านเมนูบัญชี สำหรับข้อมูลที่ผู้ให้บริการหรือผู้ประมวลผลถือครอง ผู้ใช้สามารถยื่นคำขอผ่านช่องทางติดต่อที่ผู้ให้บริการประกาศ และผู้ให้บริการอาจขอข้อมูลเพื่อยืนยันตัวตนก่อนดำเนินการ</p>')}
      ${legalSection('14. เด็กและผู้เยาว์', '<p>หากการประมวลผลใดต้องอาศัยความยินยอมตามกฎหมายและผู้ใช้เป็นผู้เยาว์ ผู้ให้บริการจะดำเนินการตามเงื่อนไขเกี่ยวกับความยินยอมของผู้ใช้นั้นและผู้ใช้อำนาจปกครองตามที่กฎหมายกำหนด ผู้ปกครองที่พบการใช้บริการของเด็กโดยไม่เหมาะสมควรติดต่อผู้ให้บริการผ่านช่องทางที่ประกาศ</p>')}
      ${legalSection('15. การเปลี่ยนแปลงนโยบาย', '<p>นโยบายอาจถูกปรับปรุงเมื่อกฎหมาย เทคโนโลยี หรือรูปแบบบริการเปลี่ยนแปลง หากการเปลี่ยนแปลงมีสาระสำคัญ ผู้ให้บริการจะพยายามแจ้งให้ทราบผ่านหน้าแอปหรือช่องทางที่เหมาะสม</p>')}
      ${legalSection('16. การติดต่อ', '<p>ในการเปิดให้บริการจริง ควรระบุชื่อผู้ควบคุมข้อมูล ที่อยู่ และอีเมล/ช่องทางรับคำขอใช้สิทธิของเจ้าของข้อมูลในส่วนนี้ให้ชัดเจนก่อนเผยแพร่สู่สาธารณะ</p>')}
      <p class="legal-note">นโยบายนี้เป็นแบบร่างสำหรับผลิตภัณฑ์ LINKA และควรได้รับการตรวจทานโดยผู้เชี่ยวชาญด้านกฎหมายคุ้มครองข้อมูลส่วนบุคคลก่อนใช้งานจริง</p>`;
  }

  function legalSection(title, content) { return `<section class="legal-section"><h4>${title}</h4>${content}</section>`; }

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
