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

const GAME_IDS = ['kokoro', 'lock', 'maze', 'draw', 'puzzle', 'ten'];

// ---- お絵かき伝言: お題 [表示用, ...正解として認める書き方]
const WORDS = [
  ['りんご', '林檎', 'リンゴ', 'apple'], ['ねこ', '猫'], ['いぬ', '犬'], ['さかな', '魚'], ['くるま', '車'],
  ['でんしゃ', '電車'], ['ひこうき', '飛行機'], ['いえ', '家'], ['き', '木'], ['はな', '花'], ['たいよう', '太陽'],
  ['つき', '月'], ['ほし', '星'], ['あめ', '雨'], ['かさ', '傘'], ['めがね', '眼鏡'], ['とけい', '時計'],
  ['くつ', '靴'], ['ぼうし', '帽子'], ['けーき', 'ケーキ'], ['すいか', '西瓜', 'スイカ'], ['ばなな', 'バナナ'],
  ['うさぎ', '兎'], ['ぞう', '象'], ['きりん', 'キリン'], ['へび', '蛇'], ['かめ', '亀'], ['とり', '鳥'],
  ['やま', '山'], ['うみ', '海'], ['ゆきだるま', '雪だるま'], ['にじ', '虹'], ['ふね', '船'], ['じてんしゃ', '自転車'],
  ['ぎたー', 'ギター'], ['えんぴつ', '鉛筆'], ['はさみ', '鋏', 'ハサミ'], ['かぎ', '鍵'], ['でんきゅう', '電球'],
  ['おにぎり', 'お握り'], ['らーめん', 'ラーメン'], ['すし', '寿司'], ['たこ', '蛸', 'タコ'], ['かに', '蟹', 'カニ'],
  ['ろけっと', 'ロケット'], ['ろぼっと', 'ロボット'], ['てがみ', '手紙'], ['ほん', '本'], ['てれび', 'テレビ'],
];
const DRAW_ROUNDS = 3, DRAW_GOAL = 2, DRAW_MS = 80_000;
const MAX_STROKE_PTS = 500, MAX_TOTAL_PTS = 8000;
const PALETTE = 6;

// ---- ふたりパズル
const TILES = ['🍎', '🍌', '🍇', '🍓', '🍉', '🍑', '🍒', '🍋', '🥝', '🍍', '🥕', '🌽', '🍄', '🌸', '⭐', '🐟'];
const PUZZLE_CHECKS = 3;

// ---- 合わせて10
const TEN_ROUNDS = 4, TEN_GOAL = 3;

/** For comparing guesses: full-width→half, katakana→hiragana, drop spaces & punctuation. */
function normWord(t) {
  return String(t).normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s、。，．,.!！?？「」『』・〜~ｰ_-]/g, '');
}

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
  } else if (game === 'draw') {
    S.data = { round: 0, hist: [], words: shuffle([...WORDS.keys()]).slice(0, DRAW_ROUNDS) };
    newDrawRound(S);
  } else if (game === 'puzzle') {
    const ids = shuffle([...TILES.keys()]).slice(0, 9);          // tile k shows TILES[ids[k]]
    const cells = shuffle([...Array(9).keys()]);                 // tile k belongs at cells[k]
    const mineA = S.swap ? 5 : 4;
    S.data = { emoji: ids.map((i) => TILES[i]), target: cells, owner: Array.from({ length: 9 }, (_, k) => (k < mineA ? 'a' : 'b')),
      board: Array(9).fill(null), checks: PUZZLE_CHECKS, lastCount: null };
  } else if (game === 'ten') {
    const hand = () => Array.from({ length: 5 }, () => 1 + rnd(9));
    S.data = { hands: { a: hand(), b: hand() }, round: 0, hist: [], pick: { a: null, b: null }, reveal: false };
    S.data.target = tenTarget(S.data);
  }
}

function newDrawRound(S, now = Date.now()) {
  const D = S.data;
  D.drawer = ((D.round + (S.swap ? 0 : 1)) % 2 === 0) ? 'a' : 'b';
  D.word = WORDS[D.words[D.round]];
  D.strokes = []; D.pts = 0; D.guesses = [];
  D.deadline = now + DRAW_MS;
}
function endDrawRound(S, ok, notes, now) {
  const D = S.data;
  D.hist.push(ok ? 1 : 0);
  D.round++;
  if (D.round >= DRAW_ROUNDS) {
    const hits = D.hist.reduce((a, b) => a + b, 0);
    finish(S, hits >= DRAW_GOAL, `${DRAW_ROUNDS}問中 ${hits}問 正解！`);
  } else {
    newDrawRound(S, now);
    notes.push('✏️ 次のお題！ 描く人を交代');
  }
}
function tenTarget(D) {
  const a = D.hands.a[rnd(D.hands.a.length)], b = D.hands.b[rnd(D.hands.b.length)];
  return a + b;
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
  } else if (S.game === 'draw') {
    if (a.r !== D.round) return out;
    const now = Date.now();
    if (role === D.drawer) {
      if (t === 'stroke' && Array.isArray(a.p) && a.p.length >= 2 && a.p.length <= MAX_STROKE_PTS * 2 && a.p.length % 2 === 0) {
        if (!a.p.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000)) return out;
        if (D.pts + a.p.length / 2 > MAX_TOTAL_PTS) { out.notes.push('🖍️ これ以上は描けません（消して描き直そう）'); out.changed = true; return out; }
        const c = Number.isInteger(a.c) && a.c >= 0 && a.c < PALETTE ? a.c : 0;
        const w = a.w === 2 ? 2 : a.w === 0 ? 0 : 1;
        D.strokes.push({ c, w, p: a.p }); D.pts += a.p.length / 2; out.changed = true;
      } else if (t === 'undo' && D.strokes.length) {
        const s = D.strokes.pop(); D.pts -= s.p.length / 2; out.changed = true;
      } else if (t === 'clear' && D.strokes.length) {
        D.strokes = []; D.pts = 0; out.changed = true;
      }
    } else {
      if (t === 'guess' && typeof a.text === 'string') {
        const g = normWord(a.text.slice(0, 30));
        if (!g) return out;
        if (D.word.some((w) => normWord(w) === g)) {
          out.notes.push(`⭕ 正解！ お題は「${D.word[0]}」でした`);
          endDrawRound(S, true, out.notes, now);
        } else {
          D.guesses.push(a.text.slice(0, 20)); if (D.guesses.length > 6) D.guesses.shift();
        }
        out.changed = true;
      } else if (t === 'pass') {
        out.notes.push(`🏳️ パス！ お題は「${D.word[0]}」でした`);
        endDrawRound(S, false, out.notes, now);
        out.changed = true;
      }
    }
  } else if (S.game === 'puzzle') {
    if (t === 'place' && Number.isInteger(a.k) && a.k >= 0 && a.k < 9 && Number.isInteger(a.cell) && a.cell >= 0 && a.cell < 9) {
      if (D.owner[a.k] !== role) return out;
      const occ = D.board[a.cell];
      if (occ !== null && D.owner[occ] !== role) return out;   // can't move the partner's tile
      const prev = D.board.indexOf(a.k);
      if (prev >= 0) D.board[prev] = null;
      D.board[a.cell] = a.k;                                    // own tile that was there goes back to hand
      out.changed = true;
    } else if (t === 'remove' && Number.isInteger(a.cell) && a.cell >= 0 && a.cell < 9) {
      const k = D.board[a.cell];
      if (k === null || D.owner[k] !== role) return out;
      D.board[a.cell] = null; out.changed = true;
    } else if (t === 'check' && D.board.every((k) => k !== null)) {
      const ok = D.board.filter((k, cell) => D.target[k] === cell).length;
      if (ok === 9) finish(S, true, `答え合わせ ${PUZZLE_CHECKS - D.checks + 1}回目で完成！`);
      else {
        D.checks--; D.lastCount = ok;
        out.notes.push(`🧩 正しい位置は ${ok}/9 個。あと${D.checks}回答え合わせできます`);
        if (D.checks <= 0) finish(S, false, `正しい位置は ${ok}/9 個でした…`);
      }
      out.changed = true;
    }
  } else if (S.game === 'ten') {
    if (t === 'pick' && !D.reveal && a.r === D.round && Number.isInteger(a.i) && a.i >= 0 && a.i < D.hands[role].length && D.pick[role] === null) {
      D.pick[role] = a.i;
      if (D.pick.a !== null && D.pick.b !== null) {
        D.reveal = true;
        D.hist.push(D.hands.a[D.pick.a] + D.hands.b[D.pick.b] === D.target ? 1 : 0);
      }
      out.changed = true;
    } else if (t === 'next' && D.reveal && a.r === D.round) {
      D.hands.a.splice(D.pick.a, 1); D.hands.b.splice(D.pick.b, 1);
      D.round++; D.pick = { a: null, b: null }; D.reveal = false;
      if (D.round >= TEN_ROUNDS) {
        const hits = D.hist.reduce((x, y) => x + y, 0);
        finish(S, hits >= TEN_GOAL, `${TEN_ROUNDS}回中 ${hits}回 ぴったり！`);
      } else D.target = tenTarget(D);
      out.changed = true;
    }
  }
  return out;
}

/** Time-based updates (お絵かき伝言の制限時間). Call about twice a second. */
function tick(S, now = Date.now()) {
  const out = { changed: false, notes: [] };
  if (S.phase === 'play' && S.game === 'draw' && S.data && now >= S.data.deadline) {
    out.notes.push(`⏰ 時間切れ！ お題は「${S.data.word[0]}」でした`);
    endDrawRound(S, false, out.notes, now);
    out.changed = true;
  }
  return out;
}

/** Game-specific chat rules. Returns a reason string to reject the message, or null. */
function chatGuard(S, role, text) {
  if (S.phase !== 'play' || !S.data) return null;
  const D = S.data;
  if (S.game === 'draw' && role === D.drawer) {
    const z = normWord(text);
    if (D.word.some((w) => z.includes(normWord(w)))) return 'お題の答えはチャットに書けません（絵で伝えよう！）';
  }
  if (S.game === 'ten') {
    const z = String(text).normalize('NFKC').toLowerCase();
    if (/[0-9〇二三四五六七八九]|いち|ろく|なな|しち|はち|きゅう|じゅう|\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/.test(z))
      return 'このゲーム中は数字を直接言えません（「大きめ」「奇数」などのヒントで伝えよう）';
  }
  return null;
}

/** What `role` is allowed to see. */
function view(S, role, now = Date.now()) {
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
  } else if (S.game === 'draw') {
    const drawer = D.drawer === role;
    v.play = {
      round: D.round, rounds: DRAW_ROUNDS, goal: DRAW_GOAL, hist: D.hist.slice(), drawer,
      strokes: D.strokes, guesses: D.guesses.slice(), left: Math.max(0, D.deadline - now),
      len: [...D.word[0]].length,
    };
    if (drawer) v.play.word = D.word[0];
  } else if (S.game === 'puzzle') {
    v.play = {
      checks: D.checks, maxChecks: PUZZLE_CHECKS, lastCount: D.lastCount,
      board: D.board.map((k) => (k === null ? null : { k, e: D.emoji[k], mine: D.owner[k] === role })),
      hand: D.emoji.map((e, k) => ({ k, e })).filter((x) => D.owner[x.k] === role && !D.board.includes(x.k)),
      // where the PARTNER's tiles belong — your own targets are never sent to you
      hints: D.emoji.map((e, k) => ({ e, cell: D.target[k] })).filter((_, k) => D.owner[k] === op),
    };
  } else if (S.game === 'ten') {
    v.play = {
      round: D.round, rounds: TEN_ROUNDS, goal: TEN_GOAL, hist: D.hist.slice(), target: D.target,
      hand: D.hands[role].slice(), theirCount: D.hands[op].length,
      mine: D.pick[role], theirsDone: D.pick[op] !== null, reveal: D.reveal,
      theirs: D.reveal ? D.hands[op][D.pick[op]] : null,
    };
  }
  return v;
}

module.exports = { newPairState, apply, view, tick, chatGuard, normWord, GAME_IDS, QUESTIONS, WORDS, genMaze, _internal: { startGame } };
