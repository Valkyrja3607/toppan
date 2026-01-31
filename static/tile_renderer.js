// --- Mahjong Tile Renderer (asset-based, Tenhou-style) ---
// Usage: createTileSVG(label, { small:false, facedown:false })
// Labels supported: "1m/5p/7s/0m/0p/0s", "1萬/5筒/7索", "東南西北白發中", "1z..7z", and BACK/🀫
// Red-dora: 0m/0p/0s, or 5mr/5pr/5sr, or 赤5萬/赤5筒/赤5索
// Returns an <img> element (keeps API name createTileSVG so client.jsは無改変でOK)

let ASSET_BASE = (typeof window !== 'undefined' && window.TILE_ASSET_BASE)
  ? normalizeBase(window.TILE_ASSET_BASE)
  : '/assets/tiles/'; // primary
const ALT_BASES = ['/static/assets/tiles/', 'assets/tiles/']; // fallback if 404

function normalizeBase(b){ return /\/$/.test(b) ? b : b + '/'; }
export function setTileAssetBase(b){ ASSET_BASE = normalizeBase(b); }

export function createTileSVG(label, { small=false, facedown=false } = {}) {
  const s = String(label ?? '');
  if (/^(BACK|🀫)$/u.test(s)) facedown = true;

  const t = facedown ? { back:true } : parseLabel(label);
  const file = filenameFor(t);
  const img = new Image();
  img.alt = facedown ? 'tile-back' : String(label);
  img.decoding = 'async';
  img.loading = 'eager';
  img.draggable = false;
  img.className = 'tile-img clickable';

  // Size: keep previous semantics so既存CSSと整合
  const H = small ? 42 : 60; // height px (Tenhou比率に近い)
  img.style.height = H + 'px';
  img.style.width = 'auto';
  img.style.filter = 'drop-shadow(0 1.5px 1px rgba(0,0,0,.32))';

  // Load with graceful base fallbacks
  const candidates = [ASSET_BASE + file, ...ALT_BASES.map(b => normalizeBase(b) + file)];
  let i = 0;
  img.src = candidates[i];
  img.onerror = () => { i++; if (i < candidates.length) img.src = candidates[i]; };

  return img;
}

export function parseLabel(raw) {
  if (!raw && raw !== 0) return null;
  const s = String(raw).trim();

  // 1) Honors 1z..7z
  let m = s.match(/^([1-7])z$/i);
  if (m) {
    const honors = ['東','南','西','北','白','發','中'];
    return { kind:'honor', text: honors[parseInt(m[1],10)-1] };
  }

  // 2) Number shorthand ([0-9])([mps]) with red support (0x or 5x[r])
  m = s.match(/^([0-9])([mps])([rR])?$/);
  if (m) {
    let num = parseInt(m[1],10);
    const suit = m[2];
    const isRed = (num === 0) || !!m[3];
    if (num === 0) num = 5; // 0 = red five
    return { kind:'number', suit: suit, num, red: isRed && num === 5 };
  }

  // 3) Kanji forms, including 赤5萬 / 5萬r
  const aka = s.startsWith('赤');
  const core = aka ? s.slice(1) : s;
  const n = core[0];
  const rest = core.slice(1);
  if (/^[1-9]$/.test(n) && rest) {
    let suitKS = null;
    if (rest.startsWith('萬')) suitKS = 'm';
    if (rest.startsWith('筒')) suitKS = 'p';
    if (rest.startsWith('索')) suitKS = 's';
    if (suitKS) {
      const red = aka || /r$/i.test(core);
      return { kind:'number', suit: suitKS, num: parseInt(n,10), red: red && parseInt(n,10) === 5 };
    }
  }

  // 4) Honors Kanji
  if ('東南西北白發中'.includes(s)) return { kind:'honor', text:s };

  // 5) Unicode tiles (🀇..)
  const u = parseUnicodeMahjong(s);
  if (u) return u;

  return null;
}

function filenameFor(t){
  if (!t) return 'ura.gif';
  if (t.back) return 'ura.gif';
  if (t.kind === 'honor') {
    switch (t.text) {
      case '東': return 'ji1-ton.gif';
      case '南': return 'ji2-nan.gif';
      case '西': return 'ji3-sha.gif';
      case '北': return 'ji4-pei.gif';
      case '白': return 'ji5-haku.gif';
      case '發': return 'ji6-hatsu.gif';
      case '中': return 'ji7-chun.gif';
    }
  } else if (t.kind === 'number') {
    const suit = t.suit; // 'm'|'p'|'s'
    const n = t.num;
    if (t.red && n === 5) {
      if (suit === 'm') return 'man-aka5.gif';
      if (suit === 'p') return 'pin-aka5.gif';
      if (suit === 's') return 'sou-aka5.gif';
    }
    if (suit === 'm') return `man${n}.gif`;
    if (suit === 'p') return `pin${n}.gif`;
    if (suit === 's') return `sou${n}.gif`;
  }
  return 'ura.gif';
}

function parseUnicodeMahjong(s){
  if (!s || s.length > 2) return null; // single symbol expected
  const cp = s.codePointAt(0);
  if (!cp) return null;
  // Honors: U+1F000..U+1F006 (East,South,West,North,White,Green,Red)
  if (cp >= 0x1F000 && cp <= 0x1F006) {
    const honors = ['東','南','西','北','白','發','中'];
    return { kind:'honor', text: honors[cp - 0x1F000] };
  }
  // Manzu: U+1F007..U+1F00F (1..9)
  if (cp >= 0x1F007 && cp <= 0x1F00F) {
    return { kind:'number', suit:'m', num: (cp - 0x1F007) + 1, red:false };
  }
  // Souzu: U+1F010..U+1F018 (1..9)
  if (cp >= 0x1F010 && cp <= 0x1F018) {
    return { kind:'number', suit:'s', num: (cp - 0x1F010) + 1, red:false };
  }
  // Pinzu: U+1F019..U+1F021 (1..9)
  if (cp >= 0x1F019 && cp <= 0x1F021) {
    return { kind:'number', suit:'p', num: (cp - 0x1F019) + 1, red:false };
  }
  // Tile back 🀫 U+1F02B (handled earlier via facedown)
  return null;
}
