const socket = io();

let localStream = null;
const peers = {}; // socketId -> RTCPeerConnection

const roomInput = document.getElementById('room');
const joinBtn = document.getElementById('joinBtn');
const muteBtn = document.getElementById('muteBtn');
const memberList = document.getElementById('memberList');
const statusEl = document.getElementById('status');

const ICE_SERVERS = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

joinBtn.addEventListener('click', async () => {
  const roomId = roomInput.value.trim();
  if (!roomId) return;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    statusEl.textContent = 'マイクへのアクセスが許可されませんでした';
    return;
  }

  joinBtn.disabled = true;
  roomInput.disabled = true;
  muteBtn.disabled = false;
  statusEl.textContent = `ルーム「${roomId}」に接続中...`;
  socket.emit('join', roomId);
});

muteBtn.addEventListener('click', () => {
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  muteBtn.textContent = track.enabled ? 'ミュート' : 'ミュート解除';
});

function createPeerConnection(id) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', { to: id, data: { candidate: event.candidate } });
    }
  };

  pc.ontrack = (event) => {
    let audioEl = document.getElementById(`audio-${id}`);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `audio-${id}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = event.streams[0];
  };

  pc.onconnectionstatechange = () => {
    updateMemberStatus(id, pc.connectionState);
  };

  peers[id] = pc;
  addMemberToList(id);
  return pc;
}

async function callPeer(id) {
  const pc = createPeerConnection(id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: id, data: { sdp: offer } });
}

socket.on('existing-members', async (members) => {
  statusEl.textContent = `接続済み (${members.length + 1}人)`;
  for (const id of members) {
    await callPeer(id);
  }
});

socket.on('peer-joined', () => {
  statusEl.textContent = 'メンバーが参加しました';
});

socket.on('signal', async ({ from, data }) => {
  let pc = peers[from];
  if (!pc) {
    pc = createPeerConnection(from);
  }

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: answer } });
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.error('ICE candidate error', err);
    }
  }
});

socket.on('peer-left', (id) => {
  if (peers[id]) {
    peers[id].close();
    delete peers[id];
  }
  const audioEl = document.getElementById(`audio-${id}`);
  if (audioEl) audioEl.remove();
  removeMemberFromList(id);
});

function addMemberToList(id) {
  const li = document.createElement('li');
  li.id = `member-${id}`;
  li.textContent = `参加者 ${id.slice(0, 5)}`;
  memberList.appendChild(li);
}

function removeMemberFromList(id) {
  const li = document.getElementById(`member-${id}`);
  if (li) li.remove();
}

function updateMemberStatus(id, state) {
  const li = document.getElementById(`member-${id}`);
  if (li) li.textContent = `参加者 ${id.slice(0, 5)} (${state})`;
}
