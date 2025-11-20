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

/**专门用于在 iOS Safari 上禁用双击缩放 (Double-Tap Zoom)
 * 同时保留页面的其他触摸交互 (如滚动和单次点击)
 */
function disableDoubleTapZoom() {
  let lastTouchEnd = 0;

  // 监听触摸结束事件
  document.addEventListener('touchend', function (event) {
    // 获取当前时间戳
    const now = (new Date()).getTime();

    // 判断两次 'touchend' 事件的时间间隔
    // 如果两次触摸结束时间间隔小于 300 毫秒，则认为是双击
    if (now - lastTouchEnd <= 300) {
      // 阻止默认行为，从而阻止浏览器进行双击缩放
      event.preventDefault();
    }

    // 更新上次触摸结束的时间
    lastTouchEnd = now;
  }, false);

  // 额外地，为避免某些浏览器在长按时弹出上下文菜单，
  // 可以添加以下代码，但请注意，这可能会影响某些交互，如果不需要可省略。
  /*
  document.addEventListener('gesturestart', function(e) {
      e.preventDefault();
  });
  */
}

// 在页面加载完成后执行禁用函数
window.onload = disableDoubleTapZoom;

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
        console.error(`Failed to load/decode ${type} (attempt ${attempt + 1}):`, e);
        if (attempt === 0) await new Promise(r => setTimeout(r, 300)); // 300ms后重试一次
      }
    }
    if (!ok) {
      soundBuffers[type] = null;
      console.warn(`音效文件 ${type} 加载失败，该类型音效将被跳过`);
    }
  }
}

// 修改：Web Audio 播放函数
async function playSound(type) {
  // 统一防抖：页面不可见、未解锁或上下文未运行时不创建音源，直接跳过以避免回放堆积
  if (document.visibilityState !== 'visible') {
    console.warn(`Skip ${type}: page hidden`);
    return;
  }
  if (!audioUserInteracted) {
    console.warn(`Skip ${type}: audio not unlocked`);
    return;
  }
  if (!soundEnabled || !audioContext || !soundBuffers[type]) {
    console.warn(`Cannot play ${type}: not enabled/unlocked or buffer missing`);
    return;
  }
  if (audioContext.state !== 'running') {
    console.warn(`Skip ${type}: audioContext state = ${audioContext.state}`);
    return;
  }

  try {
    // 假设：每次用户交互（如点击按钮）都已调用 unlockAudioContext() 确保上下文是 Running 或 Suspended
    // 并且如果被关闭（closed）也已经被重建和重载。

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

  // 确保在尝试播放前，音效缓冲已就绪（仅在新建时）
  if (contextNeedsReload) {
    await initAudio(audioContext);
    console.log('Audio buffers reloaded for new context');
  }

  // 兼容 iOS WebKit 的 "interrupted"/"suspended"：在用户手势中统一 resume
  try {
    if (audioContext.state === 'suspended' || audioContext.state === 'interrupted') {
      await audioContext.resume();
      console.log('AudioContext resumed');
    }
  } catch (e) {
    console.error('Failed to resume AudioContext:', e);
  }

  // iOS 暖机：播放一个极短静音缓冲，确保硬件输出通道真正激活
  try {
    const sampleRate = audioContext.sampleRate || 44100;
    const buffer = audioContext.createBuffer(1, Math.max(1, Math.floor(sampleRate * 0.01)), sampleRate); // 10ms
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    const gain = audioContext.createGain();
    gain.gain.value = 0.00001;
    source.connect(gain);
    gain.connect(audioContext.destination);
    source.start(0);
  } catch (_) { /* 暖机失败可忽略 */ }

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

// 新增：用于缓存玩家和公共牌的DOM元素，以实现增量更新
const playerElements = new Map();
const communityCardElements = [];
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

// playerElements is already declared above (used to cache player DOM elements: playerId -> HTMLElement)
// Avoid redeclaring the same block-scoped variable to prevent "Cannot redeclare block-scoped variable" errors.

function render() {
  if (!state) return;

  if (state.state !== "showdown") {
    revealedHoles = {};
  }

  if (me.room) els.roomDisplay.textContent = `房间号：${me.room}`;

  // --- Community Cards ---
  const communityContainer = els.community;
  const newCards = state.community || [];

  // 1. Remove excess cards (e.g. new game started)
  while (communityCardElements.length > newCards.length) {
    const el = communityCardElements.pop();
    el.remove();
  }

  // 2. Update or Add cards
  newCards.forEach((c, i) => {
    const cardSig = JSON.stringify(c);

    if (i < communityCardElements.length) {
      // Existing card slot
      const existingEl = communityCardElements[i];
      if (existingEl.dataset.sig !== cardSig) {
        // Card changed
        const newEl = document.createElement("div");
        newEl.className = "card";
        newEl.dataset.sig = cardSig;
        newEl.appendChild(makeCardSVG(c, true));

        communityContainer.replaceChild(newEl, existingEl);
        communityCardElements[i] = newEl;
      }
    } else {
      // New card
      const newEl = document.createElement("div");
      newEl.className = "card";
      newEl.dataset.sig = cardSig;
      newEl.appendChild(makeCardSVG(c, true));

      communityContainer.appendChild(newEl);
      communityCardElements.push(newEl);

      // Animate only new cards
      newEl.animate([
        { transform: `translate(0, -50px) scale(0.5)`, opacity: 0 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1 }
      ], {
        duration: 500,
        easing: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        fill: 'forwards'
      });
    }
  });

  // --- Pot Display ---
  const potTotal = state.potTotal || 0;
  els.potDisplay.innerHTML = `<span>底池总额：${potTotal}</span>`;

  // --- Players Rendering ---
  const players = (state.players || []).slice();

  const tableRect = document.getElementById("table-area").getBoundingClientRect();
  const cx = tableRect.left + tableRect.width / 2;
  const cy = tableRect.top + tableRect.height / 2;
  const halfWidth = tableRect.width / 2 * 0.8;
  const halfHeight = tableRect.height / 2 * 0.8;
  const sideOffset = tableRect.height * 0.15;
  const MAX_PLAYERS = 6;

  const hFactor = 1.0;
  const vFactor = 1.6;
  const uiSeatPositions = [
    { x: cx, y: cy + halfHeight }, // 6 o'clock
    { x: cx - hFactor * halfWidth, y: cy + vFactor * sideOffset }, // 8
    { x: cx - hFactor * halfWidth, y: cy - vFactor * sideOffset }, // 10
    { x: cx, y: cy - halfHeight }, // 12
    { x: cx + hFactor * halfWidth, y: cy - vFactor * sideOffset }, // 2
    { x: cx + hFactor * halfWidth, y: cy + vFactor * sideOffset }, // 4
  ];

  const myPlayer = state.players.find(p => p.playerId === me.playerId);
  const mySeat = myPlayer ? myPlayer.seat : null;

  const activeIds = new Set();

  for (const p of players) {
    if (!p.connected && !p.inHand) continue;

    activeIds.add(p.playerId);

    let relativeSeat;
    if (mySeat !== null) {
      relativeSeat = (p.seat - mySeat + MAX_PLAYERS) % MAX_PLAYERS;
    } else {
      relativeSeat = p.seat;
    }

    const pos = uiSeatPositions[relativeSeat];
    let x = pos.x;
    let y = pos.y;
    if (window.visualViewport) {
      x += window.visualViewport.offsetLeft || 0;
      y += window.visualViewport.offsetTop || 0;
    }

    // Get or create wrapper
    let wrap = playerElements.get(p.playerId);
    if (!wrap) {
      wrap = createPlayerDOM(p);
      els.playersLayer.appendChild(wrap);
      playerElements.set(p.playerId, wrap);
    }

    // Update position
    wrap.style.left = `${x}px`;
    wrap.style.top = `${y}px`;

    // Update internal content
    updatePlayerDOM(wrap, p, state, myHole, revealedHoles);
  }

  // Remove players who left
  for (const [pid, wrap] of playerElements) {
    if (!activeIds.has(pid)) {
      wrap.remove();
      playerElements.delete(pid);
      playerStateCache.delete(pid); // Clean up animation cache
    }
  }

  // --- Actions UI ---
  updateActionUI();
}

function createPlayerDOM(p) {
  const wrap = document.createElement("div");
  wrap.className = "player-wrap";
  // Initial structure
  wrap.innerHTML = `
        <div class="hand"></div>
        <div class="player-box">
            <div class="name"></div>
            <div class="chips"></div>
            <div class="action"></div>
        </div>
    `;
  return wrap;
}

const playerStateCache = new Map(); // Store previous state for animation triggers

function updatePlayerDOM(wrap, p, state, myHole, revealedHoles) {
  const handDiv = wrap.querySelector(".hand");
  const box = wrap.querySelector(".player-box");
  const nameEl = box.querySelector(".name");
  const chipsEl = box.querySelector(".chips");
  const actionEl = box.querySelector(".action");

  // 1. Update Classes
  const classes = ["player-box"];
  if (p.playerId === me.playerId) classes.push("me");
  if (p.folded) classes.push("folded");
  if (!p.connected) classes.push("disconnected");
  if (p.seat === state.dealerSeat) classes.push("dealer");

  const isActing = p.playerId === state.currentToAct && ["preflop", "flop", "turn", "river"].includes(state.state);
  if (isActing) classes.push("acting");

  if (p.lastAction && p.lastAction.toUpperCase().includes("WIN")) classes.push("winner");

  const newClassName = classes.join(" ");
  if (box.className !== newClassName) {
    box.className = newClassName;
  }

  // 2. Update Progress Bar (CSS Variable)
  if (isActing && actDeadline) {
    const clientCorrectedTime = Date.now() - clockOffset;
    const remainingMs = Math.max(0, actDeadline - clientCorrectedTime);
    const progress = (remainingMs / turnDuration) * 100;
    box.style.setProperty('--progress', `${progress}%`);
  } else {
    box.style.removeProperty('--progress');
  }

  // 3. Update Text
  const dealerIcon = (p.seat === state.dealerSeat) ? '<span class="dealer-icon">🔄</span>' : '';
  const clockIcon = isActing ? '⏳' : '';
  const newNameHtml = `${p.name} ${dealerIcon} ${clockIcon}`;
  if (nameEl.innerHTML !== newNameHtml) {
    nameEl.innerHTML = newNameHtml;
  }

  const newChipsText = `筹码：${p.chips}`;
  if (chipsEl.textContent !== newChipsText) {
    chipsEl.textContent = newChipsText;
  }

  let actionText = "";
  if (p.lastAction) {
    if (p.allIn) actionText = "All-In";
    else if (p.lastAmount === 0) actionText = p.lastAction;
    else actionText = `${p.lastAction} ${p.lastAmount}`;
  }
  if (actionEl.textContent !== actionText) {
    actionEl.textContent = actionText;
  }

  // 4. Update Cards (Diffing)
  const showFace = (p.playerId === me.playerId) || (state.state === "showdown" && !p.folded) || (revealedHoles && revealedHoles[p.playerId]);

  let cardData = [];
  if (p.inHand && !p.folded) {
    if (showFace) {
      cardData = (p.playerId === me.playerId) ? myHole : (revealedHoles[p.playerId] || p.hole || []);
    } else {
      cardData = ["back", "back"];
    }
  }

  // Create a signature for the cards to check if update is needed
  const oldSig = handDiv.dataset.sig;
  const newSig = JSON.stringify(cardData);

  if (oldSig !== newSig) {
    // Check if this is a reveal (back -> face)
    let oldCards = [];
    try { oldCards = JSON.parse(oldSig || "[]"); } catch (e) { }
    const isReveal = oldCards.length > 0 && oldCards.every(c => c === "back") && cardData.length > 0 && cardData.some(c => c !== "back");

    handDiv.innerHTML = "";
    handDiv.dataset.sig = newSig;

    for (const c of cardData) {
      const cardEl = document.createElement("div");
      cardEl.className = c === "back" ? "card back" : "card";
      cardEl.appendChild(makeCardSVG(c));
      handDiv.appendChild(cardEl);

      // Animation
      if (cardData.length > 0) {
        if (isReveal) {
          // Reveal Animation: Flip in place
          cardEl.animate([
            { transform: 'perspective(600px) rotateY(90deg)', opacity: 0.5 },
            { transform: 'perspective(600px) rotateY(0deg)', opacity: 1 }
          ], {
            duration: 400,
            easing: 'ease-out',
            fill: 'forwards'
          });
        } else {
          // Deal Animation: Fly in from center
          const rect = cardEl.getBoundingClientRect();
          if (rect.width > 0) {
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            const dx = cx - (rect.left + rect.width / 2);
            const dy = cy - (rect.top + rect.height / 2);

            cardEl.animate([
              { transform: `translate(${dx}px, ${dy}px) scale(0.1)`, opacity: 0 },
              { transform: 'translate(0, 0) scale(1)', opacity: 1 }
            ], {
              duration: 500,
              easing: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              fill: 'forwards'
            });
          }
        }
      }
    }
  }

  // 5. Chip Animations
  let cache = playerStateCache.get(p.playerId);
  const currentChips = p.chips;
  const currentAmount = p.lastAmount || 0;
  const isGameStage = ["preflop", "flop", "turn", "river"].includes(state.state);

  if (!cache) {
    cache = { lastAmount: currentAmount, chips: currentChips, hasWon: false };
    playerStateCache.set(p.playerId, cache);

    // Initial animation check (e.g. refresh page or join mid-game)
    if (currentAmount > 0 && isGameStage) {
      const chipCount = Math.min(8, Math.ceil(currentAmount / 10));
      animateChips(box, els.potDisplay, Math.max(1, chipCount));
    }
  } else {
    // Check for Chips Decrease (Betting)
    const chipsDecreased = cache.chips - currentChips;
    if (isGameStage && chipsDecreased > 0) {
      const chipCount = Math.min(8, Math.ceil(chipsDecreased / 10));
      animateChips(box, els.potDisplay, Math.max(1, chipCount));
    }
    cache.chips = currentChips;
    cache.lastAmount = currentAmount;
  }

  // Check for Win
  const isWinner = p.lastAction && p.lastAction.toUpperCase().includes("WIN");
  if (isWinner && !cache.hasWon) {
    animateChips(els.potDisplay, box, 12);
  }
  cache.hasWon = isWinner;
}

function animateChips(fromEl, toEl, count = 1) {
  if (!fromEl || !toEl) return;
  const tableArea = document.getElementById("table-area");
  if (!tableArea) return;

  const tableRect = tableArea.getBoundingClientRect();
  const startRect = fromEl.getBoundingClientRect();
  const endRect = toEl.getBoundingClientRect();

  // If elements are not visible, skip
  if (startRect.width === 0 || endRect.width === 0) return;

  // Calculate scale factor (table-area is scaled via CSS transform)
  const scale = tableArea.offsetWidth ? (tableRect.width / tableArea.offsetWidth) : 1;

  // Calculate coordinates relative to table-area, adjusting for scale
  const startX = (startRect.left + startRect.width / 2 - tableRect.left) / scale;
  const startY = (startRect.top + startRect.height / 2 - tableRect.top) / scale;
  const endX = (endRect.left + endRect.width / 2 - tableRect.left) / scale;
  const endY = (endRect.top + endRect.height / 2 - tableRect.top) / scale;

  for (let i = 0; i < count; i++) {
    const chip = document.createElement("div");
    chip.className = "flying-chip";
    // Set initial position relative to table-area
    chip.style.left = `${startX}px`;
    chip.style.top = `${startY}px`;
    chip.style.position = 'absolute'; // Critical for relative positioning

    // Random jitter
    const jitterX = (Math.random() - 0.5) * 20;
    const jitterY = (Math.random() - 0.5) * 20;
    chip.style.transform = `translate(${jitterX}px, ${jitterY}px)`;

    tableArea.appendChild(chip); // Append to table-area instead of body

    // Animate
    const duration = 600 + Math.random() * 200;
    const delay = i * 50;

    chip.animate([
      { transform: `translate(${jitterX}px, ${jitterY}px) scale(1)`, opacity: 1 },
      { transform: `translate(${endX - startX}px, ${endY - startY}px) scale(0.8)`, opacity: 0.5 }
    ], {
      duration: duration,
      delay: delay,
      easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
      fill: 'forwards'
    }).onfinish = () => chip.remove();
  }
}

function updateActionUI() {
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
    if (actDeadline && turnDuration) {
      const clientCorrectedTime = Date.now() - clockOffset;
      const remainingMs = Math.max(0, actDeadline - clientCorrectedTime);
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      tip += ` ｜ 剩余时间：${remainingSeconds}秒`;
    }
    els.tips.textContent = tip;

    if (document.activeElement !== els.raiseBy) {
      els.raiseBy.value = Math.max(actionOpts.minRaiseSize || 0, lastRaiseAmount || 0);
    }
    els.raiseBy.min = Math.max(actionOpts.minRaiseSize, 0);
    if (actionOpts.maxRaiseSize) els.raiseBy.max = actionOpts.maxRaiseSize;
    else els.raiseBy.removeAttribute("max");
  } else {
    els.tips.textContent = (state?.state === "waiting" ? "等待下一局开始…" : "等待他人行动…");
  }
}

socket.on("disconnect", () => {
  // 清理所有玩家元素，以便重连后重新创建
  playerElements.forEach(el => el.remove());
  playerElements.clear();
});
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
  // 收紧守卫：仅在页面可见 + 已解锁 + 上下文 running 时响应，其他情况直接丢弃以避免回放堆积
  if (
    document.visibilityState !== 'visible' ||
    !audioUserInteracted ||
    !audioContext ||
    audioContext.state !== 'running'
  ) {
    console.log('Skipping play_sound due to guard (hidden/locked/not-running):', type);
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
    savedPlayerId = ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
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

  // 新增：监听页面可见/焦点变化，刷新 UI + 标记需手势解锁，避免在非手势中重建/解锁
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      // 立即刷新倒计时 (UI 冻结修复)
      socket.emit('sync_state');
      render();

      // 不再在此关闭/重建 AudioContext，避免丢失已获得的手势信任
      // 仅标记需要用户再次交互以确保硬件输出恢复
      audioUserInteracted = false;

      // 重新启动计时器逻辑
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
      const clientCorrectedTime = Date.now() - clockOffset;
      if (actDeadline && actDeadline - clientCorrectedTime < -1000) {
        socket.emit('sync_state');
      }
    } else if (document.visibilityState === 'hidden') {
      // 后台强制挂起，避免在后台创建音源导致回放堆积
      try { audioContext && audioContext.suspend && audioContext.suspend(); } catch (_) { }
    }
  });

  // iOS 上部分场景会触发 BFCache，使用 pageshow 标记重新需要手势解锁
  window.addEventListener('pageshow', () => {
    audioUserInteracted = false;
  });
  // 可选：pagehide 时尝试挂起，避免后台占用（不影响前台恢复，因为恢复要靠手势）
  window.addEventListener('pagehide', () => {
    try { audioContext && audioContext.suspend && audioContext.suspend(); } catch (_) { }
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

  // 全局一次性手势解锁（pointer/touch/keydown 任一触发）
  const globalUnlock = async () => {
    if (!audioUserInteracted) {
      await unlockAudioContext();
    }
    document.removeEventListener('pointerdown', globalUnlock, true);
    document.removeEventListener('touchstart', globalUnlock, true);
    document.removeEventListener('keydown', globalUnlock, true);
  };
  document.addEventListener('pointerdown', globalUnlock, true);
  document.addEventListener('touchstart', globalUnlock, true);
  document.addEventListener('keydown', globalUnlock, true);
});

// 保留 join/create 中的 unlock
els.joinBtn.addEventListener("click", async () => {
  const name = (els.nameInput.value || "").trim() || ("Player" + Math.floor(Math.random() * 1000));
  const room = (els.roomInput.value || "").trim();
  me.name = name;
  setWithExpiry('pokerUsername', name);
  const joinData = { name, room, playerId: me.playerId };
  socket.emit("join", joinData);
  if (!audioUserInteracted) {
    unlockAudioContext();
  }
});

els.createBtn.addEventListener("click", async () => {  // 修改：添加 async
  const name = (els.nameInput.value || "").trim() || ("Player" + Math.floor(Math.random() * 1000));
  me.name = name;
  setWithExpiry('pokerUsername', name);
  socket.emit("createRoom", { name, playerId: me.playerId });
  if (!audioUserInteracted) {
    unlockAudioContext();
  }
});

els.nameInput.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("join-btn").click(); });
els.roomInput.addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("join-btn").click(); });

// 在所有行动按钮添加音频解锁（e.g., btnFold）
els.btnFold.addEventListener("click", async () => {
  socket.emit("action", { type: "fold" });
  if (!audioUserInteracted) {
    await unlockAudioContext();
  }
  playSound('fold');
});

// 类似：btnCallCheck, btnRaise, raiseBy keydown
els.btnCallCheck.addEventListener("click", async () => {
  if (els.btnCallCheck.disabled) return; // 防止非回合时本地触发
  if (actionOpts.canCheck) {
    socket.emit("action", { type: "check" });
    if (!audioUserInteracted) {
      await unlockAudioContext();
    }
    playSound('check');
  } else {
    socket.emit("action", { type: "call" });
    if (!audioUserInteracted) {
      await unlockAudioContext();
    }
    playSound('bet');
  }
});

els.btnRaise.addEventListener("click", async () => {
  sendRaiseAction();
  if (!audioUserInteracted) {
    await unlockAudioContext();
  }
  playSound('bet');
});

els.raiseBy.addEventListener("keydown", async e => {
  if (e.key === "Enter") {
    sendRaiseAction();
    if (!audioUserInteracted) {
      await unlockAudioContext();
    }
    playSound('bet');
  }
});

// 【在现有的事件监听器之后，添加键盘快捷键逻辑】
window.addEventListener('keydown', async (e) => {
  if (!audioUserInteracted) { await unlockAudioContext(); }
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
        playSound('bet'); // 本地播放加注音效
        sendRaiseAction();
      }
      break;

    case 'C': // C: Call (跟注)
      e.preventDefault();
      // 如果不是过牌模式 (canCheck=false) 且按钮没有禁用
      if (!actionOpts.canCheck && !els.btnCallCheck.disabled) {
        playSound('bet'); // 跟注使用 'bet' 音效
        socket.emit("action", { type: "call" });
      }
      break;

    case 'K': // K: Check (过牌)
      e.preventDefault();
      // 如果是过牌模式 (canCheck=true) 且按钮没有禁用
      if (actionOpts.canCheck && !els.btnCallCheck.disabled) {
        playSound('check'); // 本地播放过牌音效
        socket.emit("action", { type: "check" });
      }
      break;

    case 'F': // F: Fold (弃牌)
      e.preventDefault();
      if (!els.btnFold.disabled) {
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