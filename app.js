/* PeerCall: PeerJS + WebRTC, no backend required for this demo. */

const state = {
  peer: null,
  peerId: "",
  currentCall: null,
  incomingCall: null,
  localStream: null,
  mode: "video",
  callStartedAt: 0,
  timerId: null,
};

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const myIdEl = $("myId");
const remoteIdEl = $("remoteId");
const callBtn = $("callBtn");
const shareIdBtn = $("shareIdBtn");
const copyIdBtn = $("copyIdBtn");
const incomingCard = $("incomingCard");
const incomingTitle = $("incomingTitle");
const incomingText = $("incomingText");
const acceptBtn = $("acceptBtn");
const rejectBtn = $("rejectBtn");
const callState = $("callState");
const timerEl = $("timer");
const remotePane = $("remotePane");
const remoteVideo = $("remoteVideo");
const remoteAudio = $("remoteAudio");
const remotePlaceholder = $("remotePlaceholder");
const localPane = $("localPane");
const localVideo = $("localVideo");
const micBtn = $("micBtn");
const cameraBtn = $("cameraBtn");
const hangupBtn = $("hangupBtn");
const logEl = $("log");

function log(message) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `${new Date().toLocaleTimeString("th-TH")} · ${message}`;
  logEl.prepend(line);
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind ? `status-${kind}` : ""}`;
}

function setCallState(text) {
  callState.textContent = text;
}

function formatTime(seconds) {
  const min = Math.floor(seconds / 60).toString().padStart(2, "0");
  const sec = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${min}:${sec}`;
}

function startTimer() {
  clearInterval(state.timerId);
  state.callStartedAt = Date.now();
  timerEl.textContent = "00:00";
  state.timerId = setInterval(() => {
    timerEl.textContent = formatTime((Date.now() - state.callStartedAt) / 1000);
  }, 1000);
}

function stopTimer() {
  clearInterval(state.timerId);
  state.timerId = null;
  timerEl.textContent = "00:00";
}

function currentPeerId() {
  return remoteIdEl.value.trim();
}

function mediaConstraints(mode) {
  return mode === "video"
    ? { audio: true, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } }
    : { audio: true, video: false };
}

async function getLocalStream(mode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("เบราว์เซอร์นี้ไม่รองรับกล้อง/ไมโครโฟน หรือหน้านี้ไม่ได้เปิดผ่าน HTTPS");
  }

  if (state.localStream) {
    const hasVideo = state.localStream.getVideoTracks().length > 0;
    if ((mode === "video") === hasVideo) return state.localStream;
    stopLocalStream();
  }

  const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(mode));
  state.localStream = stream;
  localVideo.srcObject = stream;
  localPane.classList.toggle("hidden", mode !== "video");
  cameraBtn.disabled = mode !== "video";
  cameraBtn.classList.remove("off");
  micBtn.disabled = false;
  micBtn.classList.remove("off");
  micBtn.textContent = "ปิดไมค์";
  cameraBtn.textContent = "ปิดกล้อง";
  return stream;
}

function stopLocalStream() {
  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
  }
  state.localStream = null;
  localVideo.srcObject = null;
  localPane.classList.add("hidden");
  micBtn.disabled = true;
  cameraBtn.disabled = true;
}

function clearRemote() {
  remoteVideo.srcObject = null;
  remoteAudio.srcObject = null;
  remotePane.classList.add("empty");
  remotePane.classList.remove("remote-audio-mode");
  remotePlaceholder.classList.remove("hidden");
}

function showRemoteStream(stream, mode) {
  remotePane.classList.remove("empty");
  remotePlaceholder.classList.add("hidden");
  remotePane.classList.toggle("remote-audio-mode", mode === "audio");

  if (mode === "video") {
    remoteVideo.srcObject = stream;
    remoteAudio.srcObject = null;
    remoteVideo.play().catch(() => log("เบราว์เซอร์บล็อก autoplay — แตะหน้าจอหนึ่งครั้งเพื่อเริ่มเสียง"));
  } else {
    remoteAudio.srcObject = stream;
    remoteAudio.play().catch(() => log("แตะหน้าจอหนึ่งครั้งเพื่อเริ่มเสียง"));
  }
}

function resetCallUi() {
  state.currentCall = null;
  state.incomingCall = null;
  incomingCard.classList.add("hidden");
  hangupBtn.disabled = true;
  setCallState("ยังไม่ได้โทร");
  stopTimer();
  stopLocalStream();
  clearRemote();
}

function bindCall(call, mode, direction) {
  state.currentCall = call;
  state.mode = mode;
  callState.textContent = direction === "outgoing" ? "กำลังโทร…" : "กำลังเชื่อมต่อ…";
  hangupBtn.disabled = false;

  call.on("stream", (stream) => {
    showRemoteStream(stream, mode);
    setCallState("กำลังสนทนา");
    startTimer();
    log("เชื่อมต่อเสียง/วิดีโอสำเร็จ");
  });

  call.on("close", () => {
    log("ปลายทางวางสาย");
    resetCallUi();
  });

  call.on("error", (err) => {
    log(`ข้อผิดพลาดของสาย: ${err.message || err.type || "unknown"}`);
    resetCallUi();
  });
}

async function startOutgoingCall() {
  const destination = currentPeerId();
  if (!destination) return alert("กรุณาใส่ Peer ID ของปลายทาง");
  if (!state.peer || state.peer.destroyed) return alert("Peer ยังไม่พร้อม");
  if (destination === state.peerId) return alert("ไม่สามารถโทรหาตัวเองได้");
  if (state.currentCall) return alert("มีสายสนทนาอยู่แล้ว");

  try {
    callBtn.disabled = true;
    const stream = await getLocalStream(state.mode);
    const call = state.peer.call(destination, stream, { metadata: { mode: state.mode } });
    if (!call) throw new Error("PeerJS ไม่สามารถเริ่มสายได้");
    bindCall(call, state.mode, "outgoing");
    log(`กำลังโทรหา ${destination}`);
  } catch (err) {
    log(err.message || "เปิดกล้อง/ไมค์ไม่สำเร็จ");
    resetCallUi();
  } finally {
    callBtn.disabled = false;
  }
}

async function acceptIncoming() {
  if (!state.incomingCall) return;
  const call = state.incomingCall;
  const mode = call.metadata?.mode === "audio" ? "audio" : "video";

  try {
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;
    const stream = await getLocalStream(mode);
    call.answer(stream);
    bindCall(call, mode, "incoming");
    incomingCard.classList.add("hidden");
    log(`รับสายแบบ${mode === "video" ? "วิดีโอ" : "เสียง"}`);
  } catch (err) {
    log(err.message || "รับสายไม่สำเร็จ");
    try { call.close(); } catch (_) {}
    resetCallUi();
  } finally {
    acceptBtn.disabled = false;
    rejectBtn.disabled = false;
  }
}

function rejectIncoming() {
  if (state.incomingCall) {
    try { state.incomingCall.close(); } catch (_) {}
  }
  incomingCard.classList.add("hidden");
  state.incomingCall = null;
  setCallState("ปฏิเสธสาย");
  log("ปฏิเสธสายเรียกเข้า");
}

function hangup() {
  if (state.currentCall) {
    try { state.currentCall.close(); } catch (_) {}
  }
  resetCallUi();
  log("วางสายแล้ว");
}

function toggleMic() {
  const track = state.localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const off = !track.enabled;
  micBtn.classList.toggle("off", off);
  micBtn.textContent = off ? "เปิดไมค์" : "ปิดไมค์";
}

function toggleCamera() {
  const track = state.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const off = !track.enabled;
  cameraBtn.classList.toggle("off", off);
  cameraBtn.textContent = off ? "เปิดกล้อง" : "ปิดกล้อง";
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    log("คัดลอก Peer ID แล้ว");
  } catch (_) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
    log("คัดลอก Peer ID แล้ว");
  }
}

async function shareId() {
  const text = state.peerId;
  if (!text) return;
  if (navigator.share) {
    try {
      await navigator.share({ title: "PeerCall", text: `Peer ID สำหรับโทร: ${text}` });
      return;
    } catch (_) {}
  }
  await copyText(text);
}

function selectMode(mode) {
  if (state.currentCall) return;
  state.mode = mode;
  document.querySelectorAll(".mode-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  log(`เลือกโหมด${mode === "video" ? "วิดีโอ" : "เสียง"}`);
}

function initPeer() {
  if (typeof Peer === "undefined") {
    setStatus("โหลด PeerJS ไม่สำเร็จ", "error");
    log("ไม่พบ PeerJS — ตรวจสอบอินเทอร์เน็ตหรือ CDN");
    return;
  }

  state.peer = new Peer();

  state.peer.on("open", (id) => {
    state.peerId = id;
    myIdEl.textContent = id;
    setStatus("พร้อมใช้งาน", "online");
    copyIdBtn.disabled = false;
    shareIdBtn.disabled = false;
    callBtn.disabled = false;
    log("เชื่อมต่อ PeerServer สำเร็จ");
  });

  state.peer.on("call", (call) => {
    if (state.currentCall || state.incomingCall) {
      call.close();
      return;
    }

    const mode = call.metadata?.mode === "audio" ? "audio" : "video";
    state.incomingCall = call;
    incomingTitle.textContent = mode === "video" ? "มีสายวิดีโอเข้า" : "มีสายเสียงเข้า";
    incomingText.textContent = `Peer: ${call.peer}`;
    incomingCard.classList.remove("hidden");
    setCallState("มีสายเรียกเข้า");
    log(`มีสาย${mode === "video" ? "วิดีโอ" : "เสียง"}เข้าจาก ${call.peer}`);
  });

  state.peer.on("error", (err) => {
    const message = err?.type === "peer-unavailable"
      ? "ไม่พบ Peer ID นี้ หรือปลายทางยังไม่ออนไลน์"
      : `${err?.type || "peer-error"}: ${err?.message || "เกิดข้อผิดพลาด"}`;
    log(message);
    setStatus("มีปัญหาการเชื่อมต่อ", "error");
  });

  state.peer.on("disconnected", () => {
    setStatus("หลุดจากเซิร์ฟเวอร์", "error");
    log("หลุดจาก PeerServer กำลังพยายามเชื่อมต่อใหม่…");
    if (!state.peer.destroyed) state.peer.reconnect();
  });

  state.peer.on("close", () => {
    setStatus("ปิดการเชื่อมต่อ", "error");
  });
}

document.querySelectorAll(".mode-btn").forEach((button) => {
  button.addEventListener("click", () => selectMode(button.dataset.mode));
});
callBtn.addEventListener("click", startOutgoingCall);
acceptBtn.addEventListener("click", acceptIncoming);
rejectBtn.addEventListener("click", rejectIncoming);
hangupBtn.addEventListener("click", hangup);
micBtn.addEventListener("click", toggleMic);
cameraBtn.addEventListener("click", toggleCamera);
copyIdBtn.addEventListener("click", () => copyText(state.peerId));
shareIdBtn.addEventListener("click", shareId);
$("clearLogBtn").addEventListener("click", () => { logEl.innerHTML = ""; });

window.addEventListener("pagehide", () => {
  try { state.currentCall?.close(); } catch (_) {}
  try { state.peer?.destroy(); } catch (_) {}
  stopLocalStream();
});

if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
  log("คำเตือน: กล้องและไมค์ต้องใช้ HTTPS เมื่อเผยแพร่จริง");
}

initPeer();
