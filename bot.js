'use strict';
/**
 * ロボ（AI）— a rule-based partner for when nobody else is around.
 *
 * It is a normal player as far as the server is concerned: it receives exactly the messages a
 * browser would (view / chat / sys / stamp …) and answers through the same message handler,
 * so it obeys every rule (chat filters, game rules, rate limits). It never peeks at hidden
 * information — it only uses its own view of the game and what the human says in chat.
 * It is always shown to the human as an AI.
 */
const games = require('./games');

const BOT_NAME = 'ロボ（AI）';
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const norm = (t) => String(t).normalize('NFKC').toLowerCase();

// ---- 記号ロック: words for the 12 glyphs (shape = id % 4, mark = floor(id / 4))
const SHAPE_NAMES = ['丸', '三角', '四角', 'ひし形'];
const MARK_NAMES = ['点', '横線', 'バツ'];
const SHAPE_WORDS = [['丸', 'まる', '円', '○', '◯', 'サークル'], ['三角', 'さんかく', '△', '▲'], ['四角', 'しかく', '正方形', '□', '■', 'スクエア'], ['ひし形', 'ひしがた', '菱', '◇', '◆', 'ダイヤ']];
const MARK_WORDS = [['点', 'てん', 'ドット', '・', '●'], ['横線', '線', 'せん', '横棒', '棒', 'ライン', '―', '－', 'マイナス'], ['バツ', 'ばつ', 'ばってん', '×', '✕', 'x', 'クロス', 'かける', '✖']];
const firstIndex = (text, lists) => {
  let best = -1, at = Infinity;
  lists.forEach((words, i) => words.forEach((w) => { const k = text.indexOf(norm(w)); if (k >= 0 && k < at) { at = k; best = i; } }));
  return best;
};
const glyphName = (id) => `${SHAPE_NAMES[id % 4]}の中に${MARK_NAMES[Math.floor(id / 4)]}`;

// ---- 霧の迷路
const DIRS = { n: [0, -1, 1, '上'], e: [1, 0, 2, '右'], s: [0, 1, 4, '下'], w: [-1, 0, 8, '左'] };
const DIR_WORDS = [['n', ['上', 'うえ', '↑', '北']], ['s', ['下', 'した', '↓', '南']], ['e', ['右', 'みぎ', '→', '東']], ['w', ['左', 'ひだり', '←', '西']]];
const KANJI_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, いち: 1, に: 2, さん: 3, よん: 4, ご: 5 };

// ---- ふたりパズル: cell names
const CELL_NAMES = ['左上', '上の真ん中', '右上', '左の真ん中', '真ん中', '右の真ん中', '左下', '下の真ん中', '右下'];
function parseCell(seg) {
  const s = norm(seg);
  const up = /上|うえ/.test(s), down = /下|した/.test(s), left = /左|ひだり/.test(s), right = /右|みぎ/.test(s);
  const mid = /真ん中|まんなか|中央|ちゅうおう|中/.test(s);
  const row = up ? 0 : down ? 2 : (left || right || mid) ? 1 : -1;
  const col = left ? 0 : right ? 2 : (up || down || mid) ? 1 : -1;
  if (row < 0 || col < 0) return -1;
  return row * 3 + col;
}

// ---- お絵かき伝言: category + hints for every word (hints never contain the answer — checked by tests)
const WORD_INFO = {
  'りんご': ['食べ物', '赤くて丸い果物', '秋においしい', '青森が有名'],
  'ねこ': ['動物', 'ニャーと鳴く', 'ひげがある', 'こたつで丸くなる'],
  'いぬ': ['動物', 'ワンと鳴く', '散歩が大好き', 'しっぽをふる'],
  'さかな': ['動物', '水の中で泳ぐ', 'ヒレとうろこがある', '焼いたりお刺身にしたり'],
  'くるま': ['乗り物', 'タイヤが4つ', '道路を走る', 'ハンドルで運転'],
  'でんしゃ': ['乗り物', '線路を走る', '駅に止まる', '通勤・通学で乗る'],
  'ひこうき': ['乗り物', '空を飛ぶ', '翼がある', '空港から出発'],
  'いえ': ['建物', '人が住む', '屋根と窓とドア', 'ただいま、と帰る場所'],
  'き': ['自然', '森にたくさん生えている', '幹と枝と葉っぱ', '公園にもある緑'],
  'はな': ['自然', '春に咲く', 'チューリップやバラ', 'いい香りがする'],
  'たいよう': ['自然', '空で光っている', '昼間に見える', 'とても熱い'],
  'つき': ['自然', '夜空に浮かぶ', '満ち欠けする', 'うさぎがいるという話も'],
  'ほし': ['自然', '夜空でキラキラ', 'とがった形で描く', '流れたら願いごと'],
  'あめ': ['自然', '空から降ってくる', '傘をさす', '6月によく降る'],
  'かさ': ['道具', '雨の日に使う', '開いたり閉じたり', '柄を持ってさす'],
  'めがね': ['道具', '顔にかける', 'レンズが2つ', '目が悪い人が使う'],
  'とけい': ['道具', '時間がわかる', '長い針と短い針', 'チクタク'],
  'くつ': ['衣類', '足にはく', '左右でひとつ', '玄関でぬぐ'],
  'ぼうし': ['衣類', '頭にかぶる', 'つばがある', '日差しよけ'],
  'けーき': ['食べ物', '誕生日に食べる', 'いちごとクリーム', 'ろうそくを立てる'],
  'すいか': ['食べ物', '夏の果物', '緑と黒のしま模様', '中は赤くて種がある'],
  'ばなな': ['食べ物', '黄色い果物', '皮をむいて食べる', 'サルの好物'],
  'うさぎ': ['動物', '耳が長い', 'ぴょんぴょん跳ねる', 'にんじんが好き'],
  'ぞう': ['動物', '鼻が長い', 'とても大きい', '耳がパタパタ'],
  'きりん': ['動物', '首がとても長い', '黄色に茶色のもよう', '高い所の葉っぱを食べる'],
  'へび': ['動物', '足がない', 'にょろにょろ', '脱皮する'],
  'かめ': ['動物', '甲羅がある', '歩くのがゆっくり', 'うさぎと競走した話'],
  'とり': ['動物', '空を飛ぶ生き物', '羽とくちばし', 'チュンチュン'],
  'やま': ['自然', '高くそびえる', '富士がいちばん有名', '頂上をめざして登る'],
  'うみ': ['自然', '広くて青い', '波がある', 'しょっぱい水'],
  'ゆきだるま': ['その他', '冬に作る', '白い玉を2つ重ねる', 'バケツの帽子と炭の目'],
  'にじ': ['自然', '雨上がりの空', '7色', 'アーチの形'],
  'ふね': ['乗り物', '水の上を進む', '港に止まる', '帆やエンジンで動く'],
  'じてんしゃ': ['乗り物', 'ペダルをこぐ', 'タイヤが2つ', 'ベルをチリンチリン'],
  'ぎたー': ['道具', '楽器', '弦が6本', 'ジャカジャカ鳴らす'],
  'えんぴつ': ['道具', '字を書く', '芯がある', '削って使う'],
  'はさみ': ['道具', '紙を切る', '刃が2枚', 'チョキの形'],
  'かぎ': ['道具', 'ドアを開ける', 'ガチャッと回す', 'なくすと困る'],
  'でんきゅう': ['道具', '光る', '天井につける', 'ひらめいた時のマーク'],
  'おにぎり': ['食べ物', 'ごはんを握る', '三角の形', 'のりを巻く'],
  'らーめん': ['食べ物', '麺類', 'スープとチャーシュー', 'すすって食べる'],
  'すし': ['食べ物', '酢飯にネタ', '回るお店もある', 'マグロやサーモン'],
  'たこ': ['動物', '足が8本', '墨をはく', '焼きにして丸い食べ物に'],
  'かに': ['動物', 'ハサミがある', '横歩き', '赤くゆでて食べる'],
  'ろけっと': ['乗り物', '宇宙へ飛ぶ', '火をふいて発射', 'カウントダウン'],
  'ろぼっと': ['その他', '機械でできている', 'ぼくの仲間かも🤖', 'ウィーンと動く'],
  'てがみ': ['その他', '紙に書いて送る', '切手を貼る', 'ポストに入れる'],
  'ほん': ['道具', 'ページをめくる', '読書', '図書館にたくさん'],
  'てれび': ['道具', '番組を見る', 'リモコンで操作', 'ニュースやドラマ'],
};
const CATEGORY_WORDS = {
  '食べ物': ['食べ物', 'たべもの', '食べる', 'たべる', '果物', 'くだもの', 'フルーツ', '料理', 'おいしい'],
  '動物': ['動物', 'どうぶつ', '生き物', 'いきもの', '鳴く', 'なく'],
  '乗り物': ['乗り物', 'のりもの', '乗る', 'のる', '走る', '飛ぶ'],
  '自然': ['自然', 'しぜん', '空', 'そら', '天気', 'てんき'],
  '道具': ['道具', 'どうぐ', '使う', 'つかう', 'もの', '物'],
  '衣類': ['衣類', 'いるい', '服', 'ふく', '身につける', 'かぶる', 'はく', 'ファッション'],
  '建物': ['建物', 'たてもの', '住む', 'すむ'],
  'その他': [],
};

// ---- 合わせて○○
const sizeWord = (v) => (v <= 3 ? '小さめ' : v <= 6 ? '真ん中くらい' : '大きめ');
function parseTenHint(text) {
  const s = norm(text), h = {};
  if (/大き|でか|おおき|高め|たかめ/.test(s)) h.size = 'big';
  if (/小さ|ちいさ|ちっちゃ|低め|ひくめ/.test(s)) h.size = 'small';
  if (/真ん中|まんなか|中くらい|なかくらい|ふつう|普通/.test(s)) h.size = 'mid';
  if (/奇数|きすう/.test(s)) h.parity = 1;
  if (/偶数|ぐうすう/.test(s)) h.parity = 0;
  return Object.keys(h).length ? h : null;
}
const fitsHint = (v, h) => (!h.size || (h.size === 'small' ? v <= 3 : h.size === 'mid' ? v >= 4 && v <= 6 : v >= 7)) && (h.parity === undefined || v % 2 === h.parity);

// ---- NGワードトーク lines (the bot doesn't know the hidden words either)
const NG_LINES = [
  (t) => `「${t}」って聞いて、まず何を思い浮かべる？`, (t) => `${t}の思い出ってある？`, (t) => `最近、${t}っぽいことした？`,
  (t) => `${t}って好き？ ぼくは結構好きかも`, (t) => `${t}といえば、やっぱりあれだよね…言えないけど😅`,
  () => 'うーん、なにを言ってもNGワードな気がしてきた', () => 'ドキドキするね、このゲーム', () => '慎重にしゃべらないとね…',
];
const NG_REACTIONS = ['へえ〜、そうなんだ！', 'わかる、それいいね！', 'なるほどね〜', 'たしかに、それはあるかも', 'おもしろいね！ もっと聞かせて'];

const GAME_NAME_WORDS = [['kokoro', /以心伝心|いしんでんしん/], ['lock', /記号|ロック|ろっく/], ['maze', /迷路|めいろ|霧/], ['draw', /お絵かき|おえかき|絵/],
  ['puzzle', /パズル|ぱずる/], ['ten', /合わせて|あわせて|カード/], ['ngword', /ng|ＮＧ|エヌジー|ngワード/i]];

class BotBrain {
  /** @param do  function(msgObject) — sends a client message on behalf of the bot */
  constructor(doFn) {
    this.do = doFn;
    this.timers = new Set();
    this.alive = true;
    this.V = null; this.prevV = null;
    this.mem = {};            // per-game memory, reset when a game starts
    this.lastGameKey = null;
    this.lastResult = null;
    this.selectTimer = null;
    this.lastChatAt = 0;
    this.lastGenericAt = 0;
  }

  stop() { this.alive = false; for (const t of this.timers) clearTimeout(t); this.timers.clear(); }
  later(ms, fn) {
    if (!this.alive) return;
    const t = setTimeout(() => { this.timers.delete(t); if (this.alive) { try { fn(); } catch (e) { /* never crash the server */ } } }, ms);
    this.timers.add(t); return t;
  }
  cancel(t) { if (t) { clearTimeout(t); this.timers.delete(t); } }
  say(text, delay = 900 + rnd(900)) { this.later(delay, () => { this.lastChatAt = Date.now(); this.do({ t: 'chat', text, id: 'bot' + rnd(1e9) }); }); }
  act(a, delay = 0) { this.later(delay, () => this.do({ t: 'act', a })); }

  // ------------------------------------------------------------- messages from the server
  receive(m) {
    if (!this.alive || !m) return;
    switch (m.t) {
      case 'matched':
        this.say('はじめまして！ AIのロボです🤖 ぼくはプログラムで動いているよ。いっしょに遊ぼう！', 1200);
        this.say('どのゲームにする？ 迷ったら「以心伝心」がおすすめ！', 2600);
        return;
      case 'view': this.onView(m.view); return;
      case 'chat':
        if (m.from === 'partner') {
          if (m.seq) this.later(500 + rnd(500), () => this.do({ t: 'read', upTo: m.seq }));
          this.onPartnerChat(String(m.text || ''));
        }
        return;
      case 'chat_rejected': this.rejected = (this.rejected || 0) + 1; this.lastRejected = m.text; return;
      case 'stamp':
        if (m.from === 'partner' && !this.mem.stampReplied) { this.mem.stampReplied = true; this.later(1200, () => this.do({ t: 'stamp', id: m.id === 'thanks' ? 'fun' : 'thanks' })); }
        return;
      default:
    }
  }

  // ------------------------------------------------------------- game state
  onView(V) {
    this.prevV = this.V; this.V = V;
    if (V.phase === 'select') {
      this.lastGameKey = null;
      if (!this.selectTimer) this.selectTimer = this.later(28000, () => {
        this.selectTimer = null;
        if (this.V && this.V.phase === 'select') {
          const g = pick(games.GAME_IDS);
          this.say(`じゃあ「${gameName(g)}」をやってみない？`, 0);
          this.act({ type: 'pick', game: g }, 2500);
        }
      });
      return;
    }
    this.cancel(this.selectTimer); this.selectTimer = null;
    if (V.phase === 'result') {
      if (V.result && V.result.id !== this.lastResult) {
        this.lastResult = V.result.id;
        const win = V.result.clear || V.result.loser === 'partner';
        this.later(1400, () => this.do({ t: 'stamp', id: V.result.clear ? 'team' : 'fun' }));
        this.say(win ? 'やったね！ 楽しかった〜🎉 もう一回やる？ それとも別のゲームにする？'
          : V.result.loser === 'me' ? 'あちゃー、ぼくの負け😵 もう一回やろう！' : 'おしかった！ もう一回やってみる？', 2600);
      }
      return;
    }
    if (this.lastGameKey !== V.game) { this.lastGameKey = V.game; this.mem = {}; this.onGameStart(V); }
    const fn = this['view_' + V.game]; if (fn) fn.call(this, V.play || {}, V);
  }

  onGameStart(V) {
    const intro = {
      kokoro: 'よーし、ぼくも直感で選ぶね！',
      lock: null, maze: null, draw: null, puzzle: null, ten: null,
      ngword: 'NGワード、ぼくも知らないからドキドキ…がんばろう！',
    }[V.game];
    if (intro) this.say(intro, 1200);
  }

  // ------------------------------------------------------------- chat from the human
  onPartnerChat(text) {
    const s = norm(text);
    const V = this.V;
    let handled = false;
    if (V && V.phase === 'select') {
      for (const [g, re] of GAME_NAME_WORDS) if (re.test(s)) { this.say(`いいね、「${gameName(g)}」やろう！`, 700); this.act({ type: 'pick', game: g }, 1800); return; }
    }
    if (V && V.phase === 'result' && /もう一回|もういっかい|もう1回|もう一度|again|やろう|いいよ|うん/.test(s)) { this.act({ type: 'again' }, 1500); return; }
    if (V && V.phase === 'result' && /別|べつ|ほか|他/.test(s)) { this.act({ type: 'menu' }, 1500); return; }
    if (V && V.phase === 'play') {
      const fn = this['chat_' + V.game];
      if (fn) handled = fn.call(this, text, s, V.play || {}) === true;
    }
    if (!handled) this.genericReply(s);
  }

  genericReply(s) {
    if (Date.now() - this.lastGenericAt < 5000) return;
    let r = null;
    if (/ai|ロボ|ろぼ|人間|にんげん|bot|ボット|機械/.test(s)) r = 'ぼくはプログラムで動くAIだよ🤖 人が見つかるまで、いっしょに遊ぼうね！';
    else if (/はじめまして|こんにちは|こんばんは|おはよう/.test(s)) r = 'こんにちは！ よろしくね😊';
    else if (/よろしく/.test(s)) r = 'こちらこそ、よろしくね！';
    else if (/ありがと/.test(s)) r = 'どういたしまして！';
    else if (/すごい|ナイス|天才|上手|うまい/.test(s)) r = 'えへへ、ありがとう！ きみもナイス！';
    else if (/楽しい|たのしい|おもしろい|面白い/.test(s)) r = 'ぼくも楽しい！';
    else if (/ごめん/.test(s)) r = 'ぜんぜん大丈夫だよ！';
    else if (/またね|ばいばい|バイバイ|おやすみ/.test(s)) r = 'またあそぼうね！👋';
    else if (this.V && this.V.phase !== 'play' && Math.random() < 0.5) r = pick(['うんうん！', 'なるほど！', 'いいね！', 'そうなんだ！']);
    if (r) { this.lastGenericAt = Date.now(); this.say(r); }
  }

  // ============================================================= 以心伝心
  view_kokoro(P) {
    if (!P.reveal && P.mine === null && this.mem.answered !== P.i) {
      this.mem.answered = P.i;
      this.act({ type: 'ans', q: P.i, c: rnd(P.opts.length) }, 1800 + rnd(2500));
    }
    if (P.reveal && this.mem.commented !== P.i) {
      this.mem.commented = P.i;
      if (P.mine === P.theirs) this.say(pick(['やった、そろった！🎉', '同じだ！ 気が合うね😊', 'いぇーい、以心伝心！']), 1000);
      else this.say(`ぼくは「${P.opts[P.mine]}」にしたよ！ どうして「${P.opts[P.theirs]}」にしたの？`, 1000);
      const i = P.i;
      this.later(9000, () => { if (this.V && this.V.play && this.V.play.reveal && this.V.play.i === i) this.act({ type: 'next', q: i }); });
    }
  }

  // ============================================================= 記号ロック
  view_lock(P) {
    if (P.instr) {
      const key = `${P.round}:${P.input}:${P.miss}`;
      if (this.mem.lockKey === key) return;
      const missed = this.mem.lockMiss !== undefined && P.miss > this.mem.lockMiss;
      const newRound = this.mem.lockRound !== P.round;
      this.mem.lockKey = key; this.mem.lockMiss = P.miss; this.mem.lockRound = P.round;
      if (P.input >= P.len) return;
      const d = glyphName(P.code[P.input]);
      let msg;
      if (newRound) msg = `ロック${P.round + 1}はぼくが伝えるね！ ${P.len}個あるよ。1つ目は「${d}」！`;
      else if (missed) msg = `あれ、ちがったみたい💦 もう一度最初から！ 1つ目は「${d}」だよ`;
      else msg = `${P.input + 1}つ目は「${d}」！`;
      this.say(msg, newRound ? 1500 : 1100);
    } else {
      if (this.mem.lockRound !== P.round) {
        this.mem.lockRound = P.round; this.mem.queue = [];
        this.mem.lockMiss = P.miss;
        this.say(`ロック${P.round + 1}はぼくが押すね！ 記号を「三角の中に点」みたいに教えて〜`, 1200);
      }
      if (P.miss > (this.mem.lockMiss || 0)) {
        this.mem.lockMiss = P.miss; this.mem.queue = [];
        this.say('ごめん、まちがえちゃった💦 もう一度、1つ目から教えて！', 900);
      }
    }
  }
  chat_lock(text, s, P) {
    if (P.instr) return false;
    const segs = s.split(/[、,，。.\n!！?？]|それから|そして|つぎ|次|あと|で、/).map((x) => x.trim()).filter(Boolean);
    const got = [], partial = [];
    for (const seg of segs) {
      const sh = firstIndex(seg, SHAPE_WORDS), mk = firstIndex(seg, MARK_WORDS);
      if (sh >= 0 && mk >= 0) got.push(sh + mk * 4);
      else if (sh >= 0 || mk >= 0) partial.push([sh, mk]);
    }
    if (!got.length) {
      if (partial.length) {
        const [sh, mk] = partial[0];
        this.say(sh >= 0 ? `${SHAPE_NAMES[sh]}だね！ 中は点・横線・バツのどれ？` : `${MARK_NAMES[mk]}だね！ 外の形は丸・三角・四角・ひし形のどれ？`, 800);
        return true;
      }
      return false;
    }
    let delay = 900;
    for (const id of got) {
      this.later(delay, () => { const p = this.V && this.V.play; if (p && !p.instr) this.do({ t: 'act', a: { type: 'press', s: id, r: p.round } }); });
      delay += 900;
    }
    this.say(got.length > 1 ? `わかった、${got.length}個まとめて押すね！` : `「${glyphName(got[0])}」だね、押すよ！`, 300);
    return true;
  }

  // ============================================================= 霧の迷路
  view_maze(P) {
    const key = P.moves + P.bumps;
    if (P.nav) {
      if (this.mem.mazeKey === key) return;
      const bumped = this.mem.mazeBumps !== undefined && P.bumps > this.mem.mazeBumps;
      const first = this.mem.mazeKey === undefined;
      this.mem.mazeKey = key; this.mem.mazeBumps = P.bumps;
      this.cancel(this.mem.navTimer);
      this.mem.navTimer = this.later(first ? 1500 : 1300, () => {
        const p = this.V && this.V.play; if (!p || !p.nav || p.moves + p.bumps !== key) return;
        const run = nextRun(p);
        if (!run) return;
        const head = first ? '地図が見えるよ！ ぼくが道案内するね。' : bumped ? 'そっちは壁だったみたい！ ' : '';
        this.do({ t: 'chat', text: `${head}次は${DIRS[run.d][3]}に${run.k}マス進んで！`, id: 'bot' + rnd(1e9) });
      });
    } else if (this.mem.mazeKey === undefined) {
      this.mem.mazeKey = key; this.mem.moves = [];
      this.say('まわりしか見えない…🌫️ 「右に2マス」みたいに道案内してね！', 1200);
      this.later(2600, () => this.describeSurroundings());
    }
  }
  chat_maze(text, s, P) {
    if (P.nav) return false;
    const moves = [];
    // hiragana direction words only count when used as directions ("した" also ends verbs like 了解した)
    s = s.replace(/(うえ|した|みぎ|ひだり)(?!に|へ|まで|[0-9０-９一二三四五六七八九]|マス|ます)/g, ' ');
    const re = /(上|うえ|↑|北|下|した|↓|南|右|みぎ|→|東|左|ひだり|←|西)(?:に|へ|方向に|ほうに)?\s*([0-9０-９]+|[一二三四五六七八九]|いち|に|さん|よん|ご)?\s*(?:マス|ます|歩|ほ|回|かい|つ)?/g;
    let m;
    while ((m = re.exec(s))) {
      const word = m[1];
      const d = DIR_WORDS.find(([, ws]) => ws.includes(word))[0];
      let k = 1;
      if (m[2]) k = /^[0-9]+$/.test(m[2].normalize('NFKC')) ? parseInt(m[2].normalize('NFKC'), 10) : (KANJI_NUM[m[2]] || 1);
      k = Math.max(1, Math.min(8, k));
      for (let i = 0; i < k; i++) moves.push(d);
    }
    if (!moves.length) return false;
    this.say(pick(['了解！', 'OK、進むね！', 'わかった〜']), 300);
    let delay = 900;
    for (const d of moves) {
      this.later(delay, () => { const p = this.V && this.V.play; if (p && !p.nav) this.do({ t: 'act', a: { type: 'move', d, m: p.moves + p.bumps } }); });
      delay += 750;
    }
    this.cancel(this.mem.describeTimer);
    this.mem.describeTimer = this.later(delay + 700, () => this.describeSurroundings());
    return true;
  }
  describeSurroundings() {
    const p = this.V && this.V.play; if (!p || p.nav || this.V.phase !== 'play') return;
    const c = p.cells[p.pos]; if (c === null || c === undefined) return;
    const open = ['n', 'e', 's', 'w'].filter((d) => !(c & DIRS[d][2])).map((d) => DIRS[d][3]);
    const goal = p.goal >= 0 ? ' 🏁 ゴールが見えた！' : '';
    this.say(`いま進めるのは「${open.join('・')}」だよ。${goal}`, 300);
  }

  // ============================================================= お絵かき伝言
  view_draw(P) {
    const key = `${P.round}:${P.drawer}`;
    if (this.mem.drawKey === key) {
      if (!P.drawer && this.mem.wrongCount !== P.guesses.length) this.mem.wrongCount = P.guesses.length;
      return;
    }
    this.mem.drawKey = key;
    this.cancel(this.mem.hintTimer1); this.cancel(this.mem.hintTimer2); this.cancel(this.mem.guessTimer);
    if (P.drawer) {
      const info = WORD_INFO[P.word] || ['その他', 'ひみつ', 'がんばって！', ''];
      const round = P.round;
      this.say(`ぼくは絵が描けないから、言葉でヒントを出すね！ ヒント①：${info[1]}`, 1500);
      this.mem.hintTimer1 = this.later(22000, () => { if (this.stillDrawRound(round)) this.do({ t: 'chat', text: `ヒント②：${info[2]}`, id: 'bot' + rnd(1e9) }); });
      this.mem.hintTimer2 = this.later(44000, () => { if (this.stillDrawRound(round)) this.do({ t: 'chat', text: `ヒント③：${info[3]}（ジャンルは「${info[0]}」）`, id: 'bot' + rnd(1e9) }); });
    } else {
      this.mem.tried = new Set(); this.mem.cats = new Set();
      this.say('よーし、当てるぞ！ チャットでジャンル（食べ物、動物、乗り物…）も教えてくれると助かる！', 1500);
      this.scheduleGuess(P.round, 9000);
    }
  }
  stillDrawRound(round) { const p = this.V && this.V.play; return this.V && this.V.phase === 'play' && this.V.game === 'draw' && p.round === round; }
  scheduleGuess(round, ms) {
    this.cancel(this.mem.guessTimer);
    this.mem.guessTimer = this.later(ms, () => {
      const p = this.V && this.V.play;
      if (!this.stillDrawRound(round) || p.drawer) return;
      const cands = Object.keys(WORD_INFO).filter((w) => [...w].length === p.len && !this.mem.tried.has(w)
        && (!this.mem.cats.size || this.mem.cats.has(WORD_INFO[w][0])));
      const pool = cands.length ? cands : Object.keys(WORD_INFO).filter((w) => [...w].length === p.len && !this.mem.tried.has(w));
      if (!pool.length) { this.do({ t: 'act', a: { type: 'pass', r: round } }); return; }
      const g = pick(pool); this.mem.tried.add(g);
      this.do({ t: 'act', a: { type: 'guess', text: g, r: round } });
      this.scheduleGuess(round, 7000 + rnd(3000));
    });
  }
  chat_draw(text, s, P) {
    if (P.drawer) return false;
    let found = false;
    for (const [cat, words] of Object.entries(CATEGORY_WORDS)) if ([cat, ...words].some((w) => s.includes(norm(w)))) { this.mem.cats.add(cat); found = true; }
    if (found) { this.say(`「${[...this.mem.cats].join('・')}」だね、考えてみる！`, 600); this.scheduleGuess(P.round, 2500); return true; }
    return false;
  }

  // ============================================================= ふたりパズル
  view_puzzle(P) {
    if (!this.mem.told) {
      this.mem.told = true;
      const lines = P.hints.map((h) => `${h.e}は${CELL_NAMES[h.cell]}`);
      this.say(`きみのピースの場所を教えるね！ ${lines.slice(0, 3).join('、')}`, 1500);
      if (lines.length > 3) this.say(`それから ${lines.slice(3).join('、')}！`, 3600);
      this.say(`ぼくのピース（${P.hand.map((h) => h.e).join('')}）の場所は、きみの画面に出てるはず。「🍎は左上」みたいに教えてね！`, 5800);
    }
    if (P.lastCount !== null && this.mem.lastCount !== P.lastCount + ':' + P.checks) {
      this.mem.lastCount = P.lastCount + ':' + P.checks;
      const lines = P.hints.map((h) => `${h.e}は${CELL_NAMES[h.cell]}`);
      this.say(`${P.lastCount}個あってた！ もう一度確認しよう。きみのピースは ${lines.join('、')} だよ。ぼくのピースの場所ももう一回教えて！`, 1200);
    }
    const full = P.board.every((b) => b);
    this.cancel(this.mem.checkTimer);
    if (full) this.mem.checkTimer = this.later(9000, () => {
      const p = this.V && this.V.play;
      if (this.V.game === 'puzzle' && this.V.phase === 'play' && p.board.every((b) => b)) { this.say('全部うまったね！ 答え合わせしてみるよ', 0); this.act({ type: 'check' }, 1200); }
    });
  }
  chat_puzzle(text, s, P) {
    const mine = P.hand.concat(P.board.filter((b) => b && b.mine).map((b) => ({ k: b.k, e: b.e })));
    const hits = [];
    for (const t of mine) { const at = text.indexOf(t.e); if (at >= 0) hits.push({ ...t, at }); }
    if (!hits.length) return false;
    hits.sort((a, b) => a.at - b.at);
    let delay = 800; const done = [], unclear = [];
    hits.forEach((h, i) => {
      const seg = text.slice(h.at + h.e.length, i + 1 < hits.length ? hits[i + 1].at : undefined);
      const cell = parseCell(seg);
      if (cell < 0) { unclear.push(h.e); return; }
      const occ = P.board[cell];
      if (occ && !occ.mine) { unclear.push(h.e); this.say(`${CELL_NAMES[cell]}には、もう${occ.e}が置いてあるみたい🤔`, 500); return; }
      this.act({ type: 'place', k: h.k, cell }, delay); delay += 700; done.push(`${h.e}を${CELL_NAMES[cell]}`);
    });
    if (done.length) this.say(`${done.join('、')}に置くね！`, 300);
    if (unclear.length) this.say(`${unclear.join('')}はどこに置けばいい？「左上」「真ん中」みたいに教えて！`, 900);
    return true;
  }

  // ============================================================= 合わせて○○
  view_ten(P) {
    if (this.mem.tenRound !== P.round) {
      this.mem.tenRound = P.round; this.mem.hint = null; this.mem.picked = false;
      const round = P.round;
      this.mem.tenTimer = this.later(7000, () => this.tenPick(round, true));
      if (round === 0) this.say('数字は言えないから、「大きめ」「奇数」みたいなヒントで相談しよう！ きみはどんなカードを出す？', 1200);
    }
    if (P.reveal && this.mem.tenCommented !== P.round) {
      this.mem.tenCommented = P.round;
      this.say(P.mine !== null && P.hand[P.mine] + P.theirs === P.target ? 'ぴったり！🎯 すごい！' : 'おしい！ 次はいけるよ！', 900);
      const r = P.round; this.later(7000, () => { const p = this.V && this.V.play; if (p && p.reveal && p.round === r) this.act({ type: 'next', r }); });
    }
  }
  tenPick(round, announce) {
    const p = this.V && this.V.play;
    if (!p || this.V.game !== 'ten' || p.round !== round || p.mine !== null || this.mem.picked) return;
    // choose my card so that the partner's needed value is a real card value and, if they hinted, matches the hint
    const opts = p.hand.map((c, i) => ({ i, c, need: p.target - c })).filter((o) => o.need >= 1 && o.need <= 9);
    const hinted = this.mem.hint ? opts.filter((o) => fitsHint(o.need, this.mem.hint)) : [];
    const choice = pick(hinted.length ? hinted : opts.length ? opts : p.hand.map((c, i) => ({ i, c, need: 0 })));
    this.mem.picked = true;
    if (announce && !this.mem.hint) {
      const parity = choice.c % 2 ? '奇数' : '偶数';
      this.do({ t: 'chat', text: `ぼくは${sizeWord(choice.c)}の${parity}を出すね！ 合わせて目標の数になるカードを選んで！`, id: 'bot' + rnd(1e9) });
    } else if (this.mem.hint) {
      this.do({ t: 'chat', text: 'ヒントありがとう！ それに合わせて選んだよ', id: 'bot' + rnd(1e9) });
    }
    this.act({ type: 'pick', i: choice.i, r: round }, 1200);
  }
  chat_ten(text, s, P) {
    const h = parseTenHint(text);
    if (!h || P.mine !== null) return false;
    this.mem.hint = { ...(this.mem.hint || {}), ...h };
    this.cancel(this.mem.tenTimer);
    this.later(1500, () => this.tenPick(P.round, false));
    return true;
  }

  // ============================================================= NGワードトーク
  view_ngword(P, V) {
    if (this.mem.ngStarted) return;
    this.mem.ngStarted = true; this.mem.lines = 0; this.mem.used = new Set();
    const topic = P.topic;
    const cands = (games.NG_TOPICS.find(([t]) => t === topic) || [null, []])[1].map((f) => f[0]);
    const speak = () => {
      if (!this.V || this.V.game !== 'ngword' || this.V.phase !== 'play') return;
      let line;
      if (cands.length && Math.random() < 0.22) { const w = pick(cands); line = `${topic}といえば…${w}とか？`; }
      else {
        const pool = NG_LINES.filter((f) => !this.mem.used.has(f)); const f = pick(pool.length ? pool : NG_LINES);
        this.mem.used.add(f); line = f(topic);
      }
      this.do({ t: 'chat', text: line, id: 'bot' + rnd(1e9) });
      this.mem.lines++;
      this.later(22000 + rnd(10000), speak);
    };
    this.later(3000, speak);
  }
  chat_ngword(text, s, P) {
    if (Math.random() < 0.55) { const r = pick(NG_REACTIONS.filter((x) => x !== this.mem.lastReaction)); this.mem.lastReaction = r; this.say(r, 1500 + rnd(1500)); }
    return true;
  }
}

function nextRun(p) {
  const w = p.w, start = p.pos;
  // BFS on the full map (the bot is the navigator here, so it is allowed to see it)
  const prev = new Map([[start, null]]), q = [start];
  while (q.length) {
    const c = q.shift(); if (c === p.goal) break;
    for (const d of ['n', 'e', 's', 'w']) {
      const [dx, dy, bit] = DIRS[d]; if (p.cells[c] & bit) continue;
      const n = c + dx + dy * w; if (!prev.has(n)) { prev.set(n, [c, d]); q.push(n); }
    }
  }
  if (!prev.has(p.goal)) return null;
  const path = []; for (let c = p.goal; prev.get(c); c = prev.get(c)[0]) path.unshift(prev.get(c)[1]);
  if (!path.length) return null;
  let k = 1; while (k < path.length && path[k] === path[0]) k++;
  return { d: path[0], k };
}

const GAME_TITLES = { kokoro: '以心伝心', lock: '記号ロック', maze: '霧の迷路', draw: 'お絵かき伝言', puzzle: 'ふたりパズル', ten: '合わせて○○', ngword: 'NGワードトーク' };
const gameName = (g) => GAME_TITLES[g] || g;

module.exports = { BotBrain, BOT_NAME, WORD_INFO, CATEGORY_WORDS, glyphName, parseCell, nextRun, _internal: { firstIndex, SHAPE_WORDS, MARK_WORDS, parseTenHint, fitsHint } };
