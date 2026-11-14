'use strict';
// AI (rule-based bot) tests: language understanding, fairness, and that everything it says passes the chat rules.
const assert = require('assert');
const games = require('./games');
const { checkChat } = require('./filter');
const bot = require('./bot');
const { BotBrain, WORD_INFO, glyphName, parseCell } = bot;
const { firstIndex, SHAPE_WORDS, MARK_WORDS, parseTenHint, fitsHint } = bot._internal;
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

t('every drawing word has hints, and no hint gives the answer away or trips a filter', () => {
  for (const w of games.WORDS) {
    const info = WORD_INFO[w[0]]; assert.ok(info && info.length === 4, 'missing hints for ' + w[0]);
    const S = { phase: 'play', game: 'draw', data: { drawer: 'a', word: w } };
    for (const line of [`ヒント①：${info[1]}`, `ヒント②：${info[2]}`, `ヒント③：${info[3]}（ジャンルは「${info[0]}」）`])
      assert.strictEqual(games.chatGuard(S, 'a', line) || checkChat(line), null, `${w[0]}: ${line}`);
  }
});

t('記号ロック: understands many ways of describing a symbol', () => {
  const read = (s) => { const sh = firstIndex(s, SHAPE_WORDS), mk = firstIndex(s, MARK_WORDS); return sh >= 0 && mk >= 0 ? sh + mk * 4 : -1; };
  for (let id = 0; id < 12; id++) assert.strictEqual(read(glyphName(id)), id);
  assert.strictEqual(read('さんかくにてん'), 1);
  assert.strictEqual(read('ダイヤの中にばってん'), 3 + 8);
  assert.strictEqual(read('○の中に横棒'), 0 + 4);
  assert.strictEqual(read('四角'), -1);
});

t('ふたりパズル: position words map to the right cells', () => {
  const cases = { '左上': 0, '上の真ん中': 1, 'まんなかの上': 1, '右上': 2, '左': 3, '真ん中': 4, '中央': 4, '右の真ん中': 5, '左下': 6, '下': 7, 'みぎした': 8 };
  for (const [w, c] of Object.entries(cases)) assert.strictEqual(parseCell(w), c, w);
  assert.strictEqual(parseCell('どこだろう'), -1);
});

t('合わせて○○: hint words are understood and never require saying a number', () => {
  assert.deepStrictEqual(parseTenHint('大きめの奇数を出すよ'), { size: 'big', parity: 1 });
  assert.deepStrictEqual(parseTenHint('ちいさい偶数'), { size: 'small', parity: 0 });
  assert.deepStrictEqual(parseTenHint('真ん中くらい'), { size: 'mid' });
  assert.ok(fitsHint(7, { size: 'big', parity: 1 }) && !fitsHint(8, { size: 'big', parity: 1 }));
});

async function runBrain(view, chats = []) {
  const out = []; const b = new BotBrain((m) => out.push(m));
  b.receive({ t: 'view', view });
  for (const c of chats) b.receive({ t: 'chat', from: 'partner', text: c, seq: 1 });
  await sleep(3500); b.stop(); return out;
}

(async () => {
  // async checks
  const lockOp = await runBrain({ phase: 'play', game: 'lock', play: { round: 0, rounds: 3, miss: 0, maxMiss: 3, input: 0, len: 2, instr: false, entered: [], layout: [...Array(12).keys()] } },
    ['三角の中に点、それから ひし形にバツ']);
  const presses = lockOp.filter((m) => m.t === 'act').map((m) => m.a.s);
  assert.deepStrictEqual(presses, [1, 11]); n++; console.log('  ✓ 記号ロック: presses two symbols described in one message, in order');

  const walker = await runBrain({ phase: 'play', game: 'maze', play: { nav: false, w: 8, pos: 0, moves: 0, bumps: 0, maxBumps: 8, cells: Array(64).fill(null).map((_, i) => (i === 0 ? 9 : null)), goal: -1 } },
    ['了解した！ 右に2マス、そのあと下']);
  const moves = walker.filter((m) => m.t === 'act').map((m) => m.a.d);
  assert.deepStrictEqual(moves, ['e', 'e', 's']); n++; console.log('  ✓ 霧の迷路: follows "右に2マス、そのあと下" and ignores 「した」 in 「了解した」');

  // fairness: as puzzle partner the bot only places tiles the human described — never its secret targets
  const pz = await runBrain({ phase: 'play', game: 'puzzle', play: { checks: 3, maxChecks: 3, lastCount: null, board: Array(9).fill(null),
    hand: [{ k: 0, e: '🍎' }, { k: 1, e: '🍌' }], hints: [{ e: '🍇', cell: 8 }] } }, ['🍎は左下だよ']);
  const places = pz.filter((m) => m.t === 'act' && m.a.type === 'place');
  assert.deepStrictEqual(places.map((m) => [m.a.k, m.a.cell]), [[0, 6]]); n++; console.log('  ✓ ふたりパズル: places only what it was told (🍎→左下), asks about the rest');
  assert.ok(pz.some((m) => m.t === 'chat' && m.text.includes('🍇は右下')), 'tells the human where their tile goes');

  const said = pz.concat(lockOp, walker).filter((m) => m.t === 'chat').map((m) => m.text);
  for (const s of said) assert.strictEqual(checkChat(s), null, 'bot line blocked: ' + s);
  n++; console.log('  ✓ everything the AI said passes the chat filter');

  console.log(`\n${n} bot tests passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
