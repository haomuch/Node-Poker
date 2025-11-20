const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

//app.use(express.static(__dirname));//把网站音频文件替换为下面的长期缓存策略
app.use('/media', express.static(__dirname + '/media', {
  setHeaders: (res, path) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    // 可选：强制 MIME 类型
    if (path.endsWith('.m4a')) {
      res.setHeader('Content-Type', 'audio/mp4');
    } else if (path.endsWith('.png')) {
      // 新增：明确设置 .png 的 Content-Type
      res.setHeader('Content-Type', 'image/png');
    }
    // 可选：强制缓存策略
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// ---------------- 静态文件服务和缓存配置 ----------------
app.use(express.static(__dirname, {
  setHeaders: (res, path) => {
    // 检查路径是否在 /media 目录下（可选，但更安全）
    if (!path.includes('/media')) {
      // 24小时 = 86400秒
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
    // 如果是 /media 文件，这个中间件会因为没有 path 匹配而跳过，或者直接由下面的 /media 中间件处理。
    // 为了确保 index.html, client.js 等得到缓存，此配置是必要的。
  }
}));

const PORT = 3000;
server.listen(PORT, () => console.log(`Poker server running at http://0.0.0.0:${PORT}`));

// ---------------- Sound Types ----------------
const SOUND_TYPES = {
  FOLD: 'fold',
  CHECK: 'check',
  BET: 'bet', // 用于 call、raise、all-in
  WIN: 'win',
  DEAL: 'deal' // 新增：发牌音效
};

// 自定义 UUID v4 生成器（避免依赖外部模块）
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ---------------- CONFIG ----------------
const MAX_PLAYERS = 6;
const STARTING_STACK = 2000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const DEFAULT_REBUY_BB = 100;
const ROOM_INACTIVE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

const SUITS = ["S", "H", "D", "C"]; // internal suits
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_VAL = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));

// ---------------- UTIL ----------------
function newDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function combos(arr, k) {
  const out = [];
  (function rec(st, cur) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    for (let i = st; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
  })(0, []);
  return out;
}
function cardRank(c) { return RANK_VAL[c.r]; }
function cardSuit(c) { return c.s; }

// Evaluate 5 cards (return array rank descriptor), and helpers
function eval5(cards) {
  const vals = cards.map(cardRank).sort((a, b) => b - a);
  const suits = cards.map(cardSuit);
  const counts = {};
  vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const byCount = Object.entries(counts).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (+b[0]) - (+a[0]);
  });
  const isFlush = suits.every(s => s === suits[0]);

  const uniq = [...new Set(vals)].sort((a, b) => b - a);
  let isStraight = false, highStraight = 0;
  for (let i = 0; i <= uniq.length - 5; i++) {
    if (uniq[i] - 1 === uniq[i + 1] && uniq[i + 1] - 1 === uniq[i + 2] && uniq[i + 2] - 1 === uniq[i + 3] && uniq[i + 3] - 1 === uniq[i + 4]) {
      isStraight = true; highStraight = uniq[i]; break;
    }
  }
  // A-5 wheel
  if (!isStraight && uniq.includes(14) && uniq.includes(5) && uniq.includes(4) && uniq.includes(3) && uniq.includes(2)) {
    isStraight = true; highStraight = 5;
  }

  if (isFlush && isStraight) return [8, highStraight];
  if (byCount[0] && byCount[0][1] === 4) {
    const q = +byCount[0][0];
    const kicker = Math.max(...vals.filter(v => v !== q));
    return [7, q, kicker];
  }
  if (byCount[0] && byCount[0][1] === 3 && byCount[1] && byCount[1][1] === 2) return [6, +byCount[0][0], +byCount[1][0]];
  if (isFlush) return [5, ...vals];
  if (isStraight) return [4, highStraight];
  if (byCount[0] && byCount[0][1] === 3) {
    const trips = +byCount[0][0];
    const ks = vals.filter(v => v !== trips).slice(0, 2);
    return [3, trips, ...ks];
  }
  if (byCount[0] && byCount[0][1] === 2 && byCount[1] && byCount[1][1] === 2) {
    const ph = Math.max(+byCount[0][0], +byCount[1][0]);
    const pl = Math.min(+byCount[0][0], +byCount[1][0]);
    const k = Math.max(...vals.filter(v => v !== ph && v !== pl));
    return [2, ph, pl, k];
  }
  if (byCount[0] && byCount[0][1] === 2) {
    const p = +byCount[0][0];
    const ks = vals.filter(v => v !== p).slice(0, 3);
    return [1, p, ...ks];
  }
  return [0, ...vals];
}
function cmpRank(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? -1, bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}
function bestOf7(cards7) {
  let best = null;
  for (const five of combos(cards7, 5)) {
    const r = eval5(five);
    if (!best || cmpRank(r, best) > 0) best = r;
  }
  return best;
}

// ---------------- Room Management ----------------
const rooms = {}; // room -> table

function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms[code]);
  return code;
}

function createTable(roomCode) {
  const table = {
    players: [],
    deck: [],
    community: [],
    dealerSeat: -1,
    state: "waiting",
    currentToAct: null,
    highestBet: 0,
    lastRaiseSize: BIG_BLIND,
    handId: 0,
    sidePots: [],
    pendingNext: null,
    rebuyPending: new Set(),
    _forceRevealMap: false,
    pendingActors: [],
    lastActive: Date.now(),
    roomCode: roomCode,
    // 回合倒计时（统一20秒）
    turnTimer: null,
    turnDeadline: null
  };
  rooms[roomCode] = table;
  console.log(`Room created: ${roomCode}`);
  return table;
}

function cleanupInactiveRooms() {
  for (const roomCode in rooms) {
    const table = rooms[roomCode];
    const connectedPlayers = table.players.filter(p => p.connected).length;
    if (connectedPlayers === 0 && (Date.now() - table.lastActive > ROOM_INACTIVE_TIMEOUT)) {
      console.log(`Closing inactive room: ${roomCode}`);
      if (table.pendingNext) { clearTimeout(table.pendingNext); table.pendingNext = null; }
      // 清除回合倒计时（避免残留 setTimeout）
      if (table.turnTimer) { clearTimeout(table.turnTimer); table.turnTimer = null; }
      // 若有其他 timers（未来扩展）也在此清理...
      delete rooms[roomCode];
    }
  }
}
// Run cleanup every minute
setInterval(cleanupInactiveRooms, 60 * 1000);

// ---------------- Per-room state and logic ----------------
// 修复：getPlayerState 支持通过 playerId 或 socket.id 查找
function getPlayerState(socket) {
  for (const roomCode in rooms) {
    const table = rooms[roomCode];
    // 先用 playerId，再用 socket.id
    const player = table.players.find(p => p.playerId === socket.playerId || p.id === socket.id);
    if (player) return { table, player };
  }
  return { table: null, player: null };
}

// Player shape:
// { id, playerId, name, seat, chips, connected, waiting, inHand, folded, allIn, hole:[], betThisStreet, totalCommitted, lastAction, lastAmount, hasActed, reveal }

// ---------------- Helpers ----------------
function connectedSeatsSet(table) { return new Set(table.players.filter(p => p.connected).map(p => p.seat)); }
function nextFreeSeatForConnected(table) { const used = connectedSeatsSet(table); for (let s = 0; s < MAX_PLAYERS; s++) if (!used.has(s)) return s; return -1; }
function pById(table, id) { return table.players.find(p => p.id === id); }
function pIdx(table, id) { return table.players.findIndex(p => p.id === id); }
function nextSeatFrom(table, seat, pred) {
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    const s = (seat + i) % MAX_PLAYERS;
    const p = table.players.find(pp => pp.seat === s && pred(pp));
    if (p) return p;
  }
  return null;
}
function inHandPlayers(table) { return table.players.filter(p => p.inHand && !p.folded); }
function activePlayersCanAct(table) { return table.players.filter(p => p.inHand && !p.folded && !p.allIn); }
function potTotal(table) { return table.players.reduce((s, p) => s + (p.totalCommitted || 0), 0); }

// --- 新增：pending 队列工具 ---
// 修复：pendingActors 存 playerId
function buildPendingFrom(table, startSeat) {
  const list = [];
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    const s = (startSeat + i) % MAX_PLAYERS;
    const p = table.players.find(pp => pp.seat === s && pp.inHand && !pp.folded && !pp.allIn);
    if (p) list.push(p.playerId); // 用 playerId
  }
  return list;
}
function resetPendingAfterAggressor(table, aggPlayerId) {
  const aggr = table.players.find(p => p.playerId === aggPlayerId);
  if (!aggr) return;
  table.pendingActors = buildPendingFrom(table, aggr.seat).filter(pid => pid !== aggPlayerId);
}
function initPendingForStreet(table, firstToAct) {
  if (!firstToAct) { table.pendingActors = []; return; }
  table.pendingActors = buildPendingFrom(table, firstToAct.seat);
}
function removeFromPending(table, playerId) {
  table.pendingActors = table.pendingActors.filter(pid => pid !== playerId);
}
function nextPendingAfter(table, seat) {
  if (!table.pendingActors.length) return null;
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    const s = (seat + i) % MAX_PLAYERS;
    const p = table.players.find(pp => pp.seat === s);
    if (p && table.pendingActors.includes(p.playerId)) return p;
  }
  // fallback
  const head = table.players.find(p => p.playerId === table.pendingActors[0]);
  return head || null;
}

// 新增 autoAct 函数（放在 helpers 后）
function autoAct(table, player) {
  if (!player.inHand || player.folded || player.allIn) return;

  const toCall = Math.max(0, (table.highestBet || 0) - (player.betThisStreet || 0));
  let soundType = null;  // 新增：声明 soundType
  player.hasActed = true;
  removeFromPending(table, player.playerId); // 修正

  if (toCall === 0) {
    // 自动过牌
    player.lastAction = "Check (auto)";
    player.lastAmount = 0;
    soundType = SOUND_TYPES.CHECK;  // 新增：赋值
  } else {
    // 自动弃牌
    player.folded = true;
    player.lastAction = "Fold (auto)";
    player.lastAmount = 0;
    soundType = SOUND_TYPES.FOLD;  // 新增：赋值
  }
  const aliveAfter = inHandPlayers(table);
  if (aliveAfter.length === 1) {
    clearTurnTimer(table);
    endHandSingleWinner(table, aliveAfter[0]);
    return;
  }

  // 广播音效
  if (soundType) {
    io.to(table.roomCode).emit("play_sound", { type: soundType, playerId: player.playerId });
  }

  table.sidePots = buildPotsFromCommitted(table); // 重新计算边池
  broadcastState(table);

  // 推进到下一个
  const next = nextPendingAfter(table, player.seat) || findNextActorFromSeat(table, player.seat);
  if (next) {
    table.currentToAct = next.playerId; // 修正
    broadcastState(table);
  } else {
    proceedAfterBetting(table);
  }
}

// 新增：统一回合倒计时控制
function clearTurnTimer(table) {
  if (table.turnTimer) {
    clearTimeout(table.turnTimer);
    table.turnTimer = null;
  }
  table.turnDeadline = null;
}

function startTurnTimer(table, player) {
  // 每次轮到某玩家行动时，启动/重置20秒倒计时
  clearTurnTimer(table);
  if (!player) return;
  table.turnDeadline = Date.now() + 20000;
  table.turnTimer = setTimeout(() => autoTimeoutAct(table, player), 20000);
  // 广播以便前端显示剩余时间
  broadcastState(table);
}

function autoTimeoutAct(table, player) {
  // 到这一步前先确认该玩家仍是当前行动者
  if (table.currentToAct !== player.playerId) return;
  // 倒计时结束后的自动行动（不区分是否断线）：有跟注额则弃牌，否则过牌
  if (!player || !player.inHand || player.folded || player.allIn) return;

  // 执行动作
  const toCall = Math.max(0, (table.highestBet || 0) - (player.betThisStreet || 0));
  let soundType = null;  // 新增：声明 soundType
  player.hasActed = true;
  removeFromPending(table, player.playerId);
  if (toCall === 0) {
    player.lastAction = "Check (auto)";
    player.lastAmount = 0;
    soundType = SOUND_TYPES.CHECK;  // 新增：赋值
  } else {
    player.folded = true;
    player.lastAction = "Fold (auto)";
    player.lastAmount = 0;
    soundType = SOUND_TYPES.FOLD;  // 新增：赋值
  }
  const aliveAfter = inHandPlayers(table);
  if (aliveAfter.length === 1) {
    clearTurnTimer(table);
    endHandSingleWinner(table, aliveAfter[0]);
    return;
  }

  // 广播音效
  if (soundType) {
    io.to(table.roomCode).emit("play_sound", { type: soundType, playerId: player.playerId });
  }

  table.sidePots = buildPotsFromCommitted(table);
  clearTurnTimer(table);
  broadcastState(table);

  // 推进到下一个玩家或到下一条街
  const next = nextPendingAfter(table, player.seat) || findNextActorFromSeat(table, player.seat);
  if (next) {
    table.currentToAct = next.playerId;
    startTurnTimer(table, next);
    broadcastState(table);
  } else {
    proceedAfterBetting(table);
  }
}

// ---------------- Broadcasters ----------------
function broadcastState(table) {
  table.lastActive = Date.now();

  const playersForBroadcast = table.players.map(p => {
    let potentialWinnings = 0;
    if (table.sidePots) {
      for (const sp of table.sidePots) {
        if (sp.eligibles.has(p.playerId)) {
          potentialWinnings += sp.amount;
        }
      }
    }
    const base = {
      id: p.id, playerId: p.playerId, name: p.name, seat: p.seat, chips: p.chips,
      connected: p.connected, waiting: p.waiting, inHand: p.inHand,
      folded: p.folded, allIn: p.allIn, lastAction: p.lastAction, lastAmount: p.lastAmount,
      betThisStreet: p.betThisStreet, totalCommitted: p.totalCommitted, reveal: p.reveal || false,
      potentialWinnings: potentialWinnings
    };
    if (table.state === "showdown") base.hole = p.hole || [];
    return base;
  });

  const pub = {
    players: playersForBroadcast,
    community: table.community,
    dealerSeat: table.dealerSeat,
    state: table.state,
    currentToAct: table.currentToAct, // 现在是playerId
    highestBet: table.highestBet,
    lastRaiseSize: table.lastRaiseSize,
    handId: table.handId,
    potTotal: potTotal(table),
    actDeadline: table.turnDeadline || null,
    // 新增：记录服务器发送状态时的当前时间戳
    serverTimestamp: Date.now()
  };

  io.to(table.roomCode).emit("state", pub);

  // private hole to each player
  for (const p of table.players) io.to(p.id).emit("hole", p.inHand ? (p.hole || []) : []);

  // explicit reveal when showdown or forced
  if (table.state === "showdown" || table._forceRevealMap) {
    const reveal = {};
    for (const p of table.players) if (!p.folded) reveal[p.playerId] = p.hole || [];
    io.to(table.roomCode).emit("showdown_holes", reveal);
    if (table._forceRevealMap) table._forceRevealMap = false;
  }

  updateActionOptions(table);
}

function updateActionOptions(table) {
  for (const p of table.players) {
    if (!p.inHand || p.folded || p.allIn || table.state === "waiting" || table.state === "showdown") {
      io.to(p.id).emit("actions", { yourTurn: false });
      continue;
    }
    const yourTurn = (table.currentToAct === p.playerId);
    const toCall = Math.max(0, (table.highestBet || 0) - (p.betThisStreet || 0));
    const canCheck = (toCall === 0);
    const others = table.players.filter(o => o.playerId !== p.playerId && o.inHand && !o.folded);
    const minRaiseSize = (table.highestBet || 0) + (table.lastRaiseSize || BIG_BLIND) - (p.betThisStreet || 0);
    const minRaiseTo = table.highestBet === 0 ? BIG_BLIND : table.highestBet + minRaiseSize;
    const maxRaiseSize = p.chips;
    const maxRaiseTo = (table.highestBet || 0) + maxRaiseSize;
    io.to(p.id).emit("actions", {
      yourTurn, canCheck, canCall: toCall > 0 && p.chips > 0, canFold: true,
      toCall, minRaiseSize, minRaiseTo, maxRaiseTo, maxRaiseSize, chips: p.chips, state: table.state
    });
  }
}

// ---------------- Pot / sidepot ----------------
function buildPotsFromCommitted(table) {
  const contrib = table.players.filter(p => p.inHand).map(p => ({ playerId: p.playerId, amt: p.totalCommitted || 0, folded: p.folded }));
  const pots = [];
  while (true) {
    const positive = contrib.filter(c => c.amt > 0);
    if (positive.length === 0) break;
    const min = Math.min(...positive.map(c => c.amt));
    const contributors = contrib.filter(c => c.amt > 0);
    const amount = min * contributors.length;
    const eligibles = new Set(contributors.filter(c => !table.players.find(p => p.playerId === c.playerId).folded).map(c => c.playerId));
    pots.push({ amount, eligibles });
    for (const c of contrib) if (c.amt > 0) c.amt -= min;
  }
  return pots;
}

// ---------------- Betting helper (original + pending 修复) ----------------
function playersWhoNeedAction(table) {
  return table.players.filter(p => p.inHand && !p.folded && !p.allIn && ((p.betThisStreet || 0) !== (table.highestBet || 0) || !p.hasActed));
}
function findNextActorFromSeat(table, seat) {
  // 先从 pendingActors 中选（修复：确保 raise/all-in 后不会跳过后续玩家）
  const pendingNext = nextPendingAfter(table, seat);
  if (pendingNext) return pendingNext;

  // 兼容：保持原有回退逻辑
  const need = playersWhoNeedAction(table);
  if (need.length === 0) return null;
  for (let i = 1; i <= MAX_PLAYERS; i++) {
    const s = (seat + i) % MAX_PLAYERS;
    const p = table.players.find(pp => pp.seat === s);
    if (!p) continue;
    if (need.some(n => n.playerId === p.playerId)) return p; // 修正
  }
  return need[0];
}

// ---------------- Progression: after betting ----------------
function proceedAfterBetting(table) {
  // Clear currentToAct and pendingActors to stop frontend from showing "acting" state and timer
  table.currentToAct = null;
  table.pendingActors = [];
  clearTurnTimer(table);
  broadcastState(table); // Broadcast state immediately to update frontend

  // Add a 1.5-second delay before proceeding to the next street
  setTimeout(() => {
    const alive = inHandPlayers(table);
    if (alive.length === 1) {
      clearTurnTimer(table);
      endHandSingleWinner(table, alive[0]);
      return;
    }

    // nobody can act -> run out all cards and showdown
    if (activePlayersCanAct(table).length === 0) {
      runOutToShowdown(table);
      return;
    } else if (activePlayersCanAct(table).length === 1 && alive.length > 1) {
      runOutToShowdown(table);
      return;
    }


    // clear per-street variables
    for (const p of table.players) {
      p.betThisStreet = 0;
      p.hasActed = false;
      // 新增：清除玩家上条街的lastAction和lastAmount（如果他们没有All-in或者Fold）
      if (!p.allIn && !p.folded) {
        p.lastAction = null;
        p.lastAmount = 0;
      }
    }
    table.highestBet = 0;

    // Bug Fix: Reset side pots for the new betting street
    table.sidePots = [];

    // 重置本街 pendingActors
    let first = null;

    if (table.state === "preflop") {
      table.community.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
      table.state = "flop";
      table.lastRaiseSize = BIG_BLIND; // <--- 新增
      first = nextSeatFrom(table, table.dealerSeat, p => p.inHand && !p.folded && !p.allIn);
      // Broadcast deal sound for flop
      io.to(table.roomCode).emit("play_sound", { type: SOUND_TYPES.DEAL });
    } else if (table.state === "flop") {
      table.community.push(table.deck.pop());
      table.state = "turn";
      table.lastRaiseSize = BIG_BLIND; // <--- 新增
      first = nextSeatFrom(table, table.dealerSeat, p => p.inHand && !p.folded && !p.allIn);
      // Broadcast deal sound for turn
      io.to(table.roomCode).emit("play_sound", { type: SOUND_TYPES.DEAL });
    } else if (table.state === "turn") {
      table.community.push(table.deck.pop());
      table.state = "river";
      table.lastRaiseSize = BIG_BLIND; // <--- 新增
      first = nextSeatFrom(table, table.dealerSeat, p => p.inHand && !p.folded && !p.allIn);
      // Broadcast deal sound for river
      io.to(table.roomCode).emit("play_sound", { type: SOUND_TYPES.DEAL });
    } else if (table.state === "river") {
      goShowdown(table);
      return;
    }

    // BUG FIX: Recalculate side pots after dealing community cards for a new street
    table.sidePots = buildPotsFromCommitted(table);

    initPendingForStreet(table, first || { seat: table.dealerSeat }); // 空也容错
    table.currentToAct = first ? first.playerId : null; // 修正：用playerId

    // 轮到 first 时，启动20秒倒计时
    if (first) { startTurnTimer(table, first); }

    broadcastState(table);
  }, 1500); // 1.5-second delay
}

// run out remaining community cards then showdown
function runOutToShowdown(table) {
  while (table.community.length < 5) table.community.push(table.deck.pop());
  goShowdown(table);
}

// schedule next hand after a delay
function ensureNextHand(table) {
  if (table.pendingNext) return;
  table.pendingNext = setTimeout(() => {
    table.pendingNext = null;
    tryStartHand(table);
  }, 5000);
}

// ---------------- Showdown & settlement ----------------
function goShowdown(table) {
  clearTurnTimer(table);
  table.state = "showdown";
  // 防止前端继续显示行动中效果
  table.currentToAct = null;
  table.pendingActors = [];
  while (table.community.length < 5) table.community.push(table.deck.pop());

  // 1. Identify all players who contributed chips (including folded)
  const contributors = table.players.filter(p => p.totalCommitted > 0);

  // 2. Identify players still in hand (contestants)
  const contestants = table.players.filter(p => p.inHand && !p.folded);

  // 3. Calculate ranks ONLY for contestants
  const ranks = {};
  for (const p of contestants) {
    ranks[p.playerId] = bestOf7([...(p.hole || []), ...table.community]);
  }

  // 4. Prepare contribution list sorted by amount
  const playerContributions = contributors.map(p => ({
    playerId: p.playerId,
    committed: p.totalCommitted,
    chips: p.chips,
    seat: p.seat,
    folded: p.folded,
    rank: !p.folded ? ranks[p.playerId] : null
  })).sort((a, b) => a.committed - b.committed);

  // 5. Build pots and distribute
  const pots = [];
  let processedCommitment = 0;

  // 用于记录每个玩家的赢得金额
  const winningAmounts = new Map();
  table.players.forEach(p => winningAmounts.set(p.playerId, 0));

  let lastPotWinners = []; // Track winners of the previous pot level to handle dead money

  for (let i = 0; i < playerContributions.length; i++) {
    const currentLevel = playerContributions[i].committed - processedCommitment;
    if (currentLevel <= 0) continue;

    const levelContributors = playerContributions.slice(i);
    const potSize = currentLevel * levelContributors.length;

    // Eligible winners are those who haven't folded
    const eligibleWinners = levelContributors.filter(p => !p.folded);

    let potWinners = [];

    if (eligibleWinners.length > 0) {
      // Determine winners among eligible
      let bestRank = null;
      for (const eligible of eligibleWinners) {
        const r = eligible.rank;
        if (!bestRank || cmpRank(r, bestRank) > 0) {
          bestRank = r;
          potWinners = [eligible];
        } else if (cmpRank(r, bestRank) === 0) {
          potWinners.push(eligible);
        }
      }
      lastPotWinners = potWinners; // Update last winners

      // 广播赢家音效
      io.to(table.roomCode).emit("play_sound", { type: SOUND_TYPES.WIN, playerIds: potWinners.map(w => w.playerId) });

      pots.push({
        amount: potSize,
        eligibles: new Set(eligibleWinners.map(p => p.playerId)),
        winners: potWinners.map(p => p.playerId)
      });
    } else {
      // No eligible winners at this level (everyone folded)
      // Distribute to winners of the previous pot (dead money)
      potWinners = lastPotWinners;
    }

    // Distribute money
    if (potWinners.length > 0) {
      const share = Math.floor(potSize / potWinners.length);
      for (const w of potWinners) {
        winningAmounts.set(w.playerId, winningAmounts.get(w.playerId) + share);
      }
      const rem = potSize - share * potWinners.length;
      if (rem > 0) {
        // Sort by seat to ensure deterministic distribution of remainder
        potWinners.sort((a, b) => a.seat - b.seat);
        winningAmounts.set(potWinners[0].playerId, winningAmounts.get(potWinners[0].playerId) + rem);
      }
    }

    processedCommitment += currentLevel;
  }

  // 6. 将筹码加到玩家的账户并设置 lastAction
  for (const p of table.players) {
    const wonAmount = winningAmounts.get(p.playerId) || 0;

    // 检查超额下注返还 (Should be 0 if logic above is correct, but kept for safety)
    const committedAmount = p.totalCommitted || 0;
    const refund = (committedAmount > processedCommitment) ? committedAmount - processedCommitment : 0;

    p.chips += wonAmount + refund;
    p.lastAmount = wonAmount;

    if (wonAmount > 0) {
      p.lastAction = "WIN";
    }
    else if (p.allIn) {
      p.lastAction = "All-In";
    }
    else {
      p.lastAction = p.folded ? "Fold" : null;
    }

    p.totalCommitted = 0;
    p.betThisStreet = 0;
  }

  // 揭示手牌
  for (const p of table.players) {
    if (!p.folded) {
      p.reveal = true;
    }
  }

  table.pot = 0;
  table.sidePots = pots;
  broadcastState(table);

  setTimeout(() => {
    requestRebuysAndNext(table);
  }, 3000);
}

// 新增功能：当只剩一名玩家未弃牌时，结束本局并判定其获胜
function endHandSingleWinner(table, winner) {
  clearTurnTimer(table);
  console.log(`Hand over: ${winner.name} wins by being the last player in the hand.`);
  const totalPot = potTotal(table);
  winner.chips += totalPot;
  winner.lastAction = "WIN";
  winner.lastAmount = totalPot;

  for (const p of table.players) {
    p.totalCommitted = 0;
    p.betThisStreet = 0;
    if (p.id !== winner.id) {
      p.inHand = false;
      p.folded = true;
      p.hole = [];
      p.reveal = false;
    }
  }
  // 广播单赢家音效
  io.to(table.roomCode).emit("play_sound", { type: SOUND_TYPES.WIN, playerId: winner.playerId });

  table.state = "waiting";
  table.currentToAct = null;
  table.pendingActors = [];
  table.sidePots = []; // Fix: Reset side pots after the hand ends.

  broadcastState(table);
  requestRebuysAndNext(table);
}

// ---------------- Rebuy: reveal survivors first ----------------
function requestRebuysAndNext(table) {
  table.rebuyPending = new Set();
  const need = table.players.filter(p => p.connected && p.chips <= 0); // 1. 如果没有人需要重买，直接安排下一局并返回 
  if (need.length === 0) { ensureNextHand(table); return; } // 2. 关键修改：检查是否有足够的非输光玩家来开始下一局 
  const readyToPlay = table.players.filter(p => p.connected && p.chips > 0).length; if (readyToPlay >= 2) { ensureNextHand(table); }

  // force reveal map once (clients will show survivors' hands)
  table._forceRevealMap = true;
  broadcastState(table);

  const amount = DEFAULT_REBUY_BB * BIG_BLIND;
  for (const p of need) {
    table.rebuyPending.add(p.playerId);
    p.waiting = true;
    io.to(p.id).emit("rebuy_request", { amount });
  }
}

// ---------------- Start hand (blinds & deal) ----------------
function tryStartHand(table) {
  if (table.state !== "waiting" && table.state !== "showdown") return;

  // ready: connected players with chips > 0 (not in rebuyPending)
  const ready = table.players.filter(p => p.connected && p.chips > 0 && !table.rebuyPending.has(p.playerId));
  if (ready.length < 2) return;

  table.deck = newDeck();
  table.community = [];
  table.sidePots = [];
  table.state = "preflop";
  table.handId++;
  table.highestBet = 0;
  table.lastRaiseSize = BIG_BLIND;
  table.pendingActors = []; // reset queue

  // rotate dealer
  if (table.dealerSeat < 0) table.dealerSeat = ready[0].seat;
  else {
    const nd = nextSeatFrom(table, table.dealerSeat, p => p.connected && p.chips > 0 && !table.rebuyPending.has(p.playerId)); // 修改：用 playerId
    if (nd) table.dealerSeat = nd.seat;
  }

  // initialize players; reset reveal flag
  for (const p of table.players) {
    // 使用 playerId 检查 rebuyPending
    if (p.connected && p.chips > 0 && !table.rebuyPending.has(p.playerId)) {
      p.inHand = true; p.folded = false; p.allIn = false; p.hole = []; p.betThisStreet = 0; p.totalCommitted = 0;
      p.hasActed = false; p.lastAction = null; p.lastAmount = 0; p.reveal = false;
    } else {
      p.inHand = false; p.folded = true; p.hole = []; p.reveal = false;
    }
  }

  // post blinds
  const sb = nextSeatFrom(table, table.dealerSeat, p => p.inHand && p.chips > 0);
  const bb = nextSeatFrom(table, sb.seat, p => p.inHand && p.chips > 0);
  function postBlind(pl, amt, label) {
    if (!pl) return;
    const pay = Math.min(pl.chips, amt);
    pl.chips -= pay;
    pl.betThisStreet = (pl.betThisStreet || 0) + pay;
    pl.totalCommitted = (pl.totalCommitted || 0) + pay;
    pl.lastAction = label; pl.lastAmount = pay;
    if (pl.chips === 0) pl.allIn = true;
    table.highestBet = Math.max(table.highestBet || 0, pl.betThisStreet);
  }
  postBlind(sb, SMALL_BLIND, "SB");
  postBlind(bb, BIG_BLIND, "BB");

  // deal two hole cards
  for (let r = 0; r < 2; r++) {
    for (const p of table.players.filter(x => x.inHand)) p.hole.push(table.deck.pop());
  }

  // Bug Fix: Calculate side pots after blinds are posted
  table.sidePots = buildPotsFromCommitted(table);

  // first to act is seat after BB
  const first = nextSeatFrom(table, bb.seat, p => p.inHand && !p.folded && !p.allIn);
  table.currentToAct = first ? first.playerId : null; // 修正：用playerId

  // 初始化本街的 pending 队列（从第一行动者开始，按座位序收集后续所有可行动玩家）
  initPendingForStreet(table, first || { seat: bb.seat });

  // 轮到 first，启动20秒倒计时
  if (first) { startTurnTimer(table, first); }

  broadcastState(table);
}

// ---------------- Socket handlers ----------------
io.on("connection", socket => {
  console.log("conn:", socket.id);

  socket.on("createRoom", ({ name }) => {
    const roomCode = generateRoomCode();
    const table = createTable(roomCode);
    const freeSeat = nextFreeSeatForConnected(table);

    if (freeSeat === -1) {
      socket.emit("rejected", "Table full");
      delete rooms[roomCode];
      return;
    }

    socket.join(roomCode);
    const playerId = uuidv4();
    // 将 playerId 绑定到 socket，后续 getPlayerState 可以使用
    socket.playerId = playerId;

    const player = {
      id: socket.id, playerId, name, seat: freeSeat, chips: STARTING_STACK, connected: true, waiting: false,
      inHand: false, folded: true, allIn: false, hole: [], betThisStreet: 0, totalCommitted: 0,
      lastAction: "JOIN", lastAmount: 0, hasActed: false, reveal: false, room: roomCode
    };
    table.players.push(player);

    io.to(socket.id).emit("roomCreated", roomCode);
    io.to(socket.id).emit("joined", { seat: player.seat, chips: player.chips, waiting: player.waiting, room: roomCode, playerId: player.playerId });
    broadcastState(table);
    tryStartHand(table);
  });

  socket.on("join", ({ name, room, playerId }) => {
    let table;
    if (room && rooms[room]) {
      table = rooms[room];
    } else {
      socket.emit("rejected", "房间号不存在");
      return;
    }

    // 1. 优先用playerId查找
    let existingPlayer = null;
    if (playerId) {
      existingPlayer = table.players.find(p => p.playerId === playerId);
    }

    if (existingPlayer) {
      const oldId = existingPlayer.id;
      existingPlayer.id = socket.id;
      existingPlayer.connected = true;
      existingPlayer.waiting = (table.state !== "waiting");

      // 绑定 socket.playerId，便于后续查找
      socket.playerId = existingPlayer.playerId;

      // 强制踢掉旧socket
      if (oldId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(oldId);
        if (oldSocket && oldSocket.connected) oldSocket.disconnect(true);
      }

      // 不再需要替换currentToAct、pendingActors等的id引用，因为都用playerId
      // 旧的断线计时器逻辑已移除

      console.log(`重连成功: ${name} (playerId:${existingPlayer.playerId}, oldId:${oldId} -> newId:${socket.id}), seat:${existingPlayer.seat}`);

      socket.join(table.roomCode);
      io.to(socket.id).emit("joined", {
        seat: existingPlayer.seat,
        chips: existingPlayer.chips,
        waiting: existingPlayer.waiting,
        room: table.roomCode,
        playerId: existingPlayer.playerId
      });
      broadcastState(table);
      tryStartHand(table);
      return;
    }

    // 2. fallback: 仅当playerId不存在时，才用name查找ghost
    let ghost = null;
    if (!playerId && name) {
      ghost = table.players.find(p => p.name === name && !p.connected);
    }
    if (ghost) {
      const oldId = ghost.id;
      ghost.id = socket.id;
      ghost.connected = true;
      ghost.waiting = (table.state !== "waiting");

      // 绑定 socket.playerId，后续使用统一 playerId 查找
      socket.playerId = ghost.playerId;

      // 不要将 table.currentToAct / pendingActors / rebuyPending / sidePots 中的 playerId 替换为 socket.id
      // 所有这些集合应始终使用 playerId；因此在重连时无需修改它们。

      // 旧的断线计时器逻辑已移除

      socket.join(table.roomCode);
      io.to(socket.id).emit("joined", { seat: ghost.seat, chips: ghost.chips, waiting: ghost.waiting, room: table.roomCode, playerId: ghost.playerId });
      broadcastState(table); tryStartHand(table); return;
    }

    // find seat not currently occupied by connected players
    const freeSeat = nextFreeSeatForConnected(table);
    if (freeSeat === -1) { socket.emit("rejected", "Table full"); return; }

    // Remove any stale disconnected occupant in that seat (cleanup)
    const staleIndex = table.players.findIndex(p => p.seat === freeSeat && !p.connected);
    if (staleIndex >= 0) table.players.splice(staleIndex, 1);

    // ensure unique name among connected
    if (table.players.find(p => p.name === name && p.connected)) name = `${name}_${Math.floor(Math.random() * 1000)}`;

    socket.join(table.roomCode);
    const newPlayerId = playerId || uuidv4();
    // 绑定 playerId 到 socket
    socket.playerId = newPlayerId;

    const player = {
      id: socket.id, playerId: newPlayerId, name, seat: freeSeat, chips: STARTING_STACK, connected: true, waiting: false,
      inHand: false, folded: true, allIn: false, hole: [], betThisStreet: 0, totalCommitted: 0,
      lastAction: "JOIN", lastAmount: 0, hasActed: false, reveal: false, room: table.roomCode
    };
    table.players.push(player);
    io.to(socket.id).emit("joined", { seat: freeSeat, chips: player.chips, waiting: player.waiting, room: table.roomCode, playerId: newPlayerId });
    broadcastState(table);
    tryStartHand(table);
  });

  socket.on("rebuy_response", ({ accept }) => {
    const { table, player: p } = getPlayerState(socket);
    if (!p || !table) return;
    if (!table.rebuyPending.has(p.playerId)) return;
    table.rebuyPending.delete(p.playerId);
    if (accept) {
      const amt = DEFAULT_REBUY_BB * BIG_BLIND;
      p.chips += amt; p.waiting = false;
      io.to(socket.id).emit("rebuy_result", { accepted: true, amount: amt });
    } else {
      const idx = table.players.findIndex(pl => pl.playerId === p.playerId);
      if (idx >= 0) table.players.splice(idx, 1);
      io.to(socket.id).emit("rebuy_result", { accepted: false });
      socket.leave(table.roomCode);
    }
    table._forceRevealMap = true;
    broadcastState(table);
    ensureNextHand(table); // 关键修改：无论是否有其他玩家等待重买，都尝试启动下一局
  });

  socket.on("action", ({ type, amount }) => {
    const { table, player: p } = getPlayerState(socket);
    if (!p || !table) return;
    if (table.currentToAct !== p.playerId) return; // 用playerId判断
    if (!p.inHand || p.folded || p.allIn) return;
    if (table.state === "waiting" || table.state === "showdown") return;

    amount = Number(amount) || 0;
    const toCall = Math.max(0, (table.highestBet || 0) - (p.betThisStreet || 0));
    const others = table.players.filter(o => o.playerId !== p.playerId && o.inHand && !o.folded);
    const minRaiseSize = (table.highestBet || 0) + (table.lastRaiseSize || BIG_BLIND) - (p.betThisStreet || 0);
    const minRaiseTo = table.highestBet === 0 ? BIG_BLIND : table.highestBet + minRaiseSize;
    const maxRaiseSize = p.chips;
    const maxRaiseTo = (table.highestBet || 0) + maxRaiseSize;

    // 新增：声明 soundType
    let soundType = null;

    // ---- 执行动作 ----
    if (type === "fold") {
      p.folded = true; p.lastAction = "Fold"; p.lastAmount = 0; p.hasActed = true;
      removeFromPending(table, p.playerId);
      soundType = SOUND_TYPES.FOLD;  // 新增：赋值
      const aliveAfter = inHandPlayers(table);
      if (aliveAfter.length === 1) {
        clearTurnTimer(table);
        endHandSingleWinner(table, aliveAfter[0]);
        return;
      }
    } else if (type === "check") {
      if (toCall !== 0) return;
      p.lastAction = "Check"; p.lastAmount = 0; p.hasActed = true;
      removeFromPending(table, p.playerId);
      soundType = SOUND_TYPES.CHECK;  // 新增：赋值
    } else if (type === "call") {
      if (toCall <= 0) return;
      const pay = Math.min(p.chips, toCall);
      p.chips -= pay; p.betThisStreet = (p.betThisStreet || 0) + pay; p.totalCommitted = (p.totalCommitted || 0) + pay;
      p.lastAction = "Call"; p.lastAmount = pay; p.hasActed = true;
      if (p.chips === 0) p.allIn = true;
      removeFromPending(table, p.playerId);
      soundType = SOUND_TYPES.BET;  // 新增：赋值
    } else if (type === "raise") {
      let raiseBy = Math.max(0, Math.floor(amount || 0));
      if (raiseBy < minRaiseSize) return; // 不允许小于最小加注额
      let raiseTo = (p.betThisStreet || 0) + raiseBy;
      const payToRaise = Math.max(0, raiseTo - (p.betThisStreet || 0));
      const isAllIn = (p.chips <= toCall) || (p.chips <= payToRaise);

      if (isAllIn) {
        const pay = p.chips;
        p.chips -= pay;
        p.betThisStreet += pay;
        p.totalCommitted += pay;
        p.lastAction = "All-In";
        p.lastAmount = pay;
        p.hasActed = true;
        p.allIn = true;
        const oldHighest = table.highestBet || 0;
        if (p.betThisStreet > oldHighest) {
          table.lastRaiseSize = Math.max(table.lastRaiseSize, p.betThisStreet - oldHighest);
          table.highestBet = p.betThisStreet;
          resetPendingAfterAggressor(table, p.playerId);
        } else {
          removeFromPending(table, p.playerId);
        }
      } else {
        const pay = payToRaise;
        p.chips -= pay;
        p.betThisStreet += pay;
        p.totalCommitted += pay;
        p.lastAction = "Raise";
        p.lastAmount = pay;
        p.hasActed = true;
        if (p.chips === 0) p.allIn = true;
        const oldHighest = table.highestBet || 0;
        if (p.betThisStreet > oldHighest) {
          table.lastRaiseSize = Math.max(table.lastRaiseSize, p.betThisStreet - oldHighest);
          table.highestBet = p.betThisStreet;
          resetPendingAfterAggressor(table, p.playerId);
        } else {
          removeFromPending(table, p.playerId);
        }
      }
      soundType = SOUND_TYPES.BET;  // 新增：赋值（raise 和 all-in 都用 bet 音效）
    } else {
      return;
    }

    table.sidePots = buildPotsFromCommitted(table);

    broadcastState(table);

    // 玩家主动操作，只向其他玩家广播音效
    if (soundType) {
      socket.broadcast.to(table.roomCode).emit("play_sound", { type: soundType, playerId: p.playerId });
    }

    const next = nextPendingAfter(table, p.seat) || findNextActorFromSeat(table, p.seat);
    if (next) {
      table.currentToAct = next.playerId;
      startTurnTimer(table, next);
      broadcastState(table);
    } else {
      clearTurnTimer(table);
      proceedAfterBetting(table);
    }
  });

  socket.on('sync_state', () => {
    // 找到该玩家所在房间
    const table = Object.values(rooms).find(t =>
      t.players.some(p => p.id === socket.id || p.playerId === socket.playerId)
    );
    if (table) {
      broadcastState(table);
    }
  });

  socket.on("disconnect", () => {
    const { table, player: p } = getPlayerState(socket);
    if (!p || !table) return;

    const wasCurrent = table.currentToAct === p.playerId;

    p.connected = false;

    removeFromPending(table, p.playerId);

    if (table.rebuyPending.has(p.playerId)) {
      table.rebuyPending.delete(p.playerId);
      const idx = table.players.findIndex(pl => pl.playerId === p.playerId);
      if (idx >= 0) table.players.splice(idx, 1);
    }

    // 不再单独设置断线计时器，统一由回合倒计时控制

    table.sidePots = buildPotsFromCommitted(table);

    broadcastState(table);

    const alivePlayers = inHandPlayers(table);
    if (alivePlayers.length === 1) {
      endHandSingleWinner(table, alivePlayers[0]);
    } else if (table.state === "waiting" || table.state === "showdown") {
      tryStartHand(table);
    }
  });
});