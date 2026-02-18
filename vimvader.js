#!/usr/bin/env node
'use strict';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const ESC = '\x1b';
const CSI = ESC + '[';

const ansi = {
  clear:       () => CSI + '2J',
  home:        () => CSI + 'H',
  moveTo:      (r, c) => `${CSI}${r};${c}H`,
  hideCursor:  () => CSI + '?25l',
  showCursor:  () => CSI + '?25h',
  reset:       () => ESC + 'c',
  bold:        (s) => `${CSI}1m${s}${CSI}0m`,
  color:       (code, s) => `${CSI}${code}m${s}${CSI}0m`,
};

// ── Terminal size ─────────────────────────────────────────────────────────────
function getSize() {
  const cols = process.stdout.columns  || 80;
  const rows = process.stdout.rows     || 24;
  return { cols, rows };
}

// ── Game constants ────────────────────────────────────────────────────────────
const PLAYER_CHAR  = '▲';
const BULLET_CHAR  = '|';
const INVADER_CHAR = '👾';
const INVADER_W    = 2;   // emoji width in terminal cells

const FPS          = 15;
const FRAME_MS     = 1000 / FPS;

const INVADER_COLS = 8;
const INVADER_ROWS = 3;
const INVADER_DROP = 3;   // frames between enemy moves
const HUD_ROWS     = 2;   // top/bottom HUD height

// ── State ─────────────────────────────────────────────────────────────────────
let mode        = 'NORMAL';  // 'NORMAL' | 'INSERT'
let score       = 0;
let gameOver    = false;
let gameOverMsg = '';
let frame       = 0;
let invaderDir  = 1;        // 1 = right, -1 = left

let { cols, rows } = getSize();
let fieldRows = rows - HUD_ROWS * 2;  // playable rows

let player = { x: Math.floor(cols / 2), y: rows - HUD_ROWS };

// Invaders: each cell has { alive: bool }
let invaders = [];
let invaderOX = 2;  // origin-X (leftmost column of invader grid)
let invaderOY = HUD_ROWS + 1;

function initInvaders() {
  invaders = [];
  for (let r = 0; r < INVADER_ROWS; r++) {
    invaders[r] = [];
    for (let c = 0; c < INVADER_COLS; c++) {
      invaders[r][c] = { alive: true };
    }
  }
  invaderOX = 2;
  invaderOY = HUD_ROWS + 1;
  invaderDir = 1;
}

let bullets = [];  // { x, y, ch }

// ── Render ────────────────────────────────────────────────────────────────────
const buf = [];

function put(row, col, text) {
  buf.push(ansi.moveTo(row, col) + text);
}

function render() {
  buf.length = 0;
  buf.push(ansi.home());

  const { cols: W, rows: H } = getSize();

  // ── Top HUD ──
  const hudLeft  = `── VIMVADER ── Score: ${score} ──`;
  const hudRight = `[${mode}]`;
  const padding  = Math.max(0, W - hudLeft.length - hudRight.length - 2);
  put(1, 1, ansi.bold(ansi.color('36', `${hudLeft} ${' '.repeat(padding)} ${hudRight}`)));

  // ── Bottom HUD ──
  const help = mode === 'NORMAL'
    ? 'h/j/k/l: Move  i: Insert Mode  q: Quit'
    : 'Type to shoot  ESC: Normal Mode';
  const helpPad = Math.floor((W - help.length) / 2);
  put(H, 1, ansi.color('33', ' '.repeat(helpPad) + help));

  // ── Clear field (erase previous frame without full clear = no flicker) ──
  for (let r = HUD_ROWS + 1; r <= H - HUD_ROWS; r++) {
    put(r, 1, ' '.repeat(W));
  }

  // ── Invaders ──
  for (let r = 0; r < INVADER_ROWS; r++) {
    for (let c = 0; c < INVADER_COLS; c++) {
      if (!invaders[r][c].alive) continue;
      const row = invaderOY + r;
      const col = invaderOX + c * (INVADER_W + 1);
      if (row >= HUD_ROWS + 1 && row <= H - HUD_ROWS) {
        put(row, col, INVADER_CHAR);
      }
    }
  }

  // ── Bullets ──
  for (const b of bullets) {
    if (b.y >= HUD_ROWS + 1 && b.y <= H - HUD_ROWS) {
      put(b.y, b.x, ansi.color('32', b.ch));
    }
  }

  // ── Player ──
  put(player.y, player.x, ansi.color('34', PLAYER_CHAR));

  // ── Game Over overlay ──
  if (gameOver) {
    const msg1 = gameOverMsg;
    const msg2 = `Score: ${score}  –  Press q to quit`;
    const midR = Math.floor(H / 2);
    put(midR,   Math.floor((W - msg1.length) / 2) + 1, ansi.bold(ansi.color('31', msg1)));
    put(midR+1, Math.floor((W - msg2.length) / 2) + 1, ansi.color('33', msg2));
  }

  process.stdout.write(buf.join(''));
}

// ── Bullet/Invader collision ──────────────────────────────────────────────────
function checkCollisions() {
  const toRemoveBullets = new Set();

  for (let bi = 0; bi < bullets.length; bi++) {
    const b = bullets[bi];
    for (let r = 0; r < INVADER_ROWS; r++) {
      for (let c = 0; c < INVADER_COLS; c++) {
        if (!invaders[r][c].alive) continue;
        const ix = invaderOX + c * (INVADER_W + 1);
        const iy = invaderOY + r;
        // bullet hits if it's in the invader's 2-cell span
        if (b.y === iy && b.x >= ix && b.x < ix + INVADER_W) {
          invaders[r][c].alive = false;
          score += 10;
          toRemoveBullets.add(bi);
        }
      }
    }
  }

  bullets = bullets.filter((_, i) => !toRemoveBullets.has(i));
}

// ── Game logic ────────────────────────────────────────────────────────────────
function invaderBounds() {
  let minC = INVADER_COLS, maxC = -1;
  for (let r = 0; r < INVADER_ROWS; r++) {
    for (let c = 0; c < INVADER_COLS; c++) {
      if (invaders[r][c].alive) {
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }
  let maxR = -1;
  for (let r = INVADER_ROWS - 1; r >= 0; r--) {
    for (let c = 0; c < INVADER_COLS; c++) {
      if (invaders[r][c].alive) { maxR = r; break; }
    }
    if (maxR >= 0) break;
  }
  return { minC, maxC, maxR };
}

function allDead() {
  return invaders.every(row => row.every(cell => !cell.alive));
}

function tick() {
  if (gameOver) return;

  const { cols: W, rows: H } = getSize();

  // Move bullets
  bullets = bullets.filter(b => b.y > HUD_ROWS);
  for (const b of bullets) b.y--;

  // Move invaders every INVADER_DROP frames
  if (frame % INVADER_DROP === 0) {
    const { minC, maxC, maxR } = invaderBounds();

    const leftEdge  = invaderOX + minC * (INVADER_W + 1);
    const rightEdge = invaderOX + maxC * (INVADER_W + 1) + INVADER_W;

    if (invaderDir === 1 && rightEdge >= W - 1) {
      invaderOY++;
      invaderDir = -1;
    } else if (invaderDir === -1 && leftEdge <= 2) {
      invaderOY++;
      invaderDir = 1;
    } else {
      invaderOX += invaderDir;
    }

    // Check if invaders reached player row
    const bottomRow = invaderOY + maxR;
    if (bottomRow >= H - HUD_ROWS) {
      gameOver    = true;
      gameOverMsg = '💀  GAME OVER  💀';
      return;
    }
  }

  checkCollisions();

  if (allDead()) {
    // Next wave
    initInvaders();
    score += 100;
  }

  frame++;
}

// ── Input ─────────────────────────────────────────────────────────────────────
function handleInput(data) {
  const { cols: W, rows: H } = getSize();

  if (gameOver) {
    if (data === 'q') cleanup();
    return;
  }

  const fieldTop    = HUD_ROWS + 1;
  const fieldBottom = H - HUD_ROWS;

  if (mode === 'NORMAL') {
    switch (data) {
      case 'h': player.x = Math.max(1,          player.x - 1); break;
      case 'l': player.x = Math.min(W,          player.x + 1); break;
      case 'k': player.y = Math.max(fieldTop,   player.y - 1); break;
      case 'j': player.y = Math.min(fieldBottom, player.y + 1); break;
      case 'i': mode = 'INSERT'; break;
      case 'q': cleanup(); break;
    }
  } else if (mode === 'INSERT') {
    if (data === '\x1b') {
      mode = 'NORMAL';
    } else if (data.length === 1 && data >= ' ' && data <= '~') {
      // Fire bullet using the typed character
      bullets.push({ x: player.x, y: player.y - 1, ch: data });
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
let loopTimer = null;

function cleanup() {
  if (loopTimer) clearInterval(loopTimer);
  process.stdout.write(ansi.showCursor());
  process.stdout.write(ansi.moveTo(getSize().rows + 1, 1));
  process.stdout.write('\nThanks for playing VimVader! 👾\n');
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(0);
}

function start() {
  // Setup stdin
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', handleInput);

  // Handle resize
  process.stdout.on('resize', () => {
    ({ cols, rows } = getSize());
    player.x = Math.min(player.x, cols);
  });

  // Hide cursor, clear screen
  process.stdout.write(ansi.hideCursor() + ansi.clear());

  initInvaders();

  // Game loop
  let last = Date.now();
  loopTimer = setInterval(() => {
    const now = Date.now();
    if (now - last >= FRAME_MS) {
      tick();
      render();
      last = now;
    }
  }, Math.floor(FRAME_MS / 2));  // poll at 2× rate, update on interval

  // Catch Ctrl+C
  process.on('SIGINT', cleanup);
}

start();
