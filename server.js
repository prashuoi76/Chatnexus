const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ── PostgreSQL ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 12,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code VARCHAR(8) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL DEFAULT 'Anonymous Room',
      passcode VARCHAR(30),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      sender_id VARCHAR(64) NOT NULL,
      sender_name VARCHAR(60) NOT NULL,
      sender_color VARCHAR(20) NOT NULL,
      text TEXT DEFAULT '',
      image_data TEXT,
      reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      pinned BOOLEAN DEFAULT FALSE,
      edited BOOLEAN DEFAULT FALSE,
      reactions TEXT DEFAULT '[]'::text,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_id, created_at);
  `);
  console.log('✓ Database ready');
}

// ── Anonymous Identity Generator ──
const ADJ = ['Silent','Swift','Dark','Bright','Crimson','Silver','Golden','Shadow','Frozen','Burning',
  'Hidden','Mystic','Phantom','Velvet','Iron','Neon','Cosmic','Ancient','Wild','Gentle',
  'Noble','Fierce','Clever','Brave','Calm','Rogue','Lunar','Solar','Storm','Ember'];
const ANI = ['Fox','Wolf','Eagle','Tiger','Panther','Owl','Hawk','Cobra','Lynx','Raven',
  'Falcon','Jaguar','Phoenix','Dragon','Serpent','Lion','Bear','Shark','Viper','Mantis',
  'Crane','Otter','Panda','Crow','Hare','Moth','Orca','Bison','Gecko','Koi'];
const COLS = ['#e8a035','#e05252','#4ecb71','#5ba4f5','#c678dd','#e06c75','#56b6c2','#d19a66','#98c379','#e5c07b','#be5046','#61afef','#ff6b9d','#50fa7b','#f1fa8c'];

function makeIdentity() {
  return {
    id: crypto.randomBytes(8).toString('hex'),
    name: ADJ[Math.floor(Math.random() * ADJ.length)] + ' ' + ANI[Math.floor(Math.random() * ANI.length)],
    color: COLS[Math.floor(Math.random() * COLS.length)]
  };
}

function makeCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

// ── In-Memory State ──
const roomUsers = {}; // roomId → [{ socketId, userId, userName, userColor }]

// ── Rate Limiter ──
const limits = {};
function rateLimit(sid, max = 20, ms = 60000) {
  const now = Date.now();
  if (!limits[sid]) limits[sid] = [];
  limits[sid] = limits[sid].filter(t => now - t < ms);
  if (limits[sid].length >= max) return false;
  limits[sid].push(now);
  return true;
}

// ── Static Files ──
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.status(200).send('OK'));

// ── Socket.IO ──
io.on('connection', (socket) => {
  const me = makeIdentity();
  socket.me = me;
  socket.emit('your-identity', me);

  // ── Create Room ──
  socket.on('create-room', async ({ name, passcode }) => {
    if (!rateLimit(socket.id, 5, 60000)) return socket.emit('error', 'Slow down');
    try {
      let code = makeCode();
      let ok = false;
      while (!ok) {
        const r = await pool.query('SELECT 1 FROM rooms WHERE code=$1', [code]);
        if (r.rows.length === 0) ok = true; else code = makeCode();
      }
      const res = await pool.query(
        'INSERT INTO rooms (code, name, passcode) VALUES ($1,$2,$3) RETURNING id,code,name',
        [code, (name || 'Anonymous Room').slice(0, 100), passcode || null]
      );
      socket.emit('room-created', res.rows[0]);
    } catch (e) { console.error(e); socket.emit('error', 'Failed to create room'); }
  });

  // ── Join Room ──
  socket.on('join-room', async ({ code, passcode }) => {
    if (!rateLimit(socket.id, 10, 60000)) return socket.emit('error', 'Slow down');
    try {
      const res = await pool.query('SELECT * FROM rooms WHERE code=$1', [code.toUpperCase().trim()]);
      if (!res.rows.length) return socket.emit('join-error', 'Room not found');
      const room = res.rows[0];
      if (room.passcode && room.passcode !== (passcode || '')) return socket.emit('join-error', 'Wrong passcode');

      if (socket.roomId) leaveRoom(socket);

      socket.roomId = room.id;
      socket.join('room-' + room.id);

      if (!roomUsers[room.id]) roomUsers[room.id] = [];
      // Remove stale entries for this socket
      roomUsers[room.id] = roomUsers[room.id].filter(u => u.socketId !== socket.id);
      roomUsers[room.id].push({ socketId: socket.id, userId: me.id, userName: me.name, userColor: me.color });

      const msgs = await pool.query(
        'SELECT * FROM messages WHERE room_id=$1 ORDER BY created_at ASC LIMIT 300', [room.id]
      );
      const users = roomUsers[room.id].map(u => ({ userId: u.userId, userName: u.userName, userColor: u.userColor }));

      socket.emit('room-joined', {
        id: room.id, code: room.code, name: room.name,
        messages: msgs.rows.map(m => ({ ...m, reactions: JSON.parse(m.reactions || '[]') })),
        users
      });

      // System message
      const sys = await pool.query(
        'INSERT INTO messages (room_id, sender_id, sender_name, sender_color, text) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
        [room.id, '__system__', '', '', `${me.name} joined the room`]
      );
      io.to('room-' + room.id).emit('new-message', {
        ...sys.rows[0], sender_id: '__system__', sender_name: '', sender_color: '',
        text: `${me.name} joined the room`, reactions: [], image_data: null, reply_to: null, pinned: false, edited: false
      });
    } catch (e) { console.error(e); socket.emit('join-error', 'Failed to join'); }
  });

  // ── Send Message ──
  socket.on('send-message', async ({ text, image, replyTo }) => {
    if (!socket.roomId || !rateLimit(socket.id, 30, 60000)) return;
    try {
      // Limit image size
      if (image && image.length > 800000) return socket.emit('error', 'Image too large (max ~500KB)');
      const res = await pool.query(
        `INSERT INTO messages (room_id, sender_id, sender_name, sender_color, text, image_data, reply_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [socket.roomId, me.id, me.name, me.color, (text || '').slice(0, 4000), image || null, replyTo || null]
      );
      const msg = { ...res.rows[0], reactions: [] };
      io.to('room-' + socket.roomId).emit('new-message', msg);
    } catch (e) { console.error(e); socket.emit('error', 'Send failed'); }
  });

  // ── Typing ──
  socket.on('typing', () => {
    if (socket.roomId) socket.to('room-' + socket.roomId).emit('user-typing', { userName: me.name });
  });

  // ── Edit ──
  socket.on('edit-message', async ({ messageId, text }) => {
    if (!socket.roomId) return;
    try {
      const r = await pool.query(
        'UPDATE messages SET text=$1, edited=TRUE WHERE id=$2 AND room_id=$3 AND sender_id=$4 RETURNING id',
        [text.slice(0, 4000), messageId, socket.roomId, me.id]
      );
      if (r.rows.length) io.to('room-' + socket.roomId).emit('message-edited', { id: messageId, text });
    } catch (e) { console.error(e); }
  });

  // ── Delete ──
  socket.on('delete-message', async ({ messageId }) => {
    if (!socket.roomId) return;
    try {
      const r = await pool.query(
        'DELETE FROM messages WHERE id=$1 AND room_id=$2 AND sender_id=$3 RETURNING id',
        [messageId, socket.roomId, me.id]
      );
      if (r.rows.length) io.to('room-' + socket.roomId).emit('message-deleted', { id: messageId });
    } catch (e) { console.error(e); }
  });

  // ── Reactions ──
  socket.on('toggle-reaction', async ({ messageId, emoji }) => {
    if (!socket.roomId) return;
    try {
      const r = await pool.query('SELECT reactions FROM messages WHERE id=$1 AND room_id=$2', [messageId, socket.roomId]);
      if (!r.rows.length) return;
      let reactions = JSON.parse(r.rows[0].reactions || '[]');
      const ex = reactions.find(x => x.emoji === emoji);
      if (ex) {
        if (ex.users.includes(me.id)) {
          ex.users = ex.users.filter(u => u !== me.id);
          if (!ex.users.length) reactions = reactions.filter(x => x.emoji !== emoji);
        } else ex.users.push(me.id);
      } else reactions.push({ emoji, users: [me.id] });

      await pool.query('UPDATE messages SET reactions=$1 WHERE id=$2', [JSON.stringify(reactions), messageId]);
      io.to('room-' + socket.roomId).emit('reaction-updated', { messageId, reactions });
    } catch (e) { console.error(e); }
  });

  // ── Pin ──
  socket.on('toggle-pin', async ({ messageId }) => {
    if (!socket.roomId) return;
    try {
      const r = await pool.query(
        'UPDATE messages SET pinned=NOT pinned WHERE id=$1 AND room_id=$2 RETURNING pinned',
        [messageId, socket.roomId]
      );
      if (r.rows.length) io.to('room-' + socket.roomId).emit('pin-updated', { messageId, pinned: r.rows[0].pinned });
    } catch (e) { console.error(e); }
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    if (socket.roomId && roomUsers[socket.roomId]) {
      const userName = me.name;
      roomUsers[socket.roomId] = roomUsers[socket.roomId].filter(u => u.socketId !== socket.id);
      socket.to('room-' + socket.roomId).emit('user-left', { userId: me.id, userName });
      // System leave message (fire and forget)
      pool.query(
        'INSERT INTO messages (room_id, sender_id, sender_name, sender_color, text) VALUES ($1,$2,$3,$4,$5)',
        [socket.roomId, '__system__', '', '', `${userName} left the room`]
      ).then(r => {
        if (r.rows.length) io.to('room-' + socket.roomId).emit('new-message', {
          ...r.rows[0], sender_id: '__system__', sender_name: '', sender_color: '',
          text: `${userName} left the room`, reactions: [], image_data: null, reply_to: null, pinned: false, edited: false
        });
      }).catch(() => {});
      socket.leave('room-' + socket.roomId);
      delete socket.roomId;
    }
  });
});

function leaveRoom(socket) {
  if (socket.roomId && roomUsers[socket.roomId]) {
    roomUsers[socket.roomId] = roomUsers[socket.roomId].filter(u => u.socketId !== socket.id);
    socket.to('room-' + socket.roomId).emit('user-left', { userId: socket.me.id, userName: socket.me.name });
    socket.leave('room-' + socket.roomId);
    delete socket.roomId;
  }
}

// ── Start ──
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  server.listen(PORT, () => console.log(`✓ NexusChat on port ${PORT}`));
}).catch(e => { console.error('Init failed:', e); process.exit(1); });

// Keep DB connections warm
setInterval(() => pool.query('SELECT 1').catch(() => {}), 5 * 60 * 1000);