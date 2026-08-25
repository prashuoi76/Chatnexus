require("dotenv").config();
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 25000,
  pingInterval: 20000,
  maxHttpBufferSize: 8e4,
  transports: ["websocket", "polling"]
});

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");

app.use(express.static(path.join(__dirname, "public"), { maxAge: "30m" }));
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    online: users.size,
    uptime: Math.round(process.uptime())
  });
});

/* ---------------- config ---------------- */
const PUBLIC_ROOMS = [
  { id: "lounge", name: "Lounge", emoji: "🛋️", desc: "Anything. Zero pressure." },
  { id: "music", name: "Music", emoji: "🎧", desc: "Songs, taste, late night mixes." },
  { id: "gaming", name: "Gaming", emoji: "🎮", desc: "Squads, rage, clips." },
  { id: "latenight", name: "Late Night", emoji: "🌙", desc: "3AM brain only." },
  { id: "confessions", name: "Confessions", emoji: "🤫", desc: "Say it. Stay a ghost." },
  { id: "study", name: "Study", emoji: "📚", desc: "Exams, focus, crashouts." }
];

const ADJ = ["Silent","Neon","Lazy","Cosmic","Feral","Sleepy","Spicy","Frosty","Velvet","Glitchy","Lucid","Retro","Hyper","Moody","Golden","Rogue","Fuzzy","Astro","Chill","Toxic"];
const NOUN = ["Panda","Comet","Waffle","Ghost","Otter","Raven","Pixel","Mango","Falcon","Nova","Cactus","Tiger","Sushi","Onion","Wizard","Koala","Bento","Shark","Cloud","Gremlin"];
const AVATARS = ["🦊","🐼","👻","🐸","🦄","🐧","🐙","🦖","🐝","🌚","🍄","🔥","🌈","⚡","🍕","🎈","🪐","🧊","🐳","🦋"];
const COLORS = ["#ff2e93","#7c3aed","#00e5ff","#22c55e","#f59e0b","#ef4444","#38bdf8","#a3e635"];
const BAD = ["nigger","nigga","faggot","retard","rape","kys","kill yourself","cunt","child porn","pedo","whore","slut"];

const MAX_MSG = 400;
const MAX_NICK = 16;
const HISTORY = 50;
const RATE_MS = 3500;
const RATE_N = 6;
const SESSION_TTL = 1000 * 60 * 45;

/* ---------------- state ---------------- */
const users = new Map();          // socketId -> user
const idToSocket = new Map();     // ghostId -> socketId
const sessions = new Map();       // sessionId -> snapshot
const roomHistory = new Map();    // public room messages
const squads = new Map();         // code -> { users:Set, messages[], createdAt }
const dms = new Map();            // dmKey -> messages[]
const pairs = new Map();          // random socket -> partner
let queue = [];

PUBLIC_ROOMS.forEach(r => roomHistory.set(r.id, []));

/* ---------------- helpers ---------------- */
const pick = a => a[Math.floor(Math.random() * a.length)];
const uid = () => Math.random().toString(36).slice(2, 10);
const nickGen = () => `${pick(ADJ)}${pick(NOUN)}${Math.floor(Math.random() * 90 + 10)}`;

function codeGen(n = 6) {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function uniqueGhostId() {
  let id = codeGen(5);
  while (idToSocket.has(id)) id = codeGen(5);
  return id;
}

function clean(str, max) {
  if (typeof str !== "string") return "";
  return str.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);
}

function filterBad(text) {
  let out = text;
  for (const w of BAD) {
    out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), m => "•".repeat(m.length));
  }
  return out;
}

function sanitize(raw) {
  let t = clean(raw, MAX_MSG);
  if (!t) return "";
  t = t
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/gi, "[email removed]")
    .replace(/\b(?:\+?\d[\d\s\-()]{7,}\d)\b/g, "[number removed]");
  return filterBad(t);
}

function limited(u) {
  const now = Date.now();
  u.stamps = (u.stamps || []).filter(t => now - t < RATE_MS);
  if (u.stamps.length >= RATE_N) return true;
  u.stamps.push(now);
  return false;
}

function publicCount(id) {
  return io.sockets.adapter.rooms.get(id)?.size || 0;
}

function inviteUrl(kind, value) {
  const base = SITE_URL || "";
  if (!base) return "";
  return kind === "squad" ? `${base}/?squad=${value}` : `${base}/?u=${value}`;
}

function publicMe(u) {
  return { nick: u.nick, avatar: u.avatar, color: u.color, ghostId: u.ghostId };
}

function leavePlaces(socket, reason = "left") {
  const u = users.get(socket.id);
  if (!u) return;

  if (u.publicRoom) {
    socket.to(u.publicRoom).emit("sys", { scope: "room", text: `${u.nick} left` });
    socket.leave(u.publicRoom);
    u.publicRoom = null;
  }

  if (u.squad) {
    const s = squads.get(u.squad);
    if (s) {
      s.users.delete(socket.id);
      socket.to("squad:" + u.squad).emit("sys", { scope: "squad", text: `${u.nick} left` });
      socket.to("squad:" + u.squad).emit("squad:members", membersOf(u.squad));
      if (s.users.size === 0 && Date.now() - s.createdAt > 60000) squads.delete(u.squad);
    }
    socket.leave("squad:" + u.squad);
    u.squad = null;
  }

  if (u.dm) {
    socket.to("dm:" + u.dm).emit("sys", { scope: "dm", text: `${u.nick} left` });
    socket.leave("dm:" + u.dm);
    u.dm = null;
    u.dmWith = null;
  }

  endRandom(socket, reason);
}

function membersOf(code) {
  const s = squads.get(code);
  if (!s) return [];
  return [...s.users].map(id => {
    const u = users.get(id);
    return u ? publicMe(u) : null;
  }).filter(Boolean);
}

function dmKey(a, b) {
  return [a, b].sort().join(":");
}

function pushHist(arr, msg, limit = HISTORY) {
  arr.push(msg);
  if (arr.length > limit) arr.shift();
}

function stats() {
  let squadPeople = 0;
  squads.forEach(s => { squadPeople += s.users.size; });
  const rooms = {};
  PUBLIC_ROOMS.forEach(r => { rooms[r.id] = publicCount(r.id); });
  io.emit("stats", {
    online: users.size,
    rooms,
    waiting: queue.length,
    chatting: Math.floor(pairs.size / 2),
    squads: squads.size,
    squadPeople
  });
}

function saveSession(u) {
  sessions.set(u.sessionId, {
    ghostId: u.ghostId,
    nick: u.nick,
    avatar: u.avatar,
    color: u.color,
    interests: u.interests,
    at: Date.now()
  });
}

/* ---------------- sockets ---------------- */
io.on("connection", socket => {
  const given = clean(socket.handshake.auth?.sessionId || "", 24);
  const sessionId = given || uid() + uid();
  const snap = sessions.get(sessionId);
  const fresh = !snap || Date.now() - snap.at > SESSION_TTL;

  let ghostId = !fresh && snap.ghostId && !idToSocket.has(snap.ghostId) ? snap.ghostId : uniqueGhostId();

  const user = {
    id: socket.id,
    sessionId,
    ghostId,
    nick: !fresh ? snap.nick : nickGen(),
    avatar: !fresh ? snap.avatar : pick(AVATARS),
    color: !fresh ? snap.color : pick(COLORS),
    interests: !fresh ? snap.interests : [],
    stamps: [],
    blocked: new Set(),
    lastPartner: null,
    publicRoom: null,
    squad: null,
    dm: null,
    dmWith: null
  };

  users.set(socket.id, user);
  idToSocket.set(user.ghostId, socket.id);
  saveSession(user);

  socket.emit("hello", {
    me: { ...publicMe(user), interests: user.interests, sessionId },
    rooms: PUBLIC_ROOMS,
    siteUrl: SITE_URL
  });
  stats();

  socket.on("me:update", data => {
    const u = users.get(socket.id);
    if (!u) return;
    const nick = clean(data?.nick || "", MAX_NICK).replace(/\s+/g, "");
    if (nick.length >= 2) u.nick = filterBad(nick);
    if (AVATARS.includes(data?.avatar)) u.avatar = data.avatar;
    if (Array.isArray(data?.interests)) {
      u.interests = data.interests.map(x => clean(String(x), 12).toLowerCase()).filter(Boolean).slice(0, 5);
    }
    saveSession(u);
    socket.emit("me:updated", { ...publicMe(u), interests: u.interests, sessionId: u.sessionId });
  });

  socket.on("me:reroll", () => {
    const u = users.get(socket.id);
    if (!u) return;
    u.nick = nickGen();
    u.avatar = pick(AVATARS);
    u.color = pick(COLORS);
    saveSession(u);
    socket.emit("me:updated", { ...publicMe(u), interests: u.interests, sessionId: u.sessionId });
  });

  socket.on("lookup", ghostIdRaw => {
    const id = clean(String(ghostIdRaw || ""), 8).toUpperCase();
    const sid = idToSocket.get(id);
    const other = sid ? users.get(sid) : null;
    if (!other || other.id === socket.id) return socket.emit("lookup:result", { ok: false, id });
    socket.emit("lookup:result", { ok: true, user: publicMe(other) });
  });

  /* ---- public rooms ---- */
  socket.on("room:join", roomId => {
    const u = users.get(socket.id);
    if (!u || !PUBLIC_ROOMS.some(r => r.id === roomId)) return;
    leavePlaces(socket, "switched");
    socket.join(roomId);
    u.publicRoom = roomId;
    socket.emit("room:opened", {
      room: PUBLIC_ROOMS.find(r => r.id === roomId),
      messages: roomHistory.get(roomId) || [],
      count: publicCount(roomId)
    });
    socket.to(roomId).emit("sys", { scope: "room", text: `${u.nick} joined` });
    stats();
  });

  socket.on("room:msg", text => {
    const u = users.get(socket.id);
    if (!u?.publicRoom) return;
    if (limited(u)) return socket.emit("warn", "slow down 🐢");
    const body = sanitize(text);
    if (!body) return;
    const msg = { id: uid(), ...publicMe(u), text: body, ts: Date.now() };
    pushHist(roomHistory.get(u.publicRoom), msg);
    io.to(u.publicRoom).emit("chat", { scope: "room", msg });
  });

  socket.on("room:typing", on => {
    const u = users.get(socket.id);
    if (u?.publicRoom) socket.to(u.publicRoom).emit("typing", { scope: "room", nick: u.nick, on: !!on });
  });

  /* ---- squads ---- */
  socket.on("squad:create", () => {
    const u = users.get(socket.id);
    if (!u) return;
    let code = codeGen(6);
    while (squads.has(code)) code = codeGen(6);
    squads.set(code, { users: new Set(), messages: [], createdAt: Date.now() });
    socket.emit("squad:ready", { code, url: inviteUrl("squad", code) });
  });

  socket.on("squad:join", raw => {
    const u = users.get(socket.id);
    if (!u) return;
    const code = clean(String(raw || ""), 8).toUpperCase();
    if (code.length < 4) return socket.emit("warn", "invalid code");
    leavePlaces(socket, "switched");
    if (!squads.has(code)) squads.set(code, { users: new Set(), messages: [], createdAt: Date.now() });
    const s = squads.get(code);
    s.users.add(socket.id);
    u.squad = code;
    socket.join("squad:" + code);
    socket.emit("squad:opened", {
      code,
      url: inviteUrl("squad", code),
      messages: s.messages,
      members: membersOf(code)
    });
    socket.to("squad:" + code).emit("sys", { scope: "squad", text: `${u.nick} joined` });
    io.to("squad:" + code).emit("squad:members", membersOf(code));
    stats();
  });

  socket.on("squad:msg", text => {
    const u = users.get(socket.id);
    if (!u?.squad) return;
    if (limited(u)) return socket.emit("warn", "slow down 🐢");
    const body = sanitize(text);
    if (!body) return;
    const msg = { id: uid(), ...publicMe(u), text: body, ts: Date.now() };
    pushHist(squads.get(u.squad).messages, msg);
    io.to("squad:" + u.squad).emit("chat", { scope: "squad", msg });
  });

  socket.on("squad:typing", on => {
    const u = users.get(socket.id);
    if (u?.squad) socket.to("squad:" + u.squad).emit("typing", { scope: "squad", nick: u.nick, on: !!on });
  });

  /* ---- DM by ghost id ---- */
  socket.on("dm:open", raw => {
    const u = users.get(socket.id);
    if (!u) return;
    const id = clean(String(raw || ""), 8).toUpperCase();
    const otherSid = idToSocket.get(id);
    const other = otherSid ? users.get(otherSid) : null;
    if (!other || other.id === socket.id) return socket.emit("warn", "that ghost is not online");
    if (u.blocked.has(other.ghostId) || other.blocked.has(u.ghostId)) {
      return socket.emit("warn", "can't connect to that ghost");
    }
    leavePlaces(socket, "switched");
    const key = dmKey(u.ghostId, other.ghostId);
    if (!dms.has(key)) dms.set(key, []);
    u.dm = key;
    u.dmWith = other.ghostId;
    socket.join("dm:" + key);
    socket.emit("dm:opened", {
      with: publicMe(other),
      messages: dms.get(key),
      url: inviteUrl("user", u.ghostId)
    });
    // ping the other person so they can accept / auto-open
    io.to(other.id).emit("dm:incoming", { from: publicMe(u), key });
  });

  socket.on("dm:accept", keyRaw => {
    const u = users.get(socket.id);
    const key = clean(String(keyRaw || ""), 20);
    if (!u || !dms.has(key)) return;
    leavePlaces(socket, "switched");
    const [a, b] = key.split(":");
    const otherId = a === u.ghostId ? b : a;
    const otherSid = idToSocket.get(otherId);
    const other = otherSid ? users.get(otherSid) : null;
    u.dm = key;
    u.dmWith = otherId;
    socket.join("dm:" + key);
    socket.emit("dm:opened", {
      with: other ? publicMe(other) : { nick: "Ghost", avatar: "👻", color: "#fff", ghostId: otherId },
      messages: dms.get(key)
    });
    if (other) io.to(other.id).emit("sys", { scope: "dm", text: `${u.nick} is here` });
  });

  socket.on("dm:msg", text => {
    const u = users.get(socket.id);
    if (!u?.dm) return;
    if (limited(u)) return socket.emit("warn", "slow down 🐢");
    const body = sanitize(text);
    if (!body) return;
    const msg = { id: uid(), ...publicMe(u), text: body, ts: Date.now() };
    pushHist(dms.get(u.dm), msg);
    io.to("dm:" + u.dm).emit("chat", { scope: "dm", msg });
  });

  socket.on("dm:typing", on => {
    const u = users.get(socket.id);
    if (u?.dm) socket.to("dm:" + u.dm).emit("typing", { scope: "dm", nick: u.nick, on: !!on });
  });

  /* ---- random ---- */
  socket.on("random:start", () => {
    const u = users.get(socket.id);
    if (!u) return;
    leavePlaces(socket, "restart");
    tryMatch(socket);
  });
  socket.on("random:next", () => {
    endRandom(socket, "skipped");
    setTimeout(() => tryMatch(socket), 80);
  });
  socket.on("random:stop", () => endRandom(socket, "stopped"));

  socket.on("random:msg", text => {
    const u = users.get(socket.id);
    const pid = pairs.get(socket.id);
    if (!u || !pid) return;
    if (limited(u)) return socket.emit("warn", "slow down 🐢");
    const body = sanitize(text);
    if (!body) return;
    const msg = { id: uid(), text: body, ts: Date.now() };
    socket.emit("chat", { scope: "random", msg: { ...msg, self: true } });
    io.to(pid).emit("chat", { scope: "random", msg: { ...msg, self: false } });
  });

  socket.on("random:typing", on => {
    const pid = pairs.get(socket.id);
    if (pid) io.to(pid).emit("typing", { scope: "random", on: !!on });
  });

  socket.on("block", () => {
    const u = users.get(socket.id);
    const pid = pairs.get(socket.id);
    if (!u || !pid) return;
    const p = users.get(pid);
    if (p) u.blocked.add(p.ghostId);
    endRandom(socket, "blocked");
    socket.emit("toast", "blocked. you won't rematch 🚫");
  });

  socket.on("report", data => {
    const u = users.get(socket.id);
    if (!u) return;
    const payload = {
      at: new Date().toISOString(),
      by: u.ghostId,
      reason: clean(data?.reason, 140),
      context: clean(data?.context, 200)
    };
    console.log("[REPORT]", payload);
    if (process.env.DISCORD_WEBHOOK) {
      fetch(process.env.DISCORD_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `🚨 ${payload.reason}\n${payload.context}` })
      }).catch(() => {});
    }
    socket.emit("toast", "report sent. thanks for keeping VYBE safer");
  });

  socket.on("leave", () => leavePlaces(socket, "left"));

  socket.on("disconnect", () => {
    const u = users.get(socket.id);
    if (!u) return;
    if (idToSocket.get(u.ghostId) === socket.id) idToSocket.delete(u.ghostId);
    leavePlaces(socket, "disconnected");
    users.delete(socket.id);
    stats();
  });
});

function score(a, b) {
  return a.interests.filter(i => b.interests.includes(i)).length;
}

function tryMatch(socket) {
  const me = users.get(socket.id);
  if (!me) return;
  queue = queue.filter(id => users.has(id) && !pairs.has(id));
  let best = null, bestS = -1;
  for (const id of queue) {
    if (id === socket.id) continue;
    const o = users.get(id);
    if (!o) continue;
    if (me.blocked.has(o.ghostId) || o.blocked.has(me.ghostId)) continue;
    if (me.lastPartner === o.ghostId && queue.length > 2) continue;
    const s = score(me, o);
    if (s > bestS) { bestS = s; best = id; }
  }
  if (!best) {
    if (!queue.includes(socket.id)) queue.push(socket.id);
    socket.emit("random:waiting", { n: queue.length });
    stats();
    return;
  }
  queue = queue.filter(id => id !== best && id !== socket.id);
  const p = users.get(best);
  pairs.set(socket.id, best);
  pairs.set(best, socket.id);
  const shared = me.interests.filter(i => p.interests.includes(i));
  socket.emit("random:matched", { partner: publicMe(p), shared });
  io.to(best).emit("random:matched", { partner: publicMe(me), shared });
  stats();
}

function endRandom(socket, reason) {
  const pid = pairs.get(socket.id);
  const me = users.get(socket.id);
  if (pid) {
    const p = users.get(pid);
    if (me && p) {
      me.lastPartner = p.ghostId;
      p.lastPartner = me.ghostId;
    }
    pairs.delete(pid);
    io.to(pid).emit("random:ended", { reason });
  }
  pairs.delete(socket.id);
  queue = queue.filter(id => id !== socket.id);
  stats();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.at > SESSION_TTL) sessions.delete(k);
  stats();
}, 15000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`VYBE PULSE on 0.0.0.0:${PORT}`);
});      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      sender_id VARCHAR(64) NOT NULL,
      sender_name VARCHAR(60) NOT NULL,
      sender_color VARCHAR(20) NOT NULL,
      text TEXT DEFAULT '',
      image_data TEXT,
      reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      pinned BOOLEAN DEFAULT FALSE,
      edited BOOLEAN DEFAULT FALSE,
      reactions TEXT DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_msg_room ON messages(room_id, created_at);
  `);
  console.log('✓ Database ready');
}

// ── Identity Generator ──
const ADJ = ['Silent','Swift','Dark','Bright','Crimson','Silver','Golden','Shadow','Frozen','Burning','Hidden','Mystic','Phantom','Velvet','Iron','Neon','Cosmic','Ancient','Wild','Gentle','Noble','Fierce','Clever','Brave','Calm','Rogue','Lunar','Solar','Storm','Ember','Toxic','Glitch','Pixel','Neon','Cyber','Hyper','Vapor','LoFi','Chill','Zen'];
const ANI = ['Fox','Wolf','Eagle','Tiger','Panther','Owl','Hawk','Cobra','Lynx','Raven','Falcon','Jaguar','Phoenix','Dragon','Serpent','Lion','Bear','Shark','Viper','Mantis','Crane','Otter','Panda','Crow','Hare','Moth','Orca','Bison','Gecko','Koi','Cat','Ghost','Demon','Angel','Reaper','Elf'];
const COLS = ['#a78bfa','#f472b6','#22d3ee','#34d399','#fbbf24','#fb923c','#f87171','#818cf8','#2dd4bf','#e879f9','#a3e635','#38bdf8'];

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

// ── State ──
const roomUsers = {};
const limits = {};
function rateLimit(sid, max = 20, ms = 60000) {
  const now = Date.now();
  if (!limits[sid]) limits[sid] = [];
  limits[sid] = limits[sid].filter(t => now - t < ms);
  if (limits[sid].length >= max) return false;
  limits[sid].push(now);
  return true;
}

// ── SERVE STATIC — BULLETPROOF ──
// Try multiple paths in case Render directory structure varies
const possiblePaths = [
  path.join(__dirname, 'public'),
  path.join(__dirname, '..', 'public'),
  path.join(process.cwd(), 'public'),
  path.join('/opt/render/project/src/public')
];

let staticDir = null;
for (const p of possiblePaths) {
  if (fs.existsSync(p)) { staticDir = p; break; }
}

if (staticDir) {
  app.use(express.static(staticDir));
  console.log('✓ Serving static from:', staticDir);
} else {
  console.warn('⚠ No public/ directory found, will use inline fallback');
}

// FALLBACK: Serve index.html for ANY GET request that isn't an API route
app.get('*', (req, res) => {
  // Skip API/health
  if (req.path.startsWith('/socket.io') || req.path === '/health') return;

  // Try to find index.html
  for (const p of possiblePaths) {
    const fp = path.join(p, 'index.html');
    if (fs.existsSync(fp)) {
      return res.sendFile(fp);
    }
  }
  // Last resort: if index.html content is embedded
  res.status(200).set('Content-Type', 'text/html').send(FALLBACK_HTML);
});

// Health check
app.get('/health', (_, res) => res.status(200).send('OK'));

// ── Inline fallback HTML (used only if file serving fails) ──
let FALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NexusChat</title><style>body{font-family:system-ui;background:#0a0a12;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}.box{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:40px;max-width:420px}h1{font-size:24px;margin-bottom:8px}p{color:rgba(255,255,255,.5);font-size:14px;line-height:1.6}code{background:rgba(255,255,255,.1);padding:2px 8px;border-radius:6px;font-size:13px}</style></head><body><div class="box"><h1>Setup Needed</h1><p>The <code>public/index.html</code> file was not found. Make sure your repo has this structure:<br><br><code>server.js<br>package.json<br>public/<br>  index.html</code></p></div></body></html>`;

// Read the actual index.html to use as fallback if available
for (const p of possiblePaths) {
  const fp = path.join(p, 'index.html');
  try { if (fs.existsSync(fp)) FALLBACK_HTML = fs.readFileSync(fp, 'utf8'); } catch(e) {}
}

// ── Socket.IO ──
io.on('connection', (socket) => {
  const me = makeIdentity();
  socket.me = me;
  socket.emit('your-identity', me);

  socket.on('create-room', async ({ name, passcode }) => {
    if (!rateLimit(socket.id, 5, 60000)) return socket.emit('error', 'Slow down');
    try {
      let code = makeCode(), ok = false;
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

  socket.on('join-room', async ({ code, passcode }) => {
    if (!rateLimit(socket.id, 10, 60000)) return socket.emit('join-error', 'Slow down');
    try {
      const res = await pool.query('SELECT * FROM rooms WHERE code=$1', [code.toUpperCase().trim()]);
      if (!res.rows.length) return socket.emit('join-error', 'Room not found');
      const room = res.rows[0];
      if (room.passcode && room.passcode !== (passcode || '')) return socket.emit('join-error', 'Wrong passcode');
      if (socket.roomId) leaveRoom(socket);

      socket.roomId = room.id;
      socket.join('room-' + room.id);
      if (!roomUsers[room.id]) roomUsers[room.id] = [];
      roomUsers[room.id] = roomUsers[room.id].filter(u => u.socketId !== socket.id);
      roomUsers[room.id].push({ socketId: socket.id, userId: me.id, userName: me.name, userColor: me.color });

      const msgs = await pool.query('SELECT * FROM messages WHERE room_id=$1 ORDER BY created_at ASC LIMIT 300', [room.id]);
      const users = roomUsers[room.id].map(u => ({ userId: u.userId, userName: u.userName, userColor: u.userColor }));

      socket.emit('room-joined', {
        id: room.id, code: room.code, name: room.name,
        messages: msgs.rows.map(m => ({ ...m, reactions: JSON.parse(m.reactions || '[]') })),
        users
      });

      const sys = await pool.query(
        'INSERT INTO messages (room_id,sender_id,sender_name,sender_color,text) VALUES ($1,$2,$3,$4,$5) RETURNING id,created_at',
        [room.id, '__sys__', '', '', `${me.name} joined the room`]
      );
      io.to('room-' + room.id).emit('new-message', {
        ...sys.rows[0], sender_id: '__sys__', sender_name: '', sender_color: '',
        text: `${me.name} joined the room`, reactions: [], image_data: null, reply_to: null, pinned: false, edited: false
      });
    } catch (e) { console.error(e); socket.emit('join-error', 'Failed to join'); }
  });

  socket.on('send-message', async ({ text, image, replyTo }) => {
    if (!socket.roomId || !rateLimit(socket.id, 30, 60000)) return;
    try {
      if (image && image.length > 800000) return socket.emit('error', 'Image too large');
      const res = await pool.query(
        `INSERT INTO messages (room_id,sender_id,sender_name,sender_color,text,image_data,reply_to) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [socket.roomId, me.id, me.name, me.color, (text || '').slice(0, 4000), image || null, replyTo || null]
      );
      io.to('room-' + socket.roomId).emit('new-message', { ...res.rows[0], reactions: [] });
    } catch (e) { console.error(e); socket.emit('error', 'Send failed'); }
  });

  socket.on('typing', () => { if (socket.roomId) socket.to('room-' + socket.roomId).emit('user-typing', { userName: me.name }); });

  socket.on('edit-message', async ({ messageId, text }) => {
    if (!socket.roomId) return;
    try {
      const r = await pool.query('UPDATE messages SET text=$1,edited=TRUE WHERE id=$2 AND room_id=$3 AND sender_id=$4 RETURNING id', [text.slice(0,4000), messageId, socket.roomId, me.id]);
      if (r.rows.length) io.to('room-' + socket.roomId).emit('message-edited', { id: messageId, text });
    } catch (e) { console.error(e); }
  });

  socket.on('delete-message', async ({ messageId }) => {
    if (!socket.roomId) return;
    try {
      const r = await pool.query('DELETE FROM messages WHERE id=$1 AND room_id=$2 AND sender_id=$3 RETURNING id', [messageId, socket.roomId, me.id]);
      if (r.rows.length) io.to('room-' + socket.roomId).emit('message-deleted', { id: messageId });
    } catch (e) { console.error(e); }
  });

  socket.on('toggle-reaction', async ({ messageId, emoji }) => {
    if (!socket.roomId) return;
    try {
      const r = await pool.query('SELECT reactions FROM messages WHERE id=$1 AND room_id=$2', [messageId, socket.roomId]);
      if (!r.rows.length) return;
      let reactions = JSON.parse(r.rows[0].reactions || '[]');
      const ex = reactions.find(x => x.emoji === emoji);
      if (ex) {
        if (ex.users.includes(me.id)) { ex.users = ex.users.filter(u => u !== me.id); if (!ex.users.length) reactions = reactions.filter(x => x.emoji !== emoji); }
        else ex.users.push(me.id);
      } else reactions.push({ emoji, users: [me.id] });
      await pool.query('UPDATE messages SET reactions=$1 WHERE id=$2', [JSON.stringify(reactions), messageId]);
      io.to('room-' + socket.roomId).emit('reaction-updated', { messageId, reactions });
    } catch (e) { console.error(e); }
  });

  socket.on('toggle-pin', async ({ messageId }) => {
    if (!socket.roomId) return;
    try {
      const r = await pool.query('UPDATE messages SET pinned=NOT pinned WHERE id=$1 AND room_id=$2 RETURNING pinned', [messageId, socket.roomId]);
      if (r.rows.length) io.to('room-' + socket.roomId).emit('pin-updated', { messageId, pinned: r.rows[0].pinned });
    } catch (e) { console.error(e); }
  });

  socket.on('disconnect', () => {
    if (socket.roomId && roomUsers[socket.roomId]) {
      const nm = me.name;
      roomUsers[socket.roomId] = roomUsers[socket.roomId].filter(u => u.socketId !== socket.id);
      socket.to('room-' + socket.roomId).emit('user-left', { userId: me.id, userName: nm });
      pool.query('INSERT INTO messages (room_id,sender_id,sender_name,sender_color,text) VALUES ($1,$2,$3,$4,$5)', [socket.roomId, '__sys__', '', '', `${nm} left`])
        .then(r => { if (r.rows.length) io.to('room-' + socket.roomId).emit('new-message', { ...r.rows[0], sender_id:'__sys__', sender_name:'', sender_color:'', text:`${nm} left`, reactions:[], image_data:null, reply_to:null, pinned:false, edited:false }); }).catch(()=>{});
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
  server.listen(PORT, '0.0.0.0', () => console.log(`✓ NexusChat running on port ${PORT}`));
}).catch(e => { console.error('Init failed:', e); process.exit(1); });

setInterval(() => pool.query('SELECT 1').catch(() => {}), 5 * 60 * 1000);
