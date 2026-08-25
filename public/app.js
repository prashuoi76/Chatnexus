const sid = localStorage.getItem("vybe_sid") || "";
const socket = io({ auth: { sessionId: sid }, transports: ["websocket", "polling"] });

const $ = id => document.getElementById(id);
const AV = ["🦊","🐼","👻","🐸","🦄","🐧","🐙","🦖","🐝","🌚","🍄","🔥","🌈","⚡","🍕","🎈","🪐","🧊","🐳","🦋"];
const EM = "😀😂🥹😍😎🤔😭😳🥶🤡💀👻🔥✨💖👀🙏👍🎉🎧🎮🍕🌙⭐🫠😤😴🤯🥳".split(/(?=[\s\S])/u).filter(Boolean);
const TAGS = ["music","gaming","anime","memes","art","sports","coding","movies","kpop","study"];

let me = { nick: "...", avatar: "👻", ghostId: "-----", interests: [] };
let rooms = [];
let pendingDm = null;
let squadCode = "";
let emoTarget = null;

const show = id => {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("show"));
  $(id).classList.add("show");
};
const toast = t => {
  const el = $("toast");
  el.textContent = t;
  el.classList.remove("hide");
  clearTimeout(window._tt);
  window._tt = setTimeout(() => el.classList.add("hide"), 2400);
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
const scroll = id => { const b = $(id); if (b) b.scrollTop = b.scrollHeight; };
const recents = () => JSON.parse(localStorage.getItem("vybe_squads") || "[]");
const saveRecent = code => {
  const a = [code, ...recents().filter(x => x !== code)].slice(0, 6);
  localStorage.setItem("vybe_squads", JSON.stringify(a));
  paintRecent();
};

$("agree").onchange = e => { $("enter").disabled = !e.target.checked; };
$("enter").onclick = () => { $("gate").classList.add("hide"); $("app").classList.remove("hide"); };

document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => go(b.dataset.go));
$("navMe").onclick = openMe;
$("meBtn").onclick = openMe;
$("leaveRoom").onclick = () => { socket.emit("leave"); go("home"); };
$("leaveSquad").onclick = () => { socket.emit("leave"); go("friends"); };
$("leaveDm").onclick = () => { socket.emit("leave"); go("friends"); };
$("leaveRandom").onclick = () => { socket.emit("random:stop"); go("home"); };

function go(name) {
  const map = { home: "home", rooms: "rooms", friends: "friends", random: "random" };
  if (map[name]) show(map[name]);
}

socket.on("hello", d => {
  me = { ...me, ...d.me };
  rooms = d.rooms;
  if (d.me.sessionId) localStorage.setItem("vybe_sid", d.me.sessionId);
  paintMe();
  paintRooms();
  paintChips();
  paintRecent();
  const q = new URLSearchParams(location.search);
  if (q.get("squad")) socket.emit("squad:join", q.get("squad"));
  if (q.get("u") && q.get("u") !== me.ghostId) socket.emit("dm:open", q.get("u"));
});
socket.on("me:updated", u => { me = { ...me, ...u }; paintMe(); paintChips(); });
socket.on("stats", s => {
  $("nOnline").textContent = s.online || 0;
  $("nChat").textContent = s.chatting || 0;
  rooms.forEach(r => {
    document.querySelectorAll(`[data-live="${r.id}"]`).forEach(el => {
      el.textContent = (s.rooms?.[r.id] || 0) + " here";
    });
  });
});
socket.on("toast", toast);
socket.on("warn", toast);

function paintMe() {
  $("topAv").textContent = me.avatar;
  $("topNick").textContent = me.nick;
  $("myId").textContent = me.ghostId;
  $("prevAv").textContent = me.avatar;
  $("prevNick").textContent = me.nick;
  $("prevId").textContent = me.ghostId;
}
function paintRooms() {
  const html = rooms.map(r => `
    <div class="rc" data-room="${r.id}">
      <span class="live" data-live="${r.id}">0 here</span>
      <div>${r.emoji}</div><b>${r.name}</b><small>${r.desc}</small>
    </div>`).join("");
  $("roomGrid").innerHTML = html;
  $("roomGrid2").innerHTML = html;
  document.querySelectorAll("[data-room]").forEach(el => {
    el.onclick = () => socket.emit("room:join", el.dataset.room);
  });
}
function paintChips() {
  $("chips").innerHTML = TAGS.map(t => `<button class="chip ${me.interests.includes(t) ? "on" : ""}" data-t="${t}">${t}</button>`).join("");
  $("chips").onclick = e => {
    const t = e.target.dataset.t;
    if (!t) return;
    me.interests = me.interests.includes(t) ? me.interests.filter(x => x !== t) : [...me.interests, t].slice(0, 5);
    socket.emit("me:update", { interests: me.interests });
    paintChips();
  };
}
function paintRecent() {
  $("recent").innerHTML = recents().map(c => `<button class="chip" data-c="${c}">${c}</button>`).join("") || "<span class='hint'>no recent squads</span>";
  $("recent").onclick = e => { if (e.target.dataset.c) socket.emit("squad:join", e.target.dataset.c); };
}
function paintAvs() {
  $("avs").innerHTML = AV.map(a => `<b class="${a === me.avatar ? "on" : ""}" data-a="${a}">${a}</b>`).join("");
  $("avs").onclick = e => {
    if (!e.target.dataset.a) return;
    me.avatar = e.target.dataset.a;
    paintAvs(); paintMe();
  };
}
function openMe() {
  $("nickIn").value = me.nick;
  $("intIn").value = (me.interests || []).join(", ");
  paintAvs(); paintMe();
  $("sheet").classList.remove("hide");
}
$("sheet").onclick = e => { if (e.target.id === "sheet") $("sheet").classList.add("hide"); };
$("reroll").onclick = () => socket.emit("me:reroll");
$("saveMe").onclick = () => {
  socket.emit("me:update", {
    nick: $("nickIn").value,
    avatar: me.avatar,
    interests: $("intIn").value.split(",").map(s => s.trim()).filter(Boolean)
  });
  $("sheet").classList.add("hide");
  toast("saved");
};

function addMsg(box, m, mine) {
  const d = document.createElement("div");
  d.className = "msg" + (mine ? " self" : "");
  const who = m.self || mine ? "you" : `${m.avatar || ""} ${esc(m.nick || "stranger")}`;
  d.innerHTML = `<div class="who">${who}</div><div class="bub">${esc(m.text)}</div>`;
  $(box).appendChild(d);
  scroll(box);
}
function addSys(box, text) {
  const d = document.createElement("div");
  d.className = "sys";
  d.textContent = text;
  $(box).appendChild(d);
  scroll(box);
}

socket.on("room:opened", ({ room, messages }) => {
  $("roomName").textContent = room.emoji + " " + room.name;
  $("roomMsgs").innerHTML = "";
  (messages || []).forEach(m => addMsg("roomMsgs", m, m.ghostId === me.ghostId));
  if (!messages?.length) addSys("roomMsgs", "you're early. say hi");
  show("roomChat");
});
socket.on("squad:ready", ({ code, url }) => modal("Squad ready", "share this code or link", code, url));
socket.on("squad:opened", ({ code, url, messages, members }) => {
  squadCode = code;
  saveRecent(code);
  $("squadName").textContent = "Squad " + code;
  $("squadMsgs").innerHTML = "";
  $("squadPeople").innerHTML = (members || []).map(m => `<span>${m.avatar} ${esc(m.nick)}</span>`).join("");
  (messages || []).forEach(m => addMsg("squadMsgs", m, m.ghostId === me.ghostId));
  if (!messages?.length) addSys("squadMsgs", "private squad. share " + code);
  $("shareSquad").onclick = () => modal("Invite friends", "anyone with the code can join", code, url);
  show("squadChat");
});
socket.on("squad:members", list => {
  $("squadPeople").innerHTML = (list || []).map(m => `<span>${m.avatar} ${esc(m.nick)}</span>`).join("");
  $("squadSub").textContent = (list || []).length + " here";
});
socket.on("dm:opened", ({ with: w, messages }) => {
  $("dmName").textContent = (w.avatar || "") + " " + w.nick;
  $("dmSub").textContent = w.ghostId;
  $("dmMsgs").innerHTML = "";
  (messages || []).forEach(m => addMsg("dmMsgs", m, m.ghostId === me.ghostId));
  show("dmChat");
});
socket.on("dm:incoming", ({ from, key }) => {
  pendingDm = key;
  $("incText").textContent = `${from.avatar} ${from.nick} (${from.ghostId}) wants to chat`;
  $("incoming").classList.remove("hide");
});
$("incYes").onclick = () => { socket.emit("dm:accept", pendingDm); $("incoming").classList.add("hide"); };
$("incNo").onclick = () => { pendingDm = null; $("incoming").classList.add("hide"); };

socket.on("chat", ({ scope, msg }) => {
  const map = { room: "roomMsgs", squad: "squadMsgs", dm: "dmMsgs", random: "ranMsgs" };
  if (scope === "random") return addMsg("ranMsgs", msg, !!msg.self);
  addMsg(map[scope], msg, msg.ghostId === me.ghostId);
});
socket.on("sys", ({ scope, text }) => {
  const map = { room: "roomMsgs", squad: "squadMsgs", dm: "dmMsgs", random: "ranMsgs" };
  if (map[scope]) addSys(map[scope], text);
});
socket.on("typing", ({ scope, nick, on }) => {
  const map = { room: "roomType", squad: "squadType", dm: "dmType", random: "ranType" };
  if (map[scope]) $(map[scope]).textContent = on ? `${nick || "stranger"} is typing…` : "";
});

$("roomForm").onsubmit = e => { e.preventDefault(); send("room:msg", "roomIn"); };
$("squadMsgForm").onsubmit = e => { e.preventDefault(); send("squad:msg", "squadMsgIn"); };
$("dmMsgForm").onsubmit = e => { e.preventDefault(); send("dm:msg", "dmMsgIn"); };
$("ranForm").onsubmit = e => { e.preventDefault(); send("random:msg", "ranIn"); };
function send(ev, id) {
  const v = $(id).value.trim();
  if (!v) return;
  socket.emit(ev, v);
  $(id).value = "";
}
["roomIn","squadMsgIn","dmMsgIn","ranIn"].forEach(id => {
  const ev = id.startsWith("room") ? "room:typing" : id.startsWith("squad") ? "squad:typing" : id.startsWith("dm") ? "dm:typing" : "random:typing";
  $(id).addEventListener("input", () => {
    socket.emit(ev, true);
    clearTimeout($(id)._t);
    $(id)._t = setTimeout(() => socket.emit(ev, false), 800);
  });
});

$("copyId").onclick = () => navigator.clipboard.writeText(me.ghostId).then(() => toast("ghost id copied"));
$("dmForm").onsubmit = e => {
  e.preventDefault();
  socket.emit("lookup", $("dmId").value);
  socket.emit("dm:open", $("dmId").value);
};
socket.on("lookup:result", r => {
  $("lookupBox").textContent = r.ok ? `online: ${r.user.avatar} ${r.user.nick}` : "not online right now";
});
$("makeSquad").onclick = () => socket.emit("squad:create");
$("squadForm").onsubmit = e => { e.preventDefault(); socket.emit("squad:join", $("squadIn").value); };

$("findBtn").onclick = startRandom;
$("nextBtn").onclick = () => { socket.emit("random:next"); searching(); };
$("stopBtn").onclick = () => { socket.emit("random:stop"); go("home"); };
$("blockBtn").onclick = () => socket.emit("block");
function startRandom() {
  searching();
  socket.emit("random:start");
}
function searching() {
  $("ranMsgs").innerHTML = `<div class="empty"><h3>searching…</h3><p>hold on</p></div>`;
  $("ranBar").classList.remove("hide");
  $("ranSub").textContent = "searching";
}
socket.on("random:waiting", ({ n }) => { $("ranSub").textContent = `waiting · ${n} in queue`; });
socket.on("random:matched", ({ partner, shared }) => {
  $("ranName").textContent = `${partner.avatar} ${partner.nick}`;
  $("ranSub").textContent = shared?.length ? "shares " + shared.join(", ") : partner.ghostId;
  $("ranMsgs").innerHTML = "";
  addSys("ranMsgs", "connected. don't share personal info");
  $("ranForm").classList.remove("hide");
  $("ranBar").classList.remove("hide");
});
socket.on("random:ended", ({ reason }) => {
  addSys("ranMsgs", "ended · " + reason);
  $("ranForm").classList.add("hide");
  $("ranSub").textContent = "not connected";
});

document.querySelectorAll("[data-report]").forEach(b => b.onclick = () => {
  const reason = prompt("what happened?");
  if (reason) socket.emit("report", { reason, context: b.dataset.report });
});

function modal(title, text, code, url) {
  $("modalTitle").textContent = title;
  $("modalText").textContent = text + (url ? "\n" + url : "");
  $("modalCode").textContent = code || url || "";
  $("modalCopy").onclick = () => navigator.clipboard.writeText(url || code).then(() => toast("copied"));
  $("modal").classList.remove("hide");
}
$("modalClose").onclick = () => $("modal").classList.add("hide");
$("modal").onclick = e => { if (e.target.id === "modal") $("modal").classList.add("hide"); };

document.addEventListener("click", e => {
  const b = e.target.closest(".emo");
  const pop = $("emoPop");
  if (b) {
    emoTarget = b.dataset.in;
    if (!pop.dataset.ok) {
      EM.forEach(x => {
        const s = document.createElement("span");
        s.textContent = x;
        s.onclick = () => { $(emoTarget).value += x; $(emoTarget).focus(); };
        pop.appendChild(s);
      });
      pop.dataset.ok = "1";
    }
    pop.classList.toggle("hide");
  } else if (!e.target.closest(".emo-pop")) pop.classList.add("hide");
});
