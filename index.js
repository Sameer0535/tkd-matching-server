const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const REQ_VOTES = 2;
const WINDOW_MS = 2000;

// Store rooms in memory
const rooms = {};

class MatchRoom {
  constructor(pin, hostId) {
    this.pin = pin;
    this.hostId = hostId; // Jury
    this.referees = new Set();
    this.pointVotes = []; // Queue of votes { socketId, color, points, type, timestamp }
  }

  addVote(socketId, color, points, type) {
    const now = Date.now();
    this.pointVotes.push({ socketId, color, points, type, timestamp: now });
    
    // Purge old votes
    this.pointVotes = this.pointVotes.filter(v => now - v.timestamp <= WINDOW_MS);

    // Filter relevant votes (must match color and points)
    const matchVotes = this.pointVotes.filter(v => v.color === color && v.points === points);
    
    // Count unique referees who cast this specific vote color/points in the window
    const uniqueRefs = new Set(matchVotes.map(v => v.socketId));

    if (uniqueRefs.size >= REQ_VOTES) {
      // Pick a type to broadcast (the first one that isn't null/undefined)
      const validatedType = matchVotes.find(v => v.type)?.type || type;

      // Clear these votes to avoid double counting
      this.pointVotes = this.pointVotes.filter(v => !(v.color === color && v.points === points));
      return validatedType; // Return the type instead of just true
    }
    return null;
  }
}

function generatePIN() {
  return Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit code
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Host creates a new match room
  socket.on('create_room', (callback) => {
    let pin = generatePIN();
    while (rooms[pin]) {
      pin = generatePIN();
    }
    
    rooms[pin] = new MatchRoom(pin, socket.id);
    socket.join(pin);
    console.log(`Room ${pin} created by Host ${socket.id}`);
    
    if (callback) callback({ success: true, pin });
  });

  // Referee joins a room
  socket.on('join_room', ({ pin }, callback) => {
    const room = rooms[pin];
    if (!room) {
      if (callback) callback({ success: false, message: 'Invalid Match PIN' });
      return;
    }

    if (room.referees.size >= 4) { // Let's technically cap at something reasonable
       // Let any amount join for local testing robustness
    }

    room.referees.add(socket.id);
    socket.join(pin);
    console.log(`Referee ${socket.id} joined Room ${pin}`);
    
    // Notify host
    io.to(room.hostId).emit('referee_joined', { refereeCount: room.referees.size });
    
    if (callback) callback({ success: true });
  });

  // Referee fires a point vote
  socket.on('submit_vote', ({ pin, color, points, type }) => {
    const room = rooms[pin];
    if (!room) return;

    // Validate if enough votes happened!
    const validatedType = room.addVote(socket.id, color, points, type);
    
    if (validatedType) {
      console.log(`[Room ${pin}] VALIDATED: ${color} +${points} (${validatedType})`);
      // Notify everyone in the room (primarily the Jury Host)
      io.to(pin).emit('point_validated', { color, points, type: validatedType });
    }
  });

  // Host fires forced point/gamjeom for overrides UI fallback
  socket.on('force_event', ({ pin, type, color, value }) => {
    const room = rooms[pin];
    if (!room) return;
    if (room.hostId === socket.id) {
       // Just pass it down to sync (though Scoreboard is local, this helps if any client needed to sync)
       // This isn't strictly necessary since Jury component handles its own state,
       // but we'll include it for completeness
       io.to(pin).emit('force_event_sync', { type, color, value });
    }
  });

  socket.on('disconnect', () => {
    // Cleanup if host leaves or referee leaves
    for (const pin in rooms) {
      const room = rooms[pin];
      if (room.hostId === socket.id) {
        // Host left. Close room.
        io.to(pin).emit('room_closed');
        delete rooms[pin];
        console.log(`Room ${pin} destroyed because host left.`);
      } else if (room.referees.has(socket.id)) {
        room.referees.delete(socket.id);
        io.to(room.hostId).emit('referee_left', { refereeCount: room.referees.size });
        console.log(`Referee left room ${pin}`);
      }
    }
  });
});

const PORT = 3001;
server.listen(PORT, () => {
  console.log(`Taekwondo Matching Server running on http://localhost:${PORT}`);
});
