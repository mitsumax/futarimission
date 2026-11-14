'use strict';
// Server-authoritative co-op games. Roles are 'a' and 'b' (the two players of a pair).
// view(pair, role) returns ONLY what that role may see — secrets never leave the server.

const QUESTIONS = [
  ['休日の過ごし方は？', ['家でまったり', '外でアクティブ', '友だちと集まる', 'ひとり旅']],
  ['好きな季節は？', ['春', '夏', '秋', '冬']],
  ['旅行に行くなら？', ['海', '山', '都会', '温泉']],
  ['朝ごはんは？', ['ごはん派', 'パン派', '食べない', '日による']],
  ['ペットにするなら？', ['犬', '猫', '鳥', 'は虫類']],
  ['遊びに行くなら？', ['水族館', '遊園地', '美術館', 'カフェ巡り']],
  ['好きな映画のジャンルは？', ['コメディ', 'アクション', 'ホラー', 'アニメ']],
  ['1億円当たったら？', ['貯金する', '旅行する', '家を買う', '仕事を辞める']],
  ['苦手なのは？', ['早起き', '人混み', '虫', '待つこと']],
  ['理想の夜ごはんは？', ['焼肉', 'お寿司', 'ラーメン', '手料理']],
  ['タイムマシンがあったら？', ['過去に行く', '未来に行く', '使わない', '恐竜を見に行く']],
  ['一番大事にしているのは？', ['家族', '友だち', '仕事・夢', '自分の時間']],
  ['雨の日の気分は？', ['好き', 'ちょっと憂うつ', 'こもれて嬉しい', '気にしない']],
  ['カラオケでは？', ['歌いまくる', '盛り上げ役', '聴く専門', '行かない']],
  ['住むなら？', ['都会のマンション', '郊外の一軒家', '田舎でのんびり', '海外']],
  ['甘いものとしょっぱいもの？', ['甘い派', 'しょっぱい派', '交互に食べたい', 'どっちも控えめ']],
  ['初対面の人とは？', ['すぐ打ち解ける', '少しずつ', '相手しだい', '緊張する']],
  ['もらって嬉しいプレゼントは？', ['手紙', '体験・旅行', '実用品', 'サプライズ']],
  ['無人島に1つ持っていくなら？', ['ナイフ', 'スマホ', '本', '友だち']],
  ['子どものころの夢は？', ['スポーツ選手', 'お店屋さん', '先生', '覚えてない']],
  ['好きなおにぎりの具は？', ['鮭', 'ツナマヨ', '梅', '昆布']],
  ['寝る前にすることは？', ['スマホ', '読書', 'ストレッチ', 'すぐ寝る']],
];
const K_TOTAL = 6, K_GOAL = 4;

const GAME_IDS = ['kokoro', 'lock', 'maze'];

const rnd = (n) => Math.floor(Math.random() * n);
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const other = (r) => (r === 'a' ? 'b' : 'a');
const uid = () => Math.random().toString(36).slice(2, 10);

function newPairState() {
  return { phase: 'select', game: null, data: null, result: null, bond: 0, clears: 0, swap: false };
}

function startGame(S, game) {
  S.game = game; S.phase = 'play'; S.result = null; S.swap = !S.swap;
  if (game === 'kokoro') {
    S.data = { qs: shuffle([...QUESTIONS.keys()]).slice(0, K_TOTAL), i: 0, ans: { a: null, b: null }, hist: [], reveal: false };
  } else if (game === 'lock') {
    S.data = { round: 0, rounds: 3, miss: 0, maxMiss: 3 };
    Object.assign(S.data, newLock(S, 0));
  } else if (game === 'maze') {
    const w = 8;
    S.data = { w, cells: genMaze(w), pos: 0, goal: w * w - 1, moves: 0, bumps: 0, maxBumps: 8, nav: S.swap ? 'a' : 'b' };
  }
}

function newLock(S, round) {
  const len = [4, 5, 6][round] || 4;
  return {
    code: Array.from({ length: len }, () => rnd(12)),
    layout: shuffle([...Array(12).keys()]),
    instr: ((round + (S.swap ? 0 : 1)) % 2 === 0) ? 'a' : 'b',
    input: 0,
  };
}

function finish(S, clear, text) {
  S.phase = 'result';
  S.result = { id: uid(), clear, text, game: S.game };
  S.bond += clear ? 25 : 8;
  if (clear) S.clears++;
}

// cell bits: wall present N=1 E=2 S=4 W=8
function genMaze(w) {
  const cells = Array(w * w).fill(15), seen = Array(w * w).fill(false), st = [0];
  seen[0] = true;
  while (st.length) {
    const c = st[st.length - 1], x = c % w, y = Math.floor(c / w), nb = [];
    if (y > 0 && !seen[c - w]) nb.push([c - w, 1, 4]);
    if (x < w - 1 && !seen[c + 1]) nb.push([c + 1, 2, 8]);
    if (y < w - 1 && !seen[c + w]) nb.push([c + w, 4, 1]);
    if (x > 0 && !seen[c - 1]) nb.push([c - 1, 8, 2]);
    if (!nb.length) { st.pop(); continue; }
    const [n, b1, b2] = nb[rnd(nb.length)];
    cells[c] &= ~b1; cells[n] &= ~b2; seen[n] = true; st.push(n);
  }
  return cells;
}

/**
 * Apply an action from `role`. Returns { changed:boolean, notes:[text] } where notes are
 * system messages for both players. Invalid / stale actions are ignored.
 */
function apply(S, role, a) {
  const out = { changed: false, notes: [] };
  if (!a || typeof a !== 'object') return out;
  const t = a.type;
  if (t === 'pick' && S.phase === 'select' && GAME_IDS.includes(a.game)) { startGame(S, a.game); out.changed = true; return out; }
  if (t === 'menu' && S.phase === 'result') { Object.assign(S, { phase: 'select', game: null, data: null, result: null }); out.changed = true; return out; }
  if (t === 'again' && S.phase === 'result' && S.game) { startGame(S, S.game); out.changed = true; return out; }
  if (S.phase !== 'play' || !S.data) return out;
  const D = S.data;

  if (S.game === 'kokoro') {
    if (t === 'ans' && !D.reveal && a.q === D.i && Number.isInteger(a.c) && a.c >= 0 && a.c < 4 && D.ans[role] === null) {
      D.ans[role] = a.c;
      if (D.ans.a !== null && D.ans.b !== null) { D.reveal = true; D.hist.push(D.ans.a === D.ans.b ? 1 : 0); }
      out.changed = true;
    } else if (t === 'next' && D.reveal && a.q === D.i) {
      D.i++; D.ans = { a: null, b: null }; D.reveal = false;
      if (D.i >= K_TOTAL) {
        const m = D.hist.reduce((s, v) => s + v, 0);
        finish(S, m >= K_GOAL, `${K_TOTAL}問中 ${m}問 そろいました`);
      }
      out.changed = true;
    }
  } else if (S.game === 'lock') {
    if (t === 'press' && role !== D.instr && Number.isInteger(a.s) && a.s >= 0 && a.s < 12 && a.r === D.round) {
      if (D.code[D.input] === a.s) {
        D.input++;
        if (D.input >= D.code.length) {
          D.round++;
          if (D.round >= D.rounds) finish(S, true, `ミス ${D.miss}回で全ロック解除！`);
          else { Object.assign(D, newLock(S, D.round)); out.notes.push(`🔓 ロック${D.round}解除！ 次は役割を交代`); }
        }
      } else {
        D.miss++; D.input = 0;
        out.notes.push('❌ ちがう記号でした！最初から入力し直し');
        if (D.miss >= D.maxMiss) finish(S, false, `ロック ${D.round}/${D.rounds} で失敗…`);
      }
      out.changed = true;
    }
  } else if (S.game === 'maze') {
    if (t === 'move' && role !== D.nav && ['n', 'e', 's', 'w'].includes(a.d) && a.m === D.moves + D.bumps) {
      const bit = { n: 1, e: 2, s: 4, w: 8 }[a.d];
      const dx = { n: 0, e: 1, s: 0, w: -1 }[a.d], dy = { n: -1, e: 0, s: 1, w: 0 }[a.d];
      if (D.cells[D.pos] & bit) {
        D.bumps++;
        out.notes.push('💥 ゴツン！壁にぶつかった');
        if (D.bumps >= D.maxBumps) finish(S, false, `壁に${D.maxBumps}回ぶつかってしまった…`);
      } else {
        D.pos = D.pos + dx + dy * D.w; D.moves++;
        if (D.pos === D.goal) {
          const stars = D.bumps <= 1 ? '★★★' : D.bumps <= 4 ? '★★☆' : '★☆☆';
          finish(S, true, `${D.moves}歩でゴール！ぶつかった回数 ${D.bumps}回　${stars}`);
        }
      }
      out.changed = true;
    }
  }
  return out;
}

/** What `role` is allowed to see. */
function view(S, role) {
  const v = { phase: S.phase, game: S.game, bond: S.bond, clears: S.clears, result: S.result };
  if (S.phase !== 'play' || !S.data) return v;
  const D = S.data, op = other(role);
  if (S.game === 'kokoro') {
    const q = QUESTIONS[D.qs[D.i]];
    v.play = {
      i: D.i, total: K_TOTAL, goal: K_GOAL, hist: D.hist.slice(), q: q[0], opts: q[1],
      mine: D.ans[role], theirsDone: D.ans[op] !== null, reveal: D.reveal,
      theirs: D.reveal ? D.ans[op] : null,
    };
  } else if (S.game === 'lock') {
    const instr = D.instr === role;
    v.play = {
      round: D.round, rounds: D.rounds, miss: D.miss, maxMiss: D.maxMiss, input: D.input, len: D.code.length,
      instr, entered: D.code.slice(0, D.input),
    };
    if (instr) v.play.code = D.code.slice();
    else v.play.layout = D.layout.slice();
  } else if (S.game === 'maze') {
    const nav = D.nav === role, w = D.w, px = D.pos % w, py = Math.floor(D.pos / w);
    const vis = (i) => nav || (Math.abs((i % w) - px) <= 1 && Math.abs(Math.floor(i / w) - py) <= 1);
    v.play = {
      nav, w, pos: D.pos, moves: D.moves, bumps: D.bumps, maxBumps: D.maxBumps,
      cells: D.cells.map((c, i) => (vis(i) ? c : null)),
      goal: vis(D.goal) ? D.goal : -1,
    };
  }
  return v;
}

module.exports = { newPairState, apply, view, GAME_IDS, QUESTIONS, genMaze, _internal: { startGame } };
