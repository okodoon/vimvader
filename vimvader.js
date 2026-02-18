#!/usr/bin/env node
'use strict';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const ESC = '\x1b';
const CSI = ESC + '[';
const ansi = {
  clear:      () => CSI + '2J',
  home:       () => CSI + 'H',
  moveTo:     (r, c) => `${CSI}${r};${c}H`,
  hideCursor: () => CSI + '?25l',
  showCursor: () => CSI + '?25h',
  bold:       (s) => `${CSI}1m${s}${CSI}0m`,
  dim:        (s) => `${CSI}2m${s}${CSI}0m`,
  color:      (code, s) => `${CSI}${code}m${s}${CSI}0m`,
};

// ── Constants ─────────────────────────────────────────────────────────────────
const PLAYER_CHAR = '▲';
const CORE_CHAR   = 'v';   // 'v' = vulnerable core, match with 'v' bullet
const BLOCK_CHAR  = '■';   // any bullet destroys this
const CELL_GAP    = 2;     // column stride between cells (cells at x, x+2, x+4...)
const ENEMY_COLS  = 3;
const ENEMY_ROWS  = 3;
const ENEMY_W     = (ENEMY_COLS - 1) * CELL_GAP + 1; // visual width = 5

const HUD_TOP     = 1;
const HUD_BOT     = 1;
const FPS         = 15;
const FRAME_MS    = 1000 / FPS;
const H_MOVE_FRAMES = 8;   // frames between horizontal enemy moves
const V_DROP_ROWS   = 1;   // rows to drop when hitting wall

// Character pool for enemy armour cells (no 'v')
const CHAR_POOL = 'abcdefghijklmnopqrstuwxyz';  // 'v' intentionally absent
function randChar() {
  return CHAR_POOL[Math.floor(Math.random() * CHAR_POOL.length)];
}

// ── Enemy factory ─────────────────────────────────────────────────────────────
//
//  Enemy layout (3×3):
//    col  0   2   4
//  row 0: [A] [■] [B]
//  row 1: [■] [v] [■]   ← v is the core
//  row 2: [C] [■] [D]
//
//  Shoot matching char to remove char cells.
//  Shoot anything  to remove ■ cells.
//  Shoot 'v'       to kill the enemy instantly.
//
function createEnemy(ex, ey) {
  const cells = [];
  for (let r = 0; r < ENEMY_ROWS; r++) {
    cells[r] = [];
    for (let c = 0; c < ENEMY_COLS; c++) {
      if (r === Math.floor(ENEMY_ROWS / 2) && c === Math.floor(ENEMY_COLS / 2)) {
        // Core
        cells[r][c] = { type: 'core', ch: CORE_CHAR, alive: true };
      } else {
        // Randomly assign ■ or a letter
        const isBlock = Math.random() < 0.45;
        cells[r][c] = isBlock
          ? { type: 'block', ch: BLOCK_CHAR, alive: true }
          : { type: 'char',  ch: randChar(), alive: true };
      }
    }
  }
  return { x: ex, y: ey, cells, alive: true };
}

// ── State ─────────────────────────────────────────────────────────────────────
let mode        = 'NORMAL';
let score       = 0;
let frame       = 0;
let gameOver    = false;
let gameOverMsg = '';
let invDir      = 1;   // +1 = right, -1 = left
let enemies     = [];
let bullets     = [];  // { x, y, ch }
let player      = { x: 40, y: 20 };
let lastShot    = '';  // last char typed (for HUD hint)

function getSize() {
  return {
    W: process.stdout.columns || 80,
    H: process.stdout.rows    || 24,
  };
}

// ── Wave ──────────────────────────────────────────────────────────────────────
function spawnWave() {
  const { W } = getSize();
  const count   = 3;
  const spacing = Math.floor(W / (count + 1));
  invDir = 1;
  for (let i = 0; i < count; i++) {
    const ex = spacing * (i + 1) - Math.floor(ENEMY_W / 2);
    const ey = HUD_TOP + 2;
    enemies.push(createEnemy(ex, ey));
  }
}

function initGame() {
  const { W, H } = getSize();
  player   = { x: Math.floor(W / 2), y: H - HUD_BOT - 1 };
  enemies  = [];
  bullets  = [];
  frame    = 0;
  score    = 0;
  mode     = 'NORMAL';
  gameOver = false;
  gameOverMsg = '';
  lastShot = '';
  spawnWave();
}

// ── Render ────────────────────────────────────────────────────────────────────
const buf = [];

function render() {
  const { W, H } = getSize();
  buf.length = 0;
  buf.push(ansi.home());

  // ── Top HUD
  const modeStr = mode === 'NORMAL' ? ansi.color('36', '[NORMAL]') : ansi.color('35', '[INSERT]');
  const hudL = `VIMVADER  Score: ${String(score).padStart(6, ' ')}`;
  const gap  = Math.max(1, W - hudL.length - 10);
  buf.push(ansi.moveTo(1, 1) + ansi.bold(ansi.color('36', '── ')) +
           ansi.bold(hudL) +
           ' '.repeat(gap) + modeStr +
           ansi.bold(ansi.color('36', ' ──')));

  // ── Clear field
  const fieldTop = HUD_TOP + 1;
  const fieldBot = H - HUD_BOT - 1;
  for (let r = fieldTop; r <= fieldBot; r++) {
    buf.push(ansi.moveTo(r, 1) + ' '.repeat(W));
  }

  // ── Enemies
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    for (let r = 0; r < ENEMY_ROWS; r++) {
      for (let c = 0; c < ENEMY_COLS; c++) {
        const cell = enemy.cells[r][c];
        if (!cell.alive) continue;
        const sx = enemy.x + c * CELL_GAP;
        const sy = enemy.y + r;
        if (sy < fieldTop || sy > fieldBot || sx < 1 || sx > W) continue;
        let ch;
        if (cell.type === 'core') {
          ch = ansi.bold(ansi.color('31', cell.ch));   // red bold  ← shoot 'v' here!
        } else if (cell.type === 'block') {
          ch = ansi.color('90', cell.ch);              // dark gray ← any char works
        } else {
          ch = ansi.color('33', cell.ch);              // yellow    ← need matching char
        }
        buf.push(ansi.moveTo(sy, sx) + ch);
      }
    }
  }

  // ── Bullets
  for (const b of bullets) {
    if (b.y >= fieldTop && b.y <= fieldBot && b.x >= 1 && b.x <= W) {
      buf.push(ansi.moveTo(b.y, b.x) + ansi.color('32', b.ch));
    }
  }

  // ── Player
  buf.push(ansi.moveTo(player.y, player.x) + ansi.bold(ansi.color('34', PLAYER_CHAR)));

  // ── Bottom HUD
  let help;
  if (mode === 'NORMAL') {
    help = ' h/j/k/l: Move  i: Insert  q: Quit ';
  } else {
    const hint = lastShot ? `  last: '${lastShot}'` : '';
    help = ` Type to shoot (■=any  letter=match  v=core)${hint}  ESC: Normal `;
  }
  buf.push(ansi.moveTo(H - 1, 1) + ansi.color('33', help.slice(0, W).padEnd(W)));

  // ── Legend (bottom row)
  const legend = `  ${ansi.color('90', '■')} any  ${ansi.color('33', 'A')} match char  ${ansi.bold(ansi.color('31', 'v'))} core → kill  `;
  buf.push(ansi.moveTo(H, 1) + legend);

  // ── Game over overlay
  if (gameOver) {
    const m1 = gameOverMsg;
    const m2 = `Score: ${score}  ─  Press q to quit`;
    buf.push(ansi.moveTo(Math.floor(H / 2),     Math.floor((W - m1.length) / 2) + 1) +
             ansi.bold(ansi.color('31', m1)));
    buf.push(ansi.moveTo(Math.floor(H / 2) + 1, Math.floor((W - m2.length) / 2) + 1) +
             ansi.bold(ansi.color('33', m2)));
  }

  process.stdout.write(buf.join(''));
}

// ── Collision ─────────────────────────────────────────────────────────────────
// Returns true if bullet was consumed (hit something)
function hitTest(b) {
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    for (let r = 0; r < ENEMY_ROWS; r++) {
      for (let c = 0; c < ENEMY_COLS; c++) {
        const cell = enemy.cells[r][c];
        if (!cell.alive) continue;
        const cx = enemy.x + c * CELL_GAP;
        const cy = enemy.y + r;
        if (b.x !== cx || b.y !== cy) continue;

        // Hit!
        if (cell.type === 'block') {
          // ■ — any char destroys it
          cell.alive = false;
          score += 5;
          return true;
        } else if (cell.type === 'core') {
          // v — only 'v' kills the enemy
          if (b.ch.toLowerCase() === CORE_CHAR) {
            enemy.alive = false;
            score += 100;
          }
          // whether matched or not, bullet is blocked
          return true;
        } else {
          // letter — only matching char destroys it
          if (b.ch.toLowerCase() === cell.ch.toLowerCase()) {
            cell.alive = false;
            score += 10;
          }
          return true; // bullet always consumed on hit
        }
      }
    }
  }
  return false;
}

// ── Tick ──────────────────────────────────────────────────────────────────────
function tick() {
  if (gameOver) return;
  const { W, H } = getSize();
  const fieldTop = HUD_TOP + 1;
  const fieldBot = H - HUD_BOT - 1;

  // Move bullets upward
  const kept = [];
  for (const b of bullets) {
    b.y--;
    if (b.y < fieldTop) continue;
    if (!hitTest(b)) kept.push(b);
  }
  bullets = kept;

  // Move enemies horizontally every H_MOVE_FRAMES
  if (frame % H_MOVE_FRAMES === 0) {
    // Determine wall hit
    let hitWall = false;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const leftX  = enemy.x;
      const rightX = enemy.x + (ENEMY_COLS - 1) * CELL_GAP;
      if (invDir === 1  && rightX + 1 >= W) hitWall = true;
      if (invDir === -1 && leftX  - 1 <  1) hitWall = true;
    }

    if (hitWall) {
      // Drop down and reverse
      invDir *= -1;
      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        enemy.y += V_DROP_ROWS;
      }
    } else {
      for (const enemy of enemies) {
        if (!enemy.alive) continue;
        enemy.x += invDir;
      }
    }

    // Game over check: enemy cell reaches player's row or below
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      for (let r = 0; r < ENEMY_ROWS; r++) {
        for (let c = 0; c < ENEMY_COLS; c++) {
          if (!enemy.cells[r][c].alive) continue;
          if (enemy.y + r >= fieldBot) {
            gameOver    = true;
            gameOverMsg = '💀  GAME OVER  💀';
            return;
          }
        }
      }
    }
  }

  // Wave clear
  if (enemies.length > 0 && enemies.every(e => !e.alive)) {
    enemies = [];
    score  += 200;
    spawnWave();
  }

  frame++;
}

// ── Input ─────────────────────────────────────────────────────────────────────
function handleInput(data) {
  const { W, H } = getSize();
  const fieldTop = HUD_TOP + 1;
  const fieldBot = H - HUD_BOT - 1;

  if (gameOver) {
    if (data === 'q') cleanup();
    return;
  }

  if (mode === 'NORMAL') {
    switch (data) {
      case 'h': player.x = Math.max(1,        player.x - 1); break;
      case 'l': player.x = Math.min(W,        player.x + 1); break;
      case 'k': player.y = Math.max(fieldTop, player.y - 1); break;
      case 'j': player.y = Math.min(fieldBot, player.y + 1); break;
      case 'i': mode = 'INSERT'; break;
      case 'q': cleanup(); break;
    }
  } else {
    if (data === '\x1b') {
      mode = 'NORMAL';
    } else if (data.length === 1 && data >= ' ' && data <= '~') {
      bullets.push({ x: player.x, y: player.y - 1, ch: data });
      lastShot = data;
    }
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
let loopTimer = null;

function cleanup() {
  if (loopTimer) clearInterval(loopTimer);
  process.stdout.write(ansi.showCursor());
  const { H } = getSize();
  process.stdout.write(ansi.moveTo(H + 1, 1) + '\nThanks for playing VimVader! 👾\n');
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.exit(0);
}

function start() {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', handleInput);
  process.stdout.on('resize', () => {
    const { W, H } = getSize();
    player.x = Math.min(player.x, W);
    player.y = Math.min(player.y, H - HUD_BOT - 1);
  });
  process.stdout.write(ansi.hideCursor() + ansi.clear());
  initGame();
  let last = Date.now();
  loopTimer = setInterval(() => {
    const now = Date.now();
    if (now - last >= FRAME_MS) {
      tick();
      render();
      last = now;
    }
  }, Math.floor(FRAME_MS / 2));
  process.on('SIGINT', cleanup);
}

start();
