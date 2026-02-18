#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

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
  color:      (code, s) => `${CSI}${code}m${s}${CSI}0m`,
};

// ── Enemy design loader ───────────────────────────────────────────────────────
//
//  Place .enemy files in the enemies/ directory (or pass --enemies <dir>).
//
//  File format:
//    # comment lines start with #
//    name: My Enemy      ← optional display name
//    author: yourname    ← optional
//    (blank lines ignored)
//    . * .               ← grid rows: space-separated tokens
//    * v *
//    . * .
//
//  Token meanings:
//    v        → core   (red)  shoot 'v' to kill the enemy
//    * or ■   → block  (gray) any character destroys it
//    a-z, A-Z → char   (yellow) must shoot the SAME character
//    .        → empty  (no cell)
//
//  Rules:
//    • Must contain exactly one 'v' (the core).
//    • Grid can be any size.
//    • Rows don't need to be the same length (short rows are padded with empty).

const CORE_CHAR  = 'v';
const BLOCK_SYMS = new Set(['*', '■', '#']);

function parseDesignFile(filepath) {
  const src   = fs.readFileSync(filepath, 'utf8');
  const lines = src.split('\n');

  const meta  = { name: path.basename(filepath, path.extname(filepath)), author: '' };
  const grid  = [];

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('#')) continue;

    const lower = line.toLowerCase();
    if (lower.startsWith('name:'))   { meta.name   = line.slice(5).trim(); continue; }
    if (lower.startsWith('author:')) { meta.author = line.slice(7).trim(); continue; }

    // Grid row — split by whitespace
    const tokens = line.trim().split(/\s+/);
    grid.push(tokens);
  }

  if (grid.length === 0) return null;

  // Validate: must have exactly one 'v'
  const coreCount = grid.flat().filter(t => t.toLowerCase() === CORE_CHAR).length;
  if (coreCount !== 1) return null;

  const cols = Math.max(...grid.map(r => r.length));
  const rows = grid.length;

  return { ...meta, grid, rows, cols, filepath };
}

function loadDesigns(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => /\.(enemy|txt)$/i.test(f))
    .sort()
    .flatMap(f => {
      try {
        const d = parseDesignFile(path.join(dir, f));
        return d ? [d] : [];
      } catch { return []; }
    });
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CELL_GAP      = 2;   // terminal columns between cells
const HUD_TOP       = 1;
const HUD_BOT       = 2;
const FPS           = 15;
const FRAME_MS      = 1000 / FPS;
const H_MOVE_FRAMES = 8;
const PLAYER_CHAR   = '▲';

// CLI: --enemies <dir>
const args        = process.argv.slice(2);
const edIdx       = args.indexOf('--enemies');
const ENEMIES_DIR = edIdx >= 0 ? path.resolve(args[edIdx + 1]) : path.join(__dirname, 'enemies');

// ── State ─────────────────────────────────────────────────────────────────────
let designs  = [];
let mode     = 'NORMAL';
let score    = 0;
let frame    = 0;
let gameOver = false;
let gameOverMsg = '';
let invDir   = 1;
let enemies  = [];
let bullets  = [];
let player   = { x: 40, y: 20 };
let lastShot = '';

function getSize() {
  return { W: process.stdout.columns || 80, H: process.stdout.rows || 24 };
}

// ── Enemy factory from design ─────────────────────────────────────────────────
function createEnemy(ex, ey, design) {
  const cells = design.grid.map(row =>
    row.map(token => {
      const t = token;
      if (t === '.')                              return { type: 'empty', ch: ' ',   alive: false };
      if (BLOCK_SYMS.has(t))                     return { type: 'block', ch: '■',   alive: true  };
      if (t.toLowerCase() === CORE_CHAR)         return { type: 'core',  ch: CORE_CHAR, alive: true };
      if (/^[a-zA-Z]$/.test(t))                 return { type: 'char',  ch: t.toLowerCase(), alive: true };
      return { type: 'empty', ch: ' ', alive: false };
    })
  );
  return {
    x: ex, y: ey,
    rows: design.rows,
    cols: design.cols,
    cells,
    alive: true,
    name: design.name,
  };
}

// ── Wave spawner ──────────────────────────────────────────────────────────────
function spawnWave() {
  const { W } = getSize();
  if (designs.length === 0) return;

  const count   = Math.min(3, designs.length > 1 ? 3 : 1);
  const spacing = Math.floor(W / (count + 1));

  invDir = 1;
  for (let i = 0; i < count; i++) {
    const design  = designs[Math.floor(Math.random() * designs.length)];
    const enemyW  = (design.cols - 1) * CELL_GAP + 1;
    const ex      = Math.max(1, spacing * (i + 1) - Math.floor(enemyW / 2));
    const ey      = HUD_TOP + 2;
    enemies.push(createEnemy(ex, ey, design));
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

  // Top HUD
  const modeStr = mode === 'NORMAL'
    ? ansi.bold(ansi.color('36', '[NORMAL]'))
    : ansi.bold(ansi.color('35', '[INSERT]'));
  const hudL   = `VIMVADER  Score: ${String(score).padStart(6)}`;
  const gapLen = Math.max(1, W - hudL.length - 12);
  buf.push(
    ansi.moveTo(1, 1) +
    ansi.bold(ansi.color('36', '── ')) +
    ansi.bold(hudL) +
    ' '.repeat(gapLen) + modeStr +
    ansi.bold(ansi.color('36', ' ──'))
  );

  // Clear field
  const fieldTop = HUD_TOP + 1;
  const fieldBot = H - HUD_BOT - 1;
  for (let r = fieldTop; r <= fieldBot; r++) {
    buf.push(ansi.moveTo(r, 1) + ' '.repeat(W));
  }

  // Enemies
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    for (let r = 0; r < enemy.rows; r++) {
      const row = enemy.cells[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (!cell || !cell.alive) continue;
        const sx = enemy.x + c * CELL_GAP;
        const sy = enemy.y + r;
        if (sy < fieldTop || sy > fieldBot || sx < 1 || sx > W) continue;
        let ch;
        if      (cell.type === 'core')  ch = ansi.bold(ansi.color('31', cell.ch));
        else if (cell.type === 'block') ch = ansi.color('90', cell.ch);
        else                            ch = ansi.color('33', cell.ch);
        buf.push(ansi.moveTo(sy, sx) + ch);
      }
    }
  }

  // Bullets
  for (const b of bullets) {
    if (b.y >= fieldTop && b.y <= fieldBot && b.x >= 1 && b.x <= W) {
      buf.push(ansi.moveTo(b.y, b.x) + ansi.color('32', b.ch));
    }
  }

  // Player
  buf.push(ansi.moveTo(player.y, player.x) + ansi.bold(ansi.color('34', PLAYER_CHAR)));

  // Bottom HUD
  const help = mode === 'NORMAL'
    ? 'h/j/k/l: Move  i: Insert  q: Quit'
    : `Type to shoot${lastShot ? `  last:'${lastShot}'` : ''}  ESC: Normal`;
  buf.push(ansi.moveTo(H - 1, 1) + ansi.color('33', help.slice(0, W)));

  // Legend
  const legend = `  ${ansi.color('90', '■')} any  ${ansi.color('33', 'a')} match char  ${ansi.bold(ansi.color('31', 'v'))} core (kill)`;
  buf.push(ansi.moveTo(H, 1) + legend);

  // No designs warning
  if (designs.length === 0) {
    const warn = `[No enemy files in ${ENEMIES_DIR}]`;
    buf.push(ansi.moveTo(Math.floor(H / 2), Math.floor((W - warn.length) / 2)) +
             ansi.bold(ansi.color('31', warn)));
  }

  // Game over
  if (gameOver) {
    const m1 = gameOverMsg;
    const m2 = `Score: ${score}  ─  q to quit`;
    buf.push(ansi.moveTo(Math.floor(H / 2),     Math.floor((W - m1.length) / 2)) +
             ansi.bold(ansi.color('31', m1)));
    buf.push(ansi.moveTo(Math.floor(H / 2) + 1, Math.floor((W - m2.length) / 2)) +
             ansi.bold(ansi.color('33', m2)));
  }

  process.stdout.write(buf.join(''));
}

// ── Collision ─────────────────────────────────────────────────────────────────
function hitTest(b) {
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    for (let r = 0; r < enemy.rows; r++) {
      const row = enemy.cells[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (!cell || !cell.alive) continue;
        const cx = enemy.x + c * CELL_GAP;
        const cy = enemy.y + r;
        if (b.x !== cx || b.y !== cy) continue;

        if (cell.type === 'block') {
          cell.alive = false;
          score += 5;
          return true;
        } else if (cell.type === 'core') {
          if (b.ch.toLowerCase() === CORE_CHAR) {
            enemy.alive = false;
            score += 100;
          }
          return true;
        } else {
          // char cell
          if (b.ch.toLowerCase() === cell.ch.toLowerCase()) {
            cell.alive = false;
            score += 10;
          }
          return true;
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

  // Move bullets
  bullets = bullets.filter(b => { b.y--; return b.y >= fieldTop && !hitTest(b); });

  // Move enemies horizontally
  if (frame % H_MOVE_FRAMES === 0) {
    let hitWall = false;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const rightX = enemy.x + (enemy.cols - 1) * CELL_GAP;
      if (invDir ===  1 && rightX + 1 >= W) hitWall = true;
      if (invDir === -1 && enemy.x  - 1 <  1) hitWall = true;
    }

    if (hitWall) {
      invDir *= -1;
      for (const enemy of enemies) { if (enemy.alive) enemy.y++; }
    } else {
      for (const enemy of enemies) { if (enemy.alive) enemy.x += invDir; }
    }

    // Game over: enemy reaches player area
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      for (let r = 0; r < enemy.rows; r++) {
        const row = enemy.cells[r];
        if (!row) continue;
        if (row.some(c => c && c.alive) && enemy.y + r >= fieldBot) {
          gameOver    = true;
          gameOverMsg = '💀  GAME OVER  💀';
          return;
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

  if (gameOver) { if (data === 'q') cleanup(); return; }

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
  designs = loadDesigns(ENEMIES_DIR);
  if (designs.length === 0) {
    process.stderr.write(`[VimVader] No enemy designs found in: ${ENEMIES_DIR}\n`);
    process.stderr.write(`           Add .enemy files there to get started.\n`);
  } else {
    process.stderr.write(`[VimVader] Loaded ${designs.length} enemy design(s): ${designs.map(d => d.name).join(', ')}\n`);
  }

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
    if (now - last >= FRAME_MS) { tick(); render(); last = now; }
  }, Math.floor(FRAME_MS / 2));
  process.on('SIGINT', cleanup);
}

start();
