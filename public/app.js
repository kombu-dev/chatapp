const socket = io();

let localStream = null;
let isTalking = false;
let currentRoomId = '';
const peers = {};

const joinScreen = document.getElementById('joinScreen');
const talkScreen = document.getElementById('talkScreen');
const roomInput  = document.getElementById('room');
const joinBtn    = document.getElementById('joinBtn');
const statusEl   = document.getElementById('status');
const roomLabel  = document.getElementById('roomLabel');
const memberList = document.getElementById('memberList');
const pttBtn     = document.getElementById('pttBtn');

const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ── Join ────────────────────────────────────────────────────────────────────

joinBtn.addEventListener('click', async () => {
  const roomId = roomInput.value.trim();
  if (!roomId) return;

  // Started directly inside the click handler so it inherits the user
  // gesture — required for autoplay, and it's what keeps a Media Session
  // alive (needed for the earphone button to reach us with the screen off).
  startKeepAliveAudio();

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    statusEl.textContent = 'マイクへのアクセスが許可されていません';
    return;
  }

  // Start muted — PTT controls when mic is live
  localStream.getAudioTracks()[0].enabled = false;

  currentRoomId = roomId;
  joinScreen.classList.add('hidden');
  talkScreen.classList.remove('hidden');
  roomLabel.textContent = `ルーム: ${roomId}`;

  addMember(socket.id, true);
  setupMediaSession();
  socket.emit('join', roomId);
});

// ── PTT: on-screen button ────────────────────────────────────────────────────

pttBtn.addEventListener('touchstart',  (e) => { e.preventDefault(); startTalking(); }, { passive: false });
pttBtn.addEventListener('touchend',    (e) => { e.preventDefault(); stopTalking();  }, { passive: false });
pttBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); stopTalking();  }, { passive: false });
pttBtn.addEventListener('mousedown',   () => startTalking());
pttBtn.addEventListener('mouseup',     () => stopTalking());
pttBtn.addEventListener('mouseleave',  () => { if (isTalking) stopTalking(); });

// ── PTT: double-tap anywhere on the talk screen (toggle mode) ───────────────
// A fallback for earphones with no hardware button, since a touch double-tap
// is far more reliable than hoping the earbuds forward a play/pause signal.

let lastTapAt = 0;
talkScreen.addEventListener('touchend', (e) => {
  if (e.target.closest('#pttBtn')) return;
  const now = Date.now();
  if (now - lastTapAt < 350) {
    e.preventDefault();
    toggleTalking();
    lastTapAt = 0;
  } else {
    lastTapAt = now;
  }
}, { passive: false });

talkScreen.addEventListener('dblclick', (e) => {
  if (e.target.closest('#pttBtn')) return;
  toggleTalking();
});

// ── Keep-alive audio ─────────────────────────────────────────────────────────
// A silent loop is not reliably treated as "playing" by mobile browsers, so
// the Media Session (and with it, the earphone button) can get dropped once
// the screen locks. A very quiet real tone keeps the session alive.

function buildQuietLoopUrl() {
  const sampleRate = 8000;
  const seconds = 2;
  const numSamples = sampleRate * seconds;
  const amplitude = 0.02;
  const freq = 200;

  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amplitude;
    view.setInt16(44 + i * 2, s * 32767, true);
  }

  return URL.createObjectURL(new Blob([view], { type: 'audio/wav' }));
}

function startKeepAliveAudio() {
  const audio = document.createElement('audio');
  audio.src = buildQuietLoopUrl();
  audio.loop = true;
  audio.playsInline = true;
  document.body.appendChild(audio);
  audio.play().catch(() => {});
}

// ── PTT: earphone button via Media Session (toggle mode) ────────────────────

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: 'インカム通話中' });
  navigator.mediaSession.playbackState = 'playing';

  // Different earphones map their gesture to different transport commands —
  // bind everything plausible to the same toggle so whichever one the
  // earbuds actually send still works.
  const actions = ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward'];
  for (const action of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, toggleTalking);
    } catch {}
  }
}

// ── Talking state ────────────────────────────────────────────────────────────

function toggleTalking() {
  isTalking ? stopTalking() : startTalking();
}

function startTalking() {
  if (!localStream || isTalking) return;
  isTalking = true;
  localStream.getAudioTracks()[0].enabled = true;
  pttBtn.classList.add('active');
  setSelfTalking(true);
  socket.emit('talking');
}

function stopTalking() {
  if (!isTalking) return;
  isTalking = false;
  localStream.getAudioTracks()[0].enabled = false;
  pttBtn.classList.remove('active');
  setSelfTalking(false);
  socket.emit('silent');
}

function setSelfTalking(active) {
  const li = document.getElementById(`member-${socket.id}`);
  if (!li) return;
  li.classList.toggle('talking', active);
  li.querySelector('.member-state').textContent = active ? '送話中' : '';
}

// ── WebRTC ───────────────────────────────────────────────────────────────────

function createPeerConnection(id) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    let audio = document.getElementById(`audio-${id}`);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = `audio-${id}`;
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
  };

  peers[id] = pc;
  addMember(id, false);
  return pc;
}

async function callPeer(id) {
  const pc = createPeerConnection(id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: id, data: { sdp: offer } });
}

socket.on('existing-members', async (members) => {
  for (const id of members) await callPeer(id);
});

socket.on('peer-joined', () => {});

socket.on('signal', async ({ from, data }) => {
  let pc = peers[from];
  if (!pc) pc = createPeerConnection(from);

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: answer } });
    }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  }
});

socket.on('peer-left', (id) => {
  if (peers[id]) { peers[id].close(); delete peers[id]; }
  document.getElementById(`audio-${id}`)?.remove();
  document.getElementById(`member-${id}`)?.remove();
});

socket.on('peer-talking', (id) => {
  const li = document.getElementById(`member-${id}`);
  if (!li) return;
  li.classList.add('talking');
  li.querySelector('.member-state').textContent = '送話中';
});

socket.on('peer-silent', (id) => {
  const li = document.getElementById(`member-${id}`);
  if (!li) return;
  li.classList.remove('talking');
  li.querySelector('.member-state').textContent = '';
});

// ── Member list helpers ───────────────────────────────────────────────────────

function addMember(id, isSelf) {
  const li = document.createElement('li');
  li.id = `member-${id}`;
  if (isSelf) li.classList.add('self');

  const dot  = document.createElement('span');
  dot.className = 'member-dot';

  const name = document.createElement('span');
  name.className = 'member-name';
  name.textContent = isSelf ? 'あなた' : `参加者 ${id.slice(0, 5)}`;

  const state = document.createElement('span');
  state.className = 'member-state';

  li.append(dot, name, state);
  memberList.appendChild(li);
}
