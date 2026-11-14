'use strict';
// Unit tests: game rules, information hiding, filters.  Run: node test-unit.js
const assert = require('assert');
const games = require('./games');
const { checkChat, cleanName } = require('./filter');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };

console.log('games');
t('kokoro: 4/6 matches clears, partner answer hidden until reveal', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'kokoro' });
  for (let i = 0; i < 6; i++) {
    games.apply(S, 'a', { type: 'ans', q: i, c: 0 });
    const vb = games.view(S, 'b');
    assert.strictEqual(vb.play.theirsDone, true);
    assert.strictEqual(vb.play.theirs, null, 'answer leaked before reveal');
    games.apply(S, 'b', { type: 'ans', q: i, c: i < 4 ? 0 : 1 });
    assert.strictEqual(games.view(S, 'b').play.theirs, 0);
    games.apply(S, 'b', { type: 'next', q: i });
  }
  assert.strictEqual(S.phase, 'result');
  assert.strictEqual(S.result.clear, true);
  assert.strictEqual(S.bond, 25);
});

t('kokoro: cannot change an answer, stale question ignored', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'kokoro' });
  games.apply(S, 'a', { type: 'ans', q: 0, c: 1 });
  assert.strictEqual(games.apply(S, 'a', { type: 'ans', q: 0, c: 2 }).changed, false);
  assert.strictEqual(games.apply(S, 'b', { type: 'ans', q: 3, c: 2 }).changed, false);
});

t('lock: operator never sees the code, instructor never gets the keypad', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'lock' });
  const instr = S.data.instr, op = instr === 'a' ? 'b' : 'a';
  const vi = games.view(S, instr), vo = games.view(S, op);
  assert.ok(Array.isArray(vi.play.code) && !vi.play.layout);
  assert.ok(Array.isArray(vo.play.layout) && vo.play.code === undefined);
  assert.ok(!JSON.stringify(vo).includes('"code"'));
  // instructor cannot press
  assert.strictEqual(games.apply(S, instr, { type: 'press', s: S.data.code[0], r: 0 }).changed, false);
});

t('lock: solving 3 rounds clears, roles swap each round', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'lock' });
  const seen = [];
  for (let r = 0; r < 3; r++) {
    const instr = S.data.instr; seen.push(instr);
    const op = instr === 'a' ? 'b' : 'a';
    for (const s of S.data.code.slice()) games.apply(S, op, { type: 'press', s, r });
  }
  assert.strictEqual(S.result.clear, true);
  assert.notStrictEqual(seen[0], seen[1]);
});

t('lock: 3 mistakes fails', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'lock' });
  const op = S.data.instr === 'a' ? 'b' : 'a';
  for (let i = 0; i < 3; i++) games.apply(S, op, { type: 'press', s: (S.data.code[0] + 1) % 12, r: 0 });
  assert.strictEqual(S.phase, 'result');
  assert.strictEqual(S.result.clear, false);
});

t('maze: walker sees only 3x3, navigator sees all; BFS path reaches goal', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'maze' });
  const D = S.data, nav = D.nav, walker = nav === 'a' ? 'b' : 'a';
  const vw = games.view(S, walker), vn = games.view(S, nav);
  assert.strictEqual(vw.play.cells.filter((c) => c !== null).length, 4); // corner: 2x2 visible
  assert.strictEqual(vw.play.goal, -1);
  assert.strictEqual(vn.play.cells.filter((c) => c !== null).length, 64);
  // solve with BFS using the real walls
  const w = D.w, prev = new Map([[0, null]]), q = [0];
  const dirs = [['n', 1, -w], ['e', 2, 1], ['s', 4, w], ['w', 8, -1]];
  while (q.length) { const c = q.shift(); for (const [d, bit, dd] of dirs) if (!(D.cells[c] & bit) && !prev.has(c + dd)) { prev.set(c + dd, [c, d]); q.push(c + dd); } }
  const path = []; for (let c = D.goal; prev.get(c); c = prev.get(c)[0]) path.unshift(prev.get(c)[1]);
  for (const d of path) games.apply(S, walker, { type: 'move', d, m: S.data.moves + S.data.bumps });
  assert.strictEqual(S.result.clear, true);
  assert.ok(S.result.text.includes('★★★'));
});

t('maze: navigator cannot move; duplicate move counter ignored', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'maze' });
  const nav = S.data.nav, walker = nav === 'a' ? 'b' : 'a';
  assert.strictEqual(games.apply(S, nav, { type: 'move', d: 'e', m: 0 }).changed, false);
  games.apply(S, walker, { type: 'move', d: 'n', m: 0 }); // wall → bump
  assert.strictEqual(games.apply(S, walker, { type: 'move', d: 'n', m: 0 }).changed, false);
});

t('every generated maze is fully connected', () => {
  for (let k = 0; k < 200; k++) {
    const c = games.genMaze(8), seen = new Set([0]), q = [0];
    while (q.length) { const x = q.shift(); for (const [bit, d] of [[1, -8], [2, 1], [4, 8], [8, -1]]) if (!(c[x] & bit) && !seen.has(x + d)) { seen.add(x + d); q.push(x + d); } }
    assert.strictEqual(seen.size, 64);
  }
});


t('draw: guesser never receives the word; katakana / kanji guesses accepted', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'draw' });
  const D = S.data, drawer = D.drawer, guesser = drawer === 'a' ? 'b' : 'a';
  assert.strictEqual(games.view(S, drawer).play.word, D.word[0]);
  assert.ok(!JSON.stringify(games.view(S, guesser)).includes(D.word[0]));
  // drawer cannot guess, guesser cannot draw
  assert.strictEqual(games.apply(S, drawer, { type: 'guess', text: D.word[0], r: 0 }).changed, false);
  assert.strictEqual(games.apply(S, guesser, { type: 'stroke', p: [1, 2, 3, 4], r: 0 }).changed, false);
  assert.ok(games.apply(S, drawer, { type: 'stroke', p: [1, 2, 3, 4], c: 1, w: 1, r: 0 }).changed);
  games.apply(S, guesser, { type: 'guess', text: 'ちがうもの', r: 0 });
  assert.deepStrictEqual(S.data.guesses, ['ちがうもの']);
  const kata = D.word[0].replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const r = games.apply(S, guesser, { type: 'guess', text: ' ' + kata + '！', r: 0 });
  assert.ok(r.notes[0].startsWith('⭕'));
  assert.strictEqual(S.data.round, 1);
  assert.notStrictEqual(S.data.drawer, drawer, 'roles swap');
});

t('draw: drawer cannot type the answer in chat; timer ends the round', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'draw' });
  const D = S.data;
  assert.ok(games.chatGuard(S, D.drawer, 'こたえは' + D.word[0] + 'だよ'));
  assert.strictEqual(games.chatGuard(S, D.drawer, 'まるい形だよ'), null);
  const r = games.tick(S, D.deadline + 1);
  assert.ok(r.changed && r.notes[0].startsWith('⏰'));
  assert.deepStrictEqual(S.data.hist, [0]);
});

t('draw: 3 rounds, 2 correct clears; bad strokes rejected', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'draw' });
  const bad = games.apply(S, S.data.drawer, { type: 'stroke', p: [1, 2, 3, 9999], r: 0 });
  assert.strictEqual(bad.changed, false);
  for (let r = 0; r < 3; r++) {
    const g = S.data.drawer === 'a' ? 'b' : 'a';
    if (r < 2) games.apply(S, g, { type: 'guess', text: S.data.word[1], r });
    else games.apply(S, g, { type: 'pass', r });
  }
  assert.strictEqual(S.result.clear, true);
});

t('puzzle: you see where the PARTNER\'s tiles go, never your own', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'puzzle' });
  const D = S.data;
  const va = games.view(S, 'a').play, vb = games.view(S, 'b').play;
  assert.strictEqual(va.hand.length + vb.hand.length, 9);
  assert.deepStrictEqual(va.hints.map((h) => h.e).sort(), vb.hand.map((h) => h.e).sort());
  assert.deepStrictEqual(vb.hints.map((h) => h.e).sort(), va.hand.map((h) => h.e).sort());
  // a cannot place b's tile
  assert.strictEqual(games.apply(S, 'a', { type: 'place', k: vb.hand[0].k, cell: 0 }).changed, false);
  // place everything correctly using the partner's hints
  for (const [me, hintsFromPartner] of [['a', vb.hints], ['b', va.hints]]) {
    for (const h of hintsFromPartner) { const k = D.emoji.indexOf(h.e); games.apply(S, me, { type: 'place', k, cell: h.cell }); }
  }
  games.apply(S, 'a', { type: 'check' });
  assert.strictEqual(S.result.clear, true);
});

t('puzzle: wrong board uses a check; 3 wrong checks fail; cannot overwrite partner tile', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'puzzle' });
  const D = S.data;
  // fill cells in index order (almost surely wrong)
  let cell = 0;
  for (let k = 0; k < 9; k++) games.apply(S, D.owner[k], { type: 'place', k, cell: cell++ });
  const kb = D.board.find((k) => D.owner[k] === 'b');
  assert.strictEqual(games.apply(S, 'a', { type: 'place', k: D.board.find((k) => D.owner[k] === 'a'), cell: D.board.indexOf(kb) }).changed, false);
  if (D.board.every((k, c) => D.target[k] === c)) return; // 1/362880 chance
  for (let i = 0; i < 3; i++) games.apply(S, 'b', { type: 'check' });
  assert.strictEqual(S.result.clear, false);
});

t('ten: partner card values hidden until reveal; numbers blocked in chat', () => {
  const S = games.newPairState();
  games.apply(S, 'a', { type: 'pick', game: 'ten' });
  const va = games.view(S, 'a').play;
  assert.strictEqual(va.theirCount, 5);
  assert.ok(!('hands' in va));
  games.apply(S, 'a', { type: 'pick', i: 0, r: 0 });
  assert.strictEqual(games.view(S, 'b').play.theirs, null);
  games.apply(S, 'b', { type: 'pick', i: 0, r: 0 });
  assert.strictEqual(games.view(S, 'b').play.theirs, S.data.hands.a[0]);
  assert.ok(games.chatGuard(S, 'a', '7にして'));
  assert.ok(games.chatGuard(S, 'a', 'ななだよ'));
  assert.strictEqual(games.chatGuard(S, 'a', '一緒に大きめを出そう'), null);
});

t('ten: target is always reachable; 4 rounds then result', () => {
  for (let n = 0; n < 50; n++) {
    const S = games.newPairState();
    games.apply(S, 'a', { type: 'pick', game: 'ten' });
    for (let r = 0; r < 4; r++) {
      const D = S.data;
      let found = null;
      D.hands.a.forEach((x, i) => D.hands.b.forEach((y, j) => { if (x + y === D.target && !found) found = [i, j]; }));
      assert.ok(found, 'target unreachable');
      games.apply(S, 'a', { type: 'pick', i: found[0], r });
      games.apply(S, 'b', { type: 'pick', i: found[1], r });
      games.apply(S, 'a', { type: 'next', r });
    }
    assert.strictEqual(S.result.clear, true);
  }
});

console.log('filter');
t('blocks contact info', () => {
  for (const s of ['090-1234-5678', '０９０１２３４５６７８', 'ゼロ9０ 1234 5678', 'LINE交換しよ', 'ライン交換しよ', 'らいんやってる？', 'インスタやってる？', 'abc@gmail.com', '@hiro_123', 'line教えて', 'ID:abc', 'https://x.com/abc', 'discord やってる', 'DMして'])
    assert.ok(checkChat(s), 'should block: ' + s);
});
t('allows normal game talk', () => {
  for (const s of ['よろしく！', '右に2つ、下に3つ', '三角の中に点', '3回目でクリア！', 'ラインの上？いや丸', 'ナイス👏', 'online楽しいね', 'もう1回やろう'])
    assert.strictEqual(checkChat(s), null, 'should allow: ' + s);
});
t('blocks harassment words', () => { assert.ok(checkChat('しね')); assert.ok(checkChat('キモいな')); });
t('names: rejects contact-like names, trims', () => {
  assert.strictEqual(cleanName('  はる  '), 'はる');
  assert.strictEqual(cleanName('line_hiro'), null);
  assert.strictEqual(cleanName(''), null);
  assert.strictEqual(cleanName('あいうえおかきくけこさしすせそ').length, 12);
});

console.log(`\n${n} unit tests passed`);
