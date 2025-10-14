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
let turnDuration = 20000; // 新增：固定行动时长（ms），可从服务器广播覆盖
let localStartPerf = null; // 新增：本地 performance.now() 起点（行动开始时记录）
let perSecondTimer = null; // 新增：本地每秒刷新计时器
let lastRaiseAmount = 0; // 新增：记录玩家上一次的加注金额
let clockOffset = 0; // 新增：客户端与服务器的时钟偏差（ms）。客户端时间 - 服务器时间
const ASSUMED_LATENCY = 0; // 新增：假设的单程平均网络延迟（ms）。可根据实际网络环境调整

// 新增：记录用户是否已通过交互解锁音频，断线重连时重置为 false
let audioUserInteracted = false;

// 移除旧 sounds 对象和初始化

// 新增：Web Audio API
let audioContext = null;
let soundBuffers = {};
let soundEnabled = localStorage.getItem('soundEnabled') !== 'false';
//let audioUnlocked = false;// 修改：移除此旗标，改为在 playSound 中动态检查
const soundFiles = {
  bet: document.getElementById('sound-bet')?.src || 'media/bet.m4a',     // 修改：fallback 为 /media/ 路径
  check: document.getElementById('sound-check')?.src || 'media/check.m4a',
  fold: document.getElementById('sound-fold')?.src || 'media/fold.m4a',
  deal: document.getElementById('sound-deal')?.src || 'media/deal.m4a',
  win: document.getElementById('sound-win')?.src || 'media/win.m4a',
  turn: document.getElementById('sound-your-turn')?.src || 'media/your-turn.m4a'  // 假设文件名；如果不同，调整
};

// 新增：初始化 AudioContext 和预加载缓冲
async function initAudio(contextInstance) {
  if (!contextInstance) return;
  for (const [type, src] of Object.entries(soundFiles)) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; ++attempt) {
      try {
        const response = await fetch(src, { mode: 'cors', cache: 'force-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const arrayBuffer = await response.arrayBuffer();
        soundBuffers[type] = await contextInstance.decodeAudioData(arrayBuffer);
        ok = true;
        console.log(`Loaded sound: ${type}`);
      } catch (e) {
        console.error(`Failed to load/decode ${type} (attempt ${attempt+1}):`, e);
        if (attempt === 0) await new Promise(r => setTimeout(r, 300)); // 300ms后重试一次
      }
    }
    if (!ok) {
      soundBuffers[type] = null;
      alert(`音效文件 ${type} 加载失败，部分音效将无法播放！`);
    }
  }
}

// 修改：Web Audio 播放函数
async function playSound(type) {
  if (!soundEnabled || !audioContext || !soundBuffers[type]) { 
    console.warn(`Cannot play ${type}: not enabled/unlocked or buffer missing`);
    return;
  }
  
  try {
    // 【修改点 3: 移除 playSound 内部的 resume 尝试】
    // 假设：每次用户交互前（如点击按钮）都已调用 await unlockAudioContext() 确保上下文是 Running 或 Suspended
    // 并且如果被关闭（closed）也已经被重建和重载。
    // 因此这里不再需要重复检查和 resume。

    const source = audioContext.createBufferSource();
    source.buffer = soundBuffers[type];
    
    // 音量控制（简化：只用 gainNode）
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0.5;
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    source.start(0);  // 立即播放
    
    console.log(`Playing sound: ${type}`);
  } catch (err) {
    console.error(`Play ${type} failed:`, err);
  }
}

// 新增：Web Audio 解锁（用户交互时 resume）
async function unlockAudioContext() {
  let contextNeedsReload = false; // 标志是否需要重新加载音效

  // 如果 audioContext 不存在，或已被关闭（iOS Safari 切后台后可能自动关闭），则新建
  if (!audioContext || audioContext.state === 'closed') {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      contextNeedsReload = true; // 既然是新的实例，肯定需要重新加载音效
      console.log('AudioContext recreated');
    } catch (e) {
      console.error('Failed to create new AudioContext:', e);
      return;
    }
  }

  // 确保在尝试播放前，音效缓冲已就绪
  if (contextNeedsReload) {
    // 重新加载音效 buffer - 必须等待此操作完成
    await initAudio(audioContext); 
    console.log('Audio buffers reloaded for new context');
  }

  // ***** 【最终修复点：强制延迟稳定】 *****
  // 在 iOS 上，新创建或刚恢复的 AudioContext 实例可能需要几毫秒才能稳定。
  await new Promise(resolve => setTimeout(resolve, 50)); 
  console.log('Forced 50ms stabilization delay passed.');

  // 如果是 suspended，尝试 resume
  if (audioContext.state === 'suspended') {
    try {
      await audioContext.resume();
      console.log('AudioContext resumed');
    } catch (e) {
      console.error('Failed to resume AudioContext:', e);
    }
  }
  audioUserInteracted = true;
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
        let remainingMs = 0; 

        const isCurrentToAct = p.playerId === state.currentToAct;

        if (isCurrentToAct && actDeadline) {
          // *** 核心修正：使用校准后的客户端时间 ***
          // clientCorrectedTime = 客户端本地时间 - 时钟偏差 (将客户端时间 "拉回" 到接近服务器时间)
          const clientCorrectedTime = Date.now() - clockOffset; 
          
          // 剩余时间 = 服务器的截止时间 - 校准后的客户端当前时间
          remainingMs = Math.max(0, actDeadline - clientCorrectedTime); 
        } else {
          remainingMs = 0;
        }

        const totalMs = turnDuration;
        const progress = (remainingMs / totalMs) * 100;
        box.style.setProperty('--progress', `${progress}%`);
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
  els.btnCallCheck.disabled = !actionOpts.yourTurn || (!actionOpts.canCheck && actionOpts.toCall <= 0);  
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
    // 【修正后的代码：使用 actDeadline 和 clockOffset 计算剩余时间】
    if (actDeadline && turnDuration) { 
        // 使用校准后的时间计算剩余时间 (与玩家盒子中的计算逻辑保持一致)
        const clientCorrectedTime = Date.now() - clockOffset;
        const remainingMs = Math.max(0, actDeadline - clientCorrectedTime);
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        tip += ` ｜ 剩余时间：${remainingSeconds}秒`;
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

socket.on("joined", async ({ seat, chips, waiting, room, playerId }) => {
  me.seat = seat;
  me.chips = chips;
  me.room = room;
  if (playerId) {
    me.playerId = playerId;
    setWithExpiry('pokerPlayerId', playerId);
  }
  document.getElementById("join-overlay").style.display = "none";
  els.actions.style.display = "block";

  // 断线重连后清除“已交互”标志，防止使用旧交互状态误放音
  audioUserInteracted = false;

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

// client.js (替换 socket.on("state", s => { ... } ) 整个代码块)
socket.on("state", s => {
  // *** 核心：时钟校准逻辑 ***
  const clientReceiveTime = Date.now(); 

  if (s.serverTimestamp) {
    // 估计的总偏差（包含时钟漂移和单程延迟）
    const estimatedDifference = clientReceiveTime - s.serverTimestamp; 
    
    // 计算时钟偏差 (clockOffset)： 总偏差 - 假设的单程延迟 (50ms)
    // 正值表示客户端时间比服务器时间快。
    clockOffset = estimatedDifference - ASSUMED_LATENCY;
  }
  
  // *** 状态更新 ***
  prevState = state ? state.state : null; 
  state = s;
  actDeadline = s && s.actDeadline ? s.actDeadline : null; 
  turnDuration = s && s.turnDuration ? s.turnDuration : 20000;

  // 【移除旧逻辑】: 已经不需要记录 localStartPerf

  // *** 计时器管理逻辑：只用于周期性刷新 UI ***
  if (perSecondTimer) { clearInterval(perSecondTimer); perSecondTimer = null; }

  const isMyTurnAndHasDeadline = state.currentToAct === me.playerId && actDeadline;

  if (isMyTurnAndHasDeadline) { 
    // 计时器现在只负责周期性调用 render()，计算逻辑在 render() 中。
    perSecondTimer = setInterval(() => {
      render(); 
      
      // 使用校准后的时间检查截止日期，避免计时器在时间到期后仍继续运行
      const clientCorrectedTime = Date.now() - clockOffset;
      if (Math.max(0, actDeadline - clientCorrectedTime) <= 0) {
        clearInterval(perSecondTimer); 
        perSecondTimer = null;
      }
    }, 250); // 每 250ms 刷新一次
  }
  
  if (state && state.state !== "showdown") {
    revealedHoles = {};
  }
  
  // 即使没有启动计时器，也需要立即渲染一次最新状态
  render();
});

socket.on("hole", cards => { myHole = cards || []; render(); });
socket.on("actions", opts => {
  const wasYourTurn = actionOpts.yourTurn;
  actionOpts = Object.assign(actionOpts, opts || {});
  // 只在音频已解锁时播放 your-turn 音效，未解锁时直接跳过
  if (actionOpts.yourTurn && !wasYourTurn && audioUserInteracted) {
    playSound('turn'); // 只在音频已解锁时播放
  }
  if (state && state.state === "preflop" && prevState !== "preflop") {
    els.raiseBy.value = actionOpts.minRaiseSize || 0;
    lastRaiseAmount = 0;
  }
  render();
});

socket.on("play_sound", ({ type, playerId, playerIds }) => {
  // 如果 AudioContext 存在但仍处于 suspended，且用户尚未通过交互解锁，
  // 则忽略来自服务器的播放请求，避免在首次交互时回放一堆历史音效。
  if (audioContext && audioContext.state === 'suspended' && !audioUserInteracted) {
    console.log('Skipping play_sound due to suspended AudioContext (awaiting user interaction):', type);
    return;
  }

  if (type === 'win') {
    const winIds = playerIds || [playerId];
    if (winIds.includes(me.playerId)) {
      playSound('win');
    }
  } else {
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

window.addEventListener('load', async () => {  // 修改：添加 async
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

  // 新增：初始化 Web Audio（用 try-catch 防止阻塞）
  try {
    // 【修复点 B-1】首次加载时，不传 contextInstance，让 initAudio 自己处理初始创建
    audioContext = new (window.AudioContext || window.webkitAudioContext)(); // 首次创建
    await initAudio(audioContext); // 使用这个实例来加载音效
    console.log('Audio initialization complete');
  } catch (e) {
    console.error('Audio init failed, continuing without sounds:', e);
    soundEnabled = false;
  }

  // 新增：监听页面可见/焦点变化，resume/重建
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      // 立即刷新倒计时 (UI 冻结修复)
      socket.emit('sync_state'); // 请求最新状态
      render(); // 立即渲染
  
      // ===【关键：彻底重建音频环境，和断线重连完全一致】===
      if (audioContext) {
        try {
          if (audioContext.state !== 'closed') {
            await audioContext.close();
          }
        } catch (e) {
          console.error('Error closing old AudioContext on visibilitychange:', e);
        }
        audioContext = null;
        console.log('AudioContext closed and cleared on visibilitychange.');
      }
      audioUserInteracted = false;
  
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        await initAudio(audioContext);
        console.log('AudioContext and buffers re-initialized on visibilitychange.');
      } catch (e) {
        console.error('Audio re-init failed on visibilitychange:', e);
      }
  
      // 重新启动计时器逻辑（保持不变）
      if (perSecondTimer) clearInterval(perSecondTimer);
      if (state && state.currentToAct === me.playerId && actDeadline) {
        perSecondTimer = setInterval(() => {
          render();
          const clientCorrectedTime = Date.now() - clockOffset;
          if (Math.max(0, actDeadline - clientCorrectedTime) <= 0) {
            clearInterval(perSecondTimer);
            perSecondTimer = null;
          }
        }, 250);
      }
      // 新增：如果剩余时间为负，主动请求服务器同步
      const clientCorrectedTime = Date.now() - clockOffset;
      if (actDeadline && actDeadline - clientCorrectedTime < -1000) {
        socket.emit('sync_state');
      }
    }
  });
  
  window.addEventListener('focus', async () => { // 【修复点 B-4】改为 async
    // 在 focus 事件中也执行完整的解锁流程
    await unlockAudioContext();
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

      soundToggle.addEventListener('click', async () => { // **【修改点 1: 添加 async】**
          const wasEnabled = soundEnabled;
          soundEnabled = !soundEnabled;
          updateSoundToggle();
      });
  }
});

// 保留 join/create 中的 unlock
els.joinBtn.addEventListener("click", async () => {
  unlockAudioContext();  // 修改：用新函数
  const name = (els.nameInput.value || "").trim() || ("Player" + Math.floor(Math.random() * 1000));
  const room = (els.roomInput.value || "").trim();
  me.name = name;
  setWithExpiry('pokerUsername', name);
  const joinData = { name, room, playerId: me.playerId };
  socket.emit("join", joinData);
});

els.createBtn.addEventListener("click", async () => {  // 修改：添加 async
  unlockAudioContext();  // 修改：用新函数（替换 unlockAudio()）
  const name = (els.nameInput.value || "").trim() || ("Player" + Math.floor(Math.random() * 1000));
  me.name = name;
  setWithExpiry('pokerUsername', name);
  socket.emit("createRoom", { name, playerId: me.playerId });
});

els.nameInput.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("join-btn").click(); });
els.roomInput.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("join-btn").click(); });

// 在所有行动按钮添加解锁（e.g., btnFold）
els.btnFold.addEventListener("click", async () => {
  await unlockAudioContext();  // 新增：每个交互重试
  // 【修改：在发送 action 之前，本地播放弃牌音效】
  playSound('fold');
  socket.emit("action", { type: "fold" });
});

// 类似：btnCallCheck, btnRaise, raiseBy keydown
els.btnCallCheck.addEventListener("click", async () => {
  if (els.btnCallCheck.disabled) return; // 防止非回合时本地触发
  await unlockAudioContext();
  if (actionOpts.canCheck) {
    // 【修改：本地播放过牌音效】
    playSound('check');
    socket.emit("action", { type: "check" });
  } else {
    // 【修改：本地播放跟注音效（使用 'bet'）】
    playSound('bet');
    socket.emit("action", { type: "call" });
  }
});

els.btnRaise.addEventListener("click", async () => {
  await unlockAudioContext();
  // 【修改：本地播放加注音效（使用 'bet'）】
  playSound('bet');
  sendRaiseAction();
});

els.raiseBy.addEventListener("keydown", async e => {
  if (e.key === "Enter") {
    await unlockAudioContext();
    // 【修改：本地播放加注音效（使用 'bet'）】
    playSound('bet');
    sendRaiseAction();
  }
});

// 【在现有的事件监听器之后，添加键盘快捷键逻辑】
window.addEventListener('keydown', async (e) => {
  // 1. 检查焦点：确保当前焦点不在任何输入框中（例如 raiseBy, nameInput, roomInput）
  const focusedElement = document.activeElement;
  if (focusedElement && 
      (focusedElement.tagName === 'INPUT' || focusedElement.tagName === 'TEXTAREA' || focusedElement.contentEditable === 'true')) {
    return; // 忽略在输入框中按键
  }

  // 2. 检查是否轮到玩家行动
  if (!actionOpts.yourTurn) {
    return; // 只有在轮到我方行动时才响应快捷键
  }
  
  // 3. 执行对应的行动
  switch (e.key.toUpperCase()) {
    case 'B': // B: Bet/Raise (加注)
      e.preventDefault(); // 阻止浏览器默认行为
      if (!els.btnRaise.disabled) {
        await unlockAudioContext();
        playSound('bet'); // 本地播放加注音效
        sendRaiseAction();
      }
      break;

    case 'C': // C: Call (跟注)
      e.preventDefault();
      // 如果不是过牌模式 (canCheck=false) 且按钮没有禁用
      if (!actionOpts.canCheck && !els.btnCallCheck.disabled) {
        await unlockAudioContext();
        playSound('bet'); // 跟注使用 'bet' 音效
        socket.emit("action", { type: "call" });
      }
      break;

    case 'K': // K: Check (过牌)
      e.preventDefault();
      // 如果是过牌模式 (canCheck=true) 且按钮没有禁用
      if (actionOpts.canCheck && !els.btnCallCheck.disabled) {
        await unlockAudioContext();
        playSound('check'); // 本地播放过牌音效
        socket.emit("action", { type: "check" });
      }
      break;

    case 'F': // F: Fold (弃牌)
      e.preventDefault();
      if (!els.btnFold.disabled) {
        await unlockAudioContext();
        playSound('fold'); // 本地播放弃牌音效
        socket.emit("action", { type: "fold" });
      }
      break;
  }
});

window.addEventListener("resize", () => render());
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => render());
  window.visualViewport.addEventListener("scroll", () => render());
}