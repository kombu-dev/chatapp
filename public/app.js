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

// ── PTT: volume UP key (Android Chrome) ─────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'AudioVolumeUp' || e.keyCode === 175) {
    e.preventDefault();
    startTalking();
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'AudioVolumeUp' || e.keyCode === 175) {
    e.preventDefault();
    stopTalking();
  }
});

// ── PTT: earphone button via Media Session (toggle mode) ────────────────────

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.setActionHandler('play',  () => { isTalking ? stopTalking() : startTalking(); });
  navigator.mediaSession.setActionHandler('pause', () => { isTalking ? stopTalking() : startTalking(); });
}

// ── Talking state ────────────────────────────────────────────────────────────

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
