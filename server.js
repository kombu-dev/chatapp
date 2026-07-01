const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> Set of socket ids
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join', (roomId) => {
    currentRoom = roomId;
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const members = rooms.get(roomId);
    const existingMembers = Array.from(members);
    members.add(socket.id);

    socket.emit('existing-members', existingMembers);
    socket.to(roomId).emit('peer-joined', socket.id);
  });

  // Relay WebRTC offer/answer/ICE candidates to a specific peer
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('talking', () => {
    socket.to(currentRoom).emit('peer-talking', socket.id);
  });

  socket.on('silent', () => {
    socket.to(currentRoom).emit('peer-silent', socket.id);
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(socket.id);
      socket.to(currentRoom).emit('peer-left', socket.id);
      if (rooms.get(currentRoom).size === 0) rooms.delete(currentRoom);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
