// client.js
// Client UI: Fixed positioning for portrait mode to prevent player info or cards from exceeding screen edges.

const socket = io();

let me = { id: null, seat: null, name: null, room: null, playerId: null };
let state = null;
let myHole = [];
let actionOpts = { yourTurn: false, canCheck: false, canCall: false, toCall: 0, minRaiseSize: 0, maxRaiseSize: 0, chips: 0 };
let revealedHoles = {};
let prevState = null; // 定义前一条街默认状态
let actDeadline = null; // 新增：服务器推送的当前回合截止时间戳（ms）
let perSecondTimer = null; // 新增：本地每秒刷新计时器
let lastRaiseAmount = 0; // 新增：记录玩家上一次的加注金额

// Sound switch and audio references
let soundEnabled = localStorage.getItem('soundEnabled') !== 'false'; // Default: enabled
let audioUnlocked = false; // 新增：音频解锁状态
const sounds = {
  bet: document.getElementById('sound-bet'),
  check: document.getElementById('sound-check'),
  fold: document.getElementById('sound-fold'),
  deal: document.getElementById('sound-deal'),
  win: document.getElementById('sound-win'),
  turn: document.getElementById('sound-your-turn') // Matches HTML
};

// Set default volume and events
Object.entries(sounds).forEach(([key, audio]) => {
  if (audio) {
    audio.volume = 0.5;
    audio.preload = 'auto';
    // 新增：监听加载完成
    audio.addEventListener('loadeddata', () => console.log(`${key} loaded fully`));
    // 新增：监听结束，避免重叠
    audio.addEventListener('ended', () => {
      audio.currentTime = 0; // 预重置
    });
    // 新增：错误处理
    audio.addEventListener('error', (e) => console.warn(`Audio ${key} error:`, e));
  }
});

// 改进播放函数
function playSound(type) {
  if (!soundEnabled || !sounds[type]) return;
  const audio = sounds[type];
  if (audio.playing) return;
  audio.playing = true;

  audio.pause(); // 先暂停
  audio.currentTime = 0; // 重置

  // 监听 seeked 事件（一次性）
  const onSeeked = () => {
    audio.removeEventListener('seeked', onSeeked);
    audio.play().then(() => {
      audio.playing = false;
    }).catch(err => {
      console.warn('Audio play failed:', err);
      audio.playing = false;
      if (!audioUnlocked && err.name === 'NotAllowedError') {
        unlockAudio();
      }
    });
  };
  audio.addEventListener('seeked', onSeeked);
}

// 新增：解锁音频（用户交互后）
function unlockAudio() {
  const silentAudio = new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=');
  silentAudio.volume = 0;
  silentAudio.play().then(() => {
    audioUnlocked = true;
    console.log('Audio unlocked');
  }).catch(() => console.warn('Audio unlock failed'));
}

const els = {
  playersLayer: document.getElementById("players-layer"),
  community: document.getElementById("community"),
  potDisplay: document.getElementById("pot-display"),
  roomDisplay: document.getElementById("room-display"),
  actions: document.getElementById("actions"),
  btnFold: document.getElementById("btn-fold"),
  btnCallCheck: document.getElementById("btn-call-check"),
  btnRaise: document.getElementById("btn-raise"),
  raiseBy: document.getElementById("raise-by"),
  tips: document.getElementById("action-tips"),
  joinOverlay: document.getElementById("join-overlay"),
  nameInput: document.getElementById("name-input"),
  roomInput: document.getElementById("room-input"),
  joinBtn: document.getElementById("join-btn"),
  createBtn: document.getElementById("create-btn"),
  rebuyOverlay: document.getElementById("rebuy-overlay"),
  rebuyText: document.getElementById("rebuy-text"),
  rebuyAccept: document.getElementById("rebuy-accept"),
  rebuyDecline: document.getElementById("rebuy-decline")
};

// 新增：设置 localStorage 数据的有效期（24小时）
const STORAGE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// 新增：保存带有效期的 localStorage 数据
function setWithExpiry(key, value) {
  const now = Date.now();
  const item = {
    value: value,
    expiry: now + STORAGE_EXPIRY_MS
  };
  localStorage.setItem(key, JSON.stringify(item));
}

// 修改：更健壮的 getWithExpiry，处理无效或遗留数据
function getWithExpiry(key) {
  const itemStr = localStorage.getItem(key);
  if (!itemStr) return null;

  try {
    const item = JSON.parse(itemStr);
    // 验证数据格式
    if (!item || typeof item !== 'object' || !('value' in item) || !('expiry' in item)) {
      localStorage.removeItem(key); // 清除无效数据
      return null;
    }
    const now = Date.now();
    if (now > item.expiry) {
      localStorage.removeItem(key); // 过期则删除
      return null;
    }
    // 确保返回的是字符串（针对 username 和 playerId）
    return typeof item.value === 'string' ? item.value : null;
  } catch (e) {
    console.error(`Failed to parse localStorage item for key "${key}":`, e);
    localStorage.removeItem(key); // 清除解析失败的数据
    return null;
  }
}

function suitSymbol(s) { return s === "H" ? "♥" : s === "S" ? "♠" : s === "D" ? "♦" : "♣"; }
function suitColor(s) { return s === "H" ? "#e30000" : s === "S" ? "#000000" : s === "D" ? "#0066ff" : "#00a21a"; }

function makeCardSVG(card, large = false) {
  const w = large ? 260 : 120;
  const h = Math.round(w * 1.4);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", 2); rect.setAttribute("y", 2);
  rect.setAttribute("rx", 10); rect.setAttribute("ry", 10);
  rect.setAttribute("width", w - 4); rect.setAttribute("height", h - 4);
  rect.setAttribute("fill", card === "back" ? "none" : "#fff");
  rect.setAttribute("stroke", card === "back" ? "#ff6fb9" : "#d7d7d7");
  rect.setAttribute("stroke-width", "3");
  svg.appendChild(rect);

  if (card === "back") {
    for (let i = 0; i < 8; i++) {
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", 8 + i * (w / 8));
      line.setAttribute("y1", 16);
      line.setAttribute("x2", 32 + i * (w / 8));
      line.setAttribute("y2", h - 16);
      line.setAttribute("stroke", "#ffc2e3");
      line.setAttribute("stroke-width", 2);
      line.setAttribute("opacity", "0.25");
      svg.appendChild(line);
    }
    return svg;
  }

  const rank = card.r;
  const suit = card.s;
  const color = suitColor(suit);
  const fontSize = large ? Math.round(w * 0.56 * 1.3) : Math.round(w * 0.42 * 1.3);

  const t1 = document.createElementNS(ns, "text");
  t1.setAttribute("x", 10); t1.setAttribute("y", fontSize + 2);
  t1.setAttribute("font-size", fontSize); t1.setAttribute("font-weight", "900"); t1.setAttribute("fill", color);
  t1.textContent = rank; svg.appendChild(t1);

  const t2 = document.createElementNS(ns, "text");
  t2.setAttribute("x", w - 10); t2.setAttribute("y", h - 10);
  t2.setAttribute("font-size", fontSize); t2.setAttribute("font-weight", "900"); t2.setAttribute("fill", color); t2.setAttribute("text-anchor", "end");
  t2.textContent = suitSymbol(suit); svg.appendChild(t2);

  return svg;
}

function render() {
  if (!state) return;

  if (state.state !== "showdown") {
    revealedHoles = {};
  }

  if (me.room) els.roomDisplay.textContent = `房间号：${me.room}`;

  els.community.innerHTML = "";
  for (const c of state.community || []) {
    const cd = document.createElement("div"); cd.className = "card";
    cd.appendChild(makeCardSVG(c, true));
    els.community.appendChild(cd);
  }

  const potTotal = state.potTotal || 0;
  let myWinnings = 0;
  const mePlayer = state.players.find(p => p.playerId === me.playerId);
  if (mePlayer) {
    myWinnings = mePlayer.potentialWinnings || 0;
  }
  
  els.potDisplay.innerHTML = `<span>底池总额：${potTotal}</span>`;

  els.playersLayer.innerHTML = "";
  const players = (state.players || []).slice();
  if (players.length === 0) return;

  const tableRect = document.getElementById("table-area").getBoundingClientRect();
  const cx = tableRect.left + tableRect.width / 2;
  const cy = tableRect.top + tableRect.height / 2;
  const isPortrait = window.innerWidth / window.innerHeight < 1;
  const halfWidth = tableRect.width / 2 * 0.8;
  const halfHeight = tableRect.height / 2 * 0.8;
  const sideOffset = tableRect.height * 0.15;
  const MAX_PLAYERS = 6;

  const hFactor = 1.0;
  const vFactor = 1.6;
  const uiSeatPositions = [
    { x: cx, y: cy + halfHeight }, // 6点钟
    { x: cx - hFactor * halfWidth, y: cy + vFactor * sideOffset }, // 8点钟
    { x: cx - hFactor * halfWidth, y: cy - vFactor * sideOffset }, // 10点钟
    { x: cx, y: cy - halfHeight }, // 12点钟
    { x: cx + hFactor * halfWidth, y: cy - vFactor * sideOffset }, // 2点钟
    { x: cx + hFactor * halfWidth, y: cy + vFactor * sideOffset }, // 4点钟
  ];

  const myPlayer = state.players.find(p => p.playerId === me.playerId);
  const mySeat = myPlayer ? myPlayer.seat : null;

  for(const p of players) {
      if(!p.connected && !p.inHand) continue;
      
      let relativeSeat;
      if (mySeat !== null) {
          relativeSeat = (p.seat - mySeat + MAX_PLAYERS) % MAX_PLAYERS;
      } else {
          relativeSeat = p.seat;
      }

      const positionIndex = relativeSeat;
      const pos = uiSeatPositions[positionIndex];

      let x = pos.x;
      let y = pos.y;
      if (window.visualViewport) {
        x += window.visualViewport.offsetLeft || 0;
        y += window.visualViewport.offsetTop || 0;
      }

      const wrap = document.createElement("div"); wrap.className = "player-wrap";
      wrap.style.left = `${x}px`; wrap.style.top = `${y}px`;

      const handDiv = document.createElement("div"); handDiv.className = "hand";
      const showFace = (p.playerId === me.playerId) || (state.state === "showdown" && !p.folded) || (revealedHoles && revealedHoles[p.playerId]);
      if (p.inHand && !p.folded) {
        if (showFace) {
         const faceCards = (p.playerId === me.playerId) ? myHole : (revealedHoles[p.playerId] || p.hole || []);
          for (const c of faceCards) {
            const cardEl = document.createElement("div"); cardEl.className = "card";
            cardEl.appendChild(makeCardSVG(c));
            handDiv.appendChild(cardEl);
          }
        } else {
          for (let k = 0; k < 2; k++) {
            const cardEl = document.createElement("div"); cardEl.className = "card back";
            cardEl.appendChild(makeCardSVG("back"));
            handDiv.appendChild(cardEl);
          }
        }
      }

      const box = document.createElement("div"); box.className = "player-box";
      if (p.playerId === me.playerId) box.classList.add("me");
      if (p.folded) box.classList.add("folded");
      if (!p.connected) box.classList.add("disconnected");
      if (p.seat === state.dealerSeat) box.classList.add("dealer");
      if (p.playerId === state.currentToAct && (state.state === "preflop" || state.state === "flop" || state.state === "turn" || state.state === "river")) box.classList.add("acting");
      // 计算剩余时间百分比并设置 --progress
      if (actDeadline) {
        const remainingMs = Math.max(0, actDeadline - Date.now());
        const totalMs = 20000; // 假设服务器每次行动时间为20秒，可根据实际服务器设置调整
        const progress = (remainingMs / totalMs) * 100;
        box.style.setProperty('--progress', `${progress}%`);
      } else {
        box.style.setProperty('--progress', '100%'); // 默认满进度
      }
      if (
        p.lastAction &&
        p.lastAction.toUpperCase().includes("WIN")
      ) {
        box.classList.add("winner");
      }
      const name = document.createElement("div"); name.className = "name";
      const showClock = (p.playerId === state.currentToAct) && (state.state === "preflop" || state.state === "flop" || state.state === "turn" || state.state === "river");
      name.innerHTML = `${p.name} ${ (p.seat === state.dealerSeat) ? '<span class="dealer-icon">🔄</span>' : '' } ${showClock ? '⏳' : ''}`;
      const chips = document.createElement("div"); chips.className = "chips"; chips.textContent = `筹码：${p.chips}`;
      const act = document.createElement("div");
      act.className = "action";

      // 只在 p.lastAction 有值的时候显示行动信息
      if (p.lastAction) {
          // 如果是 All-In，直接显示 All-In
          if (p.allIn) {
              act.textContent = "All-In";
          } else {
              // 如果行动是 fold, join, 等，只显示 lastAction
              if (p.lastAmount === 0) {
                  act.textContent = p.lastAction;
              } else {
                  // 如果有金额，则显示行动和金额
                  act.textContent = `${p.lastAction} ${p.lastAmount}`;
              }
          }
      }

      box.appendChild(name); box.appendChild(chips); box.appendChild(act);

      wrap.appendChild(handDiv); wrap.appendChild(box);
      els.playersLayer.appendChild(wrap);
  }

  els.actions.style.opacity = actionOpts.yourTurn ? 1 : 0.6;
  els.btnFold.disabled = !actionOpts.yourTurn;
  els.btnRaise.disabled = !actionOpts.yourTurn || actionOpts.chips <= 0;
  els.raiseBy.disabled = !actionOpts.yourTurn || actionOpts.chips <= 0;

  if (actionOpts.yourTurn) {
    if (actionOpts.canCheck) {
      els.btnCallCheck.textContent = "过牌";
    } else {
      const displayCall = Math.min(actionOpts.toCall, actionOpts.chips);
      els.btnCallCheck.textContent = `跟注 ${displayCall}`;
    }
    let tip = `最小加注额：${actionOpts.minRaiseSize}`;
    if (actDeadline){
      const rm = Math.max(0, actDeadline - Date.now());
      const rs = Math.ceil(rm / 1000);
      tip += ` ｜ 剩余时间：${rs}s`;
    }
    els.tips.textContent = tip;

    if (document.activeElement !== els.raiseBy) { // 仅在输入框未被聚焦时更新
      els.raiseBy.value = Math.max(actionOpts.minRaiseSize || 0, lastRaiseAmount || 0);
    }
    els.raiseBy.min = Math.max(actionOpts.minRaiseSize, 0);
    if (actionOpts.maxRaiseSize) els.raiseBy.max = actionOpts.maxRaiseSize;
    else els.raiseBy.removeAttribute("max");
  } else {
    els.tips.textContent = (state?.state === "waiting" ? "等待下一局开始…" : "等待他人行动…");
  }
}

function sendRaiseAction() {
  if (actionOpts.yourTurn) {
    const v = parseInt(els.raiseBy.value || 0, 10);
    lastRaiseAmount = v; // 新增：记录本次加注金额
    socket.emit("action", { type: "raise", amount: Number(els.raiseBy.value) });
  }
}

socket.on("connect", () => {
  me.id = socket.id;
  if (me.name && me.room) {
    socket.emit("join", { name: me.name, room: me.room, playerId: me.playerId });
  }
});

socket.on("joined", ({ seat, chips, waiting, room, playerId }) => {
  me.seat = seat;
  me.chips = chips;
  me.room = room;
  if (playerId) {
    me.playerId = playerId;
    setWithExpiry('pokerPlayerId', playerId);
  }
  document.getElementById("join-overlay").style.display = "none";
  els.actions.style.display = "block";
  render();
});

socket.on("rejected", msg => {
  alert(msg);
  if (msg.includes("不存在")) {
    // 保存用户名到 localStorage，带有效期
    if (me.name && typeof me.name === 'string') {
      setWithExpiry('pokerUsername', me.name);
    }
    // 清除其他状态并刷新页面
    me.name = null;
    me.room = null;
    me.playerId = null;
    localStorage.removeItem('pokerPlayerId');
    location.reload();
  }
});

socket.on("roomCreated", (room) => {
  me.room = room;
  document.getElementById("join-overlay").style.display = "none";
  els.actions.style.display = "block";
  render();
});

socket.on("state", s => {
  prevState = state ? state.state : null; 
  state = s;
  actDeadline = s && s.actDeadline ? s.actDeadline : null;
  if (perSecondTimer) { clearInterval(perSecondTimer); perSecondTimer = null; }
  if (actDeadline) {
    perSecondTimer = setInterval(() => {
      if (!actDeadline || Date.now() > actDeadline) {
        clearInterval(perSecondTimer); perSecondTimer = null;
      }
      render();
    }, 250);
  }
  if (state && state.state !== "showdown") {
    revealedHoles = {};
  }
  render();
});

socket.on("hole", cards => { myHole = cards || []; render(); });
socket.on("actions", opts => {
  const wasYourTurn = actionOpts.yourTurn;
  actionOpts = Object.assign(actionOpts, opts || {});
  if (actionOpts.yourTurn && !wasYourTurn) {
    playSound('turn'); // Plays your_turn.m4a
  }
  if (state && state.state === "preflop" && prevState !== "preflop") {
    els.raiseBy.value = actionOpts.minRaiseSize || 0;
    lastRaiseAmount = 0;
  }
  render();
});

socket.on("play_sound", ({ type, playerId, playerIds }) => {
  if (type === 'win') {
    // Play only for winner(s)
    const winIds = playerIds || [playerId];
    if (winIds.includes(me.playerId)) {
      playSound('win');
    }
  } else {
    // Play fold, check, bet, deal for all players
    playSound(type);
  }
});

socket.on("showdown_holes", reveal => { revealedHoles = reveal || {}; render(); });

socket.on("rebuy_request", ({ amount }) => {
  els.rebuyText.textContent = `你的筹码为0，是否重新Buy-in ${amount}？`;
  els.rebuyOverlay.style.display = "block";
  els.rebuyAccept.onclick = () => {
    socket.emit("rebuy_response", { accept: true });
    els.rebuyOverlay.style.display = "none";
    revealedHoles = {};
  };
  els.rebuyDecline.onclick = () => {
    socket.emit("rebuy_response", { accept: false });
    els.rebuyOverlay.style.display = "none";
    revealedHoles = {};
  };
});
socket.on("rebuy_result", res => {
  if (res.accepted) alert(`已重新Buy-in: ${res.amount}`);
  else alert(`你已选择离开牌桌。`);
});

window.addEventListener('load', () => {
  // 清除遗留的非结构化数据（如果存在）
  const rawUsername = localStorage.getItem('pokerUsername');
  if (rawUsername && rawUsername.startsWith('{') === false) {
    localStorage.removeItem('pokerUsername');
  }

  // 恢复 playerId
  let savedPlayerId = getWithExpiry('pokerPlayerId');
  if (!savedPlayerId) {
    savedPlayerId = ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
    setWithExpiry('pokerPlayerId', savedPlayerId);
  }
  me.playerId = savedPlayerId;

  // 恢复用户名到输入框
  const savedUsername = getWithExpiry('pokerUsername');
  if (savedUsername) {
    me.name = savedUsername;
    els.nameInput.value = savedUsername;
  }

  // 增强预加载
  Object.values(sounds).forEach(audio => {
    if (audio) {
      audio.volume = 0.5;
      audio.preload = 'auto';
      audio.load();  // 强制加载
      audio.addEventListener('canplaythrough', () => console.log(`Audio ${audio.id} loaded fully`));  // 调试日志
    }
  });

  // Sound toggle
  const soundToggle = document.getElementById('sound-toggle');
  if (soundToggle) {
    const icon = soundToggle.querySelector('.icon');
    function updateSoundToggle() {
      icon.textContent = soundEnabled ? '🔊' : '🔈';
      if (soundEnabled) {
        soundToggle.classList.remove('off');
      } else {
        soundToggle.classList.add('off');
      }
      localStorage.setItem('soundEnabled', soundEnabled);
    }
    updateSoundToggle();

    soundToggle.addEventListener('click', () => {
      soundEnabled = !soundEnabled;
      updateSoundToggle();
    });
  }
});

els.joinBtn.addEventListener("click", () => {
  unlockAudio(); // 新增：尝试解锁音频
  const name = (els.nameInput.value || "").trim() || ("Player" + Math.floor(Math.random() * 1000));
  const room = (els.roomInput.value || "").trim();
  me.name = name;
  setWithExpiry('pokerUsername', name);
  const joinData = { name, room, playerId: me.playerId };
  socket.emit("join", joinData);
});

els.createBtn.addEventListener("click", () => {
  unlockAudio(); // 新增：尝试解锁音频
  const name = (els.nameInput.value || "").trim() || ("Player" + Math.floor(Math.random() * 1000));
  me.name = name;
  setWithExpiry('pokerUsername', name);
  socket.emit("createRoom", { name, playerId: me.playerId });
});

els.nameInput.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("join-btn").click(); });
els.roomInput.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("join-btn").click(); });

els.btnFold.addEventListener("click", () => socket.emit("action", { type: "fold" }));
els.btnCallCheck.addEventListener("click", () => {
  if (actionOpts.canCheck) {
    socket.emit("action", { type: "check" });
  } else {
    socket.emit("action", { type: "call" });
  }
});
els.btnRaise.addEventListener("click", () => sendRaiseAction());

els.raiseBy.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    sendRaiseAction();
  }
});

window.addEventListener("resize", () => render());
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => render());
  window.visualViewport.addEventListener("scroll", () => render());
}