'use strict';
// Chat / name filters. Edit the word lists to fit your community.

// Contact info & off-platform handles — always blocked (rule: no contact exchange).
const CONTACT_WORDS = [
  'line', 'insta', 'instagram', 'linemo', 'インスタ', 'いんすた', 'twitter', 'ツイッター', 'discord', 'ディスコ',
  'tiktok', 'ティックトック', 'kakao', 'カカオ', 'telegram', 'テレグラム', 'skype', 'facebook', 'フェイスブック',
  'メアド', 'メルアド', '電話番号', 'でんわばんごう', '連絡先', 'れんらくさき', 'id教え', 'id交換', 'アカウント教え',
  'dm', 'ｄｍ', '垢', 'カカオトーク', 'snapchat', 'threads', 'スレッズ', 'whatsapp',
];

// Harassment etc. — blocked. Add sexual / discriminatory terms your moderators want to stop.
const NG_WORDS = [
  '死ね', 'しね', '氏ね', '殺す', 'ころす', '消えろ', 'きえろ', 'ブス', 'ぶす', 'デブ', 'でぶ', 'きもい', 'キモい', 'キモ',
  'うざい', 'ウザい', 'カス', 'ゴミ', 'ごみ', 'クズ', 'くず',
];

const KANJI_DIGITS = /[〇一二三四五六七八九零壱弐参]/g;

function normalize(t) {
  return String(t).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function looksLikeContact(text) {
  const raw = String(text).normalize('NFKC').toLowerCase();
  const z = normalize(text);
  const digits = (z.match(/[0-9]/g) || []).length + (z.match(KANJI_DIGITS) || []).length;
  if (digits >= 8) return true;
  if (/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/.test(z)) return true;
  if (/https?:|www\.|\.(com|jp|net|me|io|org|co|ly|gg)\b/.test(raw)) return true;
  if (/(^|[^a-z0-9])@[a-z0-9_.]{3,}/.test(raw)) return true;
  if (/(^|[^a-z])id[:：]/.test(raw)) return true;
  if (CONTEXT_WORDS.some((w) => z.includes(w)) && EXCHANGE_CONTEXT.test(z)) return true;
  return CONTACT_WORDS.some((w) => {
    if (/^[a-z]+$/.test(w)) return new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(raw);
    return z.includes(w);
  });
}

// Words that are also normal game talk ("横のライン") — blocked only with exchange-ish context.
const CONTEXT_WORDS = ['ライン', 'らいん'];
const EXCHANGE_CONTEXT = /(交換|こうかん|教え|おしえ|やって|やってる|id|追加|ついか|登録|ふるふる|qr|送って|持って|もって|入れて|つなが|繋が|やろう|しよ)/;

function hasNg(text) {
  const z = normalize(text);
  return NG_WORDS.some((w) => z.includes(normalize(w)));
}

/** returns null if OK, or a reason string (Japanese) to show the sender */
function checkChat(text) {
  if (looksLikeContact(text)) return '連絡先やSNSのIDの交換はできません（ルールで禁止されています）';
  if (hasNg(text)) return '相手が傷つくかもしれない言葉が含まれています';
  return null;
}

function cleanName(name) {
  let n = String(name || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯]/g, '').trim().slice(0, 12);
  if (!n || looksLikeContact(n) || hasNg(n)) return null;
  return n;
}

module.exports = { checkChat, cleanName, looksLikeContact, hasNg };
