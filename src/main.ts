import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

const ARCHIVE_EXTS = ["zip", "cbz", "rar", "cbr", "7z", "cb7"];
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"];
function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

// ---- 状態 ----
let pageCount = 0;
let current = 0;
let barTimer: number | undefined;

// 履歴・巻移動。currentAnchor は今開いている「巻」の識別パス
// （アーカイブファイルなら自身のパス、フォルダ/単独画像ならフォルダの基点パス）。
let currentAnchor: string | null = null;
let endBehavior: "loop" | "next" = "loop"; // 巻末に達した時の挙動
let saveTimer: number | undefined;

// 表示レイアウト（回転・フィットモード・綴じ方向）。次回起動時も覚えておく（localStorage）。
type FitMode = "contain" | "width" | "height" | "original";
let rotation = Number(localStorage.getItem("rotation")) || 0; // 0 / 90 / 180 / 270
let fitMode: FitMode = (localStorage.getItem("fitMode") as FitMode | null) || "contain";
let bindMode: "rtl" | "ltr" =
  (localStorage.getItem("bindMode") as "rtl" | "ltr" | null) || "rtl"; // 右綴じが既定（日本の漫画標準）
let natW = 0;
let natH = 0;

// 見開き表示。表紙(0ページ目)は単独、以降は2ページずつ組む。
// 組の中に横長画像（見開きスキャンの1枚絵）があれば、そのページは自動で単独表示にする。
let spreadMode = localStorage.getItem("spreadMode") === "true";
let spreadDims: [{ w: number; h: number }, { w: number; h: number }] | null = null;
// ページの実寸＋GIFアニメーションか（横長判定・見開きレイアウト・リサイズ要否判定に使う）。
const pageDims = new Map<number, { w: number; h: number; animated: boolean }>();

// 画像が画面より大きい時のパン（手のひらツール）。表示中の画像サイズ
// （回転後の見た目寸法）と現在のオフセットを保持し、左ボタンドラッグだけで
// 動かせるようにする（Photoshopの手のひらツールと同じ操作感）。
let dispW = 0;
let dispH = 0;
let panX = 0;
let panY = 0;
let panning = false; // 実際にドラッグ中か
let panStartX = 0;
let panStartY = 0;
let panOrigX = 0;
let panOrigY = 0;
let justPanned = false; // ドラッグ直後のクリックでページがめくれないようにする一時フラグ

// S2（サイド手前ボタン）を押しながらホイール＝巻送り。単押しは1ページ移動のまま。
let s2Down = false;
let s2UsedForVolume = false;

// S1（サイド奥ボタン）を押しながらホイール＝ズーム。単押しは1ページ戻るのまま。
let s1Down = false;
let s1UsedForZoom = false;

// ---- ズーム ----
// fitMode で決まる基準サイズに対する追加倍率。ページ送り・フィット変更でリセットする。
let zoomFactor = 1;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_WHEEL_STEP = 1.15; // ホイール1ノッチあたりの倍率
const ZOOM_KEY_STEP = 1.25; // +/-キー1回あたりの倍率

function resetZoom() {
  zoomFactor = 1;
}

// マウスカーソル位置を基準にズームする（カーソルの指す場所がズーム後も同じ位置に留まる）。
function zoomAt(clientX: number, clientY: number, factor: number) {
  if (pageCount === 0) return;
  const oldZoom = zoomFactor;
  const newZoom = clampNum(oldZoom * factor, ZOOM_MIN, ZOOM_MAX);
  if (newZoom === oldZoom) return;

  const rect = viewer.getBoundingClientRect();
  const mouseX = clientX - rect.left;
  const mouseY = clientY - rect.top;
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const ratio = newZoom / oldZoom;

  // カーソル位置が画像上で指していた点を、ズーム後も同じ画面位置に保つ。
  panX = (mouseX - cx) * (1 - ratio) + panX * ratio;
  panY = (mouseY - cy) * (1 - ratio) + panY * ratio;
  zoomFactor = newZoom;
  applyLayoutSettled();
}

// 画面中央基準のズーム（キーボード操作用）。
function zoomCenter(factor: number) {
  const rect = viewer.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
}

// ズームと表示位置を初期状態へ戻す（0キー・ナビゲーターのリセットボタン共通）。
function zoomResetAction() {
  resetZoom();
  panX = 0;
  panY = 0;
  applyLayoutSettled();
}

// ---- キー割り当て（ユーザーがカスタマイズ可能） ----
// Escape・見開き/一覧パネルのEscによる閉じる操作は固定（システム的な操作のため対象外）。
type ActionId =
  | "prev"
  | "next"
  | "home"
  | "end"
  | "toggleSpread"
  | "toggleBind"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleGrid"
  | "toggleBookmark"
  | "bookmarksList"
  | "openFile"
  | "toggleHelp";

interface KeyBinding {
  key: string; // ""＝未設定
  ctrl?: boolean;
}

const ACTION_ORDER: ActionId[] = [
  "prev",
  "next",
  "home",
  "end",
  "toggleSpread",
  "toggleBind",
  "zoomIn",
  "zoomOut",
  "zoomReset",
  "toggleGrid",
  "toggleBookmark",
  "bookmarksList",
  "openFile",
  "toggleHelp",
];

const ACTION_LABELS: Record<ActionId, string> = {
  prev: "1ページ前",
  next: "1ページ次",
  home: "先頭ページへ",
  end: "末尾ページへ",
  toggleSpread: "見開き切替",
  toggleBind: "綴じ方向切替",
  zoomIn: "ズームイン",
  zoomOut: "ズームアウト",
  zoomReset: "ズームリセット",
  toggleGrid: "サムネイル一覧",
  toggleBookmark: "しおり登録・解除",
  bookmarksList: "しおり一覧",
  openFile: "ファイルを開く",
  toggleHelp: "この説明書",
};

const DEFAULT_KEYMAP: Record<ActionId, KeyBinding> = {
  prev: { key: "ArrowLeft" },
  next: { key: "ArrowRight" },
  home: { key: "Home" },
  end: { key: "End" },
  toggleSpread: { key: "d" },
  toggleBind: { key: "r" },
  zoomIn: { key: "+" },
  zoomOut: { key: "-" },
  zoomReset: { key: "0" },
  toggleGrid: { key: "a" },
  toggleBookmark: { key: "b" },
  bookmarksList: { key: "b", ctrl: true },
  openFile: { key: "o", ctrl: true },
  toggleHelp: { key: "h" },
};

function loadKeymap(): Record<ActionId, KeyBinding> {
  const merged = { ...DEFAULT_KEYMAP };
  try {
    const saved = JSON.parse(localStorage.getItem("keymap") || "null");
    if (saved && typeof saved === "object") {
      for (const id of ACTION_ORDER) {
        if (saved[id] && typeof saved[id].key === "string") merged[id] = saved[id];
      }
    }
  } catch {
    // 壊れた保存値は無視して既定値を使う
  }
  return merged;
}

let keymap = loadKeymap();

function saveKeymap() {
  localStorage.setItem("keymap", JSON.stringify(keymap));
}

// 見た目のキー表記（矢印記号・Ctrl+接頭辞など）。
function formatKeyLabel(b: KeyBinding): string {
  if (!b.key) return "未設定";
  const names: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    " ": "Space",
  };
  const label = names[b.key] ?? (b.key.length === 1 ? b.key.toUpperCase() : b.key);
  return (b.ctrl ? "Ctrl+" : "") + label;
}

// キーイベントが指定の割り当てに一致するか。
// "+"は日本語配列等でShiftなしでは"="として送られることがあるため、
// 既定の"+"割り当てに限り"="も救済的に一致させる。
function keyMatches(e: KeyboardEvent, b: KeyBinding): boolean {
  if (!b.key) return false;
  if (!!b.ctrl !== e.ctrlKey) return false;
  if (e.key.toLowerCase() === b.key.toLowerCase()) return true;
  if (b.key === "+" && e.key === "=") return true;
  return false;
}

function matchAction(e: KeyboardEvent, action: ActionId): boolean {
  return keyMatches(e, keymap[action]);
}

// 実際のキー操作を実行する（switch文の代わりにactionIdで一元管理）。
function runAction(action: ActionId) {
  switch (action) {
    case "prev":
      go(-1);
      break;
    case "next":
      go(1);
      break;
    case "home":
      jump(0);
      break;
    case "end":
      jump(pageCount - 1);
      break;
    case "toggleSpread":
      toggleSpread();
      break;
    case "toggleBind":
      toggleBindMode();
      break;
    case "zoomIn":
      zoomCenter(ZOOM_KEY_STEP);
      break;
    case "zoomOut":
      zoomCenter(1 / ZOOM_KEY_STEP);
      break;
    case "zoomReset":
      zoomResetAction();
      break;
    case "toggleGrid":
      toggleGrid();
      break;
    case "toggleBookmark":
      toggleBookmark();
      break;
    case "bookmarksList":
      toggleBookmarksPanel();
      break;
    case "openFile":
      pickFile();
      break;
    case "toggleHelp":
      openHelp();
      break;
  }
}

// アーカイブの世代番号。開き直すたびに増やし、古いアーカイブへの
// 問い合わせが後から解決してもキャッシュを汚さないようにする。
let archiveGen = 0;

// ページキャッシュ（index -> objectURL）と先読み設定
const pageCache = new Map<number, string>();
const pageBytes = new Map<number, number>(); // 各キャッシュページのバイト数（メモリ使用量管理用）
const pageInflight = new Map<number, Promise<{ url: string; size: number }>>();
const PRELOAD_AHEAD = 3; // 次に何ページ先読みするか
const PRELOAD_BEHIND = 1; // 前に何ページ先読みするか

// キャッシュ上限（バイト）。設定UIのプリセットで変更、localStorageに保存する。
let cacheLimitBytes = loadCacheLimitMb() * 1024 * 1024;
function loadCacheLimitMb(): number {
  const v = Number(localStorage.getItem("cacheMb"));
  return v >= 64 ? v : 512; // 既定は「標準」512MB
}
// キャッシュ使用量の合計。pageBytes を毎回走査すると、破棄ループ（evict）が
// O(n^2) になりページ送りのたびに無駄な計算が走るため、増減時に更新する
// 実行時合計として保持する。
let cacheBytesTotal = 0;
function currentCacheBytes(): number {
  return cacheBytesTotal;
}

// サムネイル一覧
let gridOpen = false;
let thumbUrls: string[] = [];
let io: IntersectionObserver | null = null;
let gridGen = 0; // 世代番号：一覧を開閉するたび更新し、古い生成要求を無効化

// サムネイル生成の同時実行数を制限するセマフォ（負荷でUIを塞がない）
let active = 0;
const MAX_CONC = 4;
const waitQ: Array<() => void> = [];
function acquire(): Promise<void> {
  return new Promise((res) => {
    if (active < MAX_CONC) {
      active++;
      res();
    } else {
      waitQ.push(() => {
        active++;
        res();
      });
    }
  });
}
function release() {
  active--;
  const next = waitQ.shift();
  if (next) next();
}

// ---- 要素 ----
const img = document.querySelector<HTMLImageElement>("#page")!;
const hint = document.querySelector<HTMLDivElement>("#hint")!;
const bar = document.querySelector<HTMLDivElement>("#bar")!;
const topbar = document.querySelector<HTMLDivElement>("#topbar")!;
const counter = document.querySelector<HTMLSpanElement>("#counter")!;
const seek = document.querySelector<HTMLInputElement>("#seek")!;
const menu = document.querySelector<HTMLDivElement>("#menu")!;
const displayMenu = document.querySelector<HTMLDivElement>("#display-menu")!;
const settingsMenu = document.querySelector<HTMLDivElement>("#settings-menu")!;
const viewer = document.querySelector<HTMLDivElement>("#viewer")!;
const bindToggle = document.querySelector<HTMLButtonElement>("#bind-toggle")!;
const bindArrow = document.querySelector<HTMLSpanElement>("#bind-arrow")!;
const grid = document.querySelector<HTMLDivElement>("#grid")!;
const gridScroll = document.querySelector<HTMLDivElement>("#grid-scroll")!;
const thumbSize = document.querySelector<HTMLInputElement>("#thumb-size")!;
const spread = document.querySelector<HTMLDivElement>("#spread")!;
const pageLeftEl = document.querySelector<HTMLImageElement>("#page-left")!;
const pageRightEl = document.querySelector<HTMLImageElement>("#page-right")!;
const progressEl = document.querySelector<HTMLDivElement>("#progress")!;
const progressFillEl = document.querySelector<HTMLDivElement>("#progress-fill")!;
const progressTextEl = document.querySelector<HTMLSpanElement>("#progress-text")!;
const resumeDialog = document.querySelector<HTMLDivElement>("#resume-dialog")!;
const resumeName = document.querySelector<HTMLSpanElement>("#resume-name")!;
const resumePage = document.querySelector<HTMLSpanElement>("#resume-page")!;
const navigatorPanel = document.querySelector<HTMLDivElement>("#navigator-panel")!;
const navigatorEl = document.querySelector<HTMLDivElement>("#navigator")!;
const navThumb = document.querySelector<HTMLImageElement>("#nav-thumb")!;
const navViewport = document.querySelector<HTMLDivElement>("#nav-viewport")!;
const zoomResetBtn = document.querySelector<HTMLButtonElement>("#zoom-reset-btn")!;
const cachePresetRadios = document.querySelectorAll<HTMLInputElement>('input[name="cache-preset"]');
const cacheCustomRadio = document.querySelector<HTMLInputElement>("#cache-custom-radio")!;
const cacheCustomMb = document.querySelector<HTMLInputElement>("#cache-custom-mb")!;
const cacheUsageFill = document.querySelector<HTMLDivElement>("#cache-usage-fill")!;
const cacheUsageText = document.querySelector<HTMLSpanElement>("#cache-usage-text")!;

// ---- サムネイル準備の進捗（ポーリング表示） ----
let progressTimer: number | undefined;

function stopProgressPolling() {
  window.clearInterval(progressTimer);
  progressTimer = undefined;
  progressEl.classList.add("hidden");
}

function startProgressPolling() {
  progressEl.classList.remove("hidden");
  progressFillEl.style.width = "0%";
  progressTextEl.textContent = "画像を準備中…";
  window.clearInterval(progressTimer);
  progressTimer = window.setInterval(async () => {
    try {
      const p = await invoke<{ completed: number; total: number }>("get_thumb_progress");
      if (p.total <= 0) return;
      if (p.completed >= p.total) {
        stopProgressPolling();
        return;
      }
      const pct = Math.round((p.completed / p.total) * 100);
      progressFillEl.style.width = `${pct}%`;
      progressTextEl.textContent = `画像を準備中… ${p.completed} / ${p.total}`;
    } catch {
      stopProgressPolling();
    }
    // 進捗表示のためだけのIPC往復なので、間隔は控えめでよい
    // （200msだと毎秒5回。読み込みが重い最中に余計な負荷をかけてしまう）。
  }, 500);
}

// ---- ページキャッシュ ----
// LRU：アクセスしたページを最新（末尾）へ。
function touch(index: number) {
  const url = pageCache.get(index);
  if (url !== undefined) {
    pageCache.delete(index);
    pageCache.set(index, url);
  }
}

// 上限（メモリ量）超過分を最古から破棄。
// 現在ページに加え、見開き表示中は相方（current+1）も保護する
// （表示中のobjectURLをrevokeすると画像が壊れるため）。
function evict() {
  const protectedPages = new Set([current]);
  // 見開きモード中は相方も常に保護（見開き突入時の取得中＝まだ非表示の間も守るため、
  // 表示状態ではなくモード設定で判定。フォールバック単ページ時に1ページ余計に
  // 保護するだけなので実害はない）。
  if (spreadMode) protectedPages.add(current + 1);
  while (currentCacheBytes() > cacheLimitBytes && pageCache.size > protectedPages.size) {
    let victim: number | undefined;
    for (const k of pageCache.keys()) {
      if (!protectedPages.has(k)) {
        victim = k;
        break;
      }
    }
    if (victim === undefined) break;
    URL.revokeObjectURL(pageCache.get(victim)!);
    pageCache.delete(victim);
    cacheBytesTotal -= pageBytes.get(victim) ?? 0;
    pageBytes.delete(victim);
    predecoded.delete(victim); // 元URLを破棄したので、デコード済みの保持も解く
  }
  updateCacheUsageUi();
}

// ページのobjectURLを取得（キャッシュ優先、無ければ読み込み）。
async function getPageUrl(index: number): Promise<string> {
  const hit = pageCache.get(index);
  if (hit !== undefined) {
    touch(index);
    return hit;
  }
  const gen = archiveGen;
  let p = pageInflight.get(index);
  if (!p) {
    const fetchP = (async () => {
      const buf = await invoke<ArrayBuffer>("get_page", { index });
      return { url: URL.createObjectURL(new Blob([buf])), size: buf.byteLength };
    })();
    p = fetchP;
    pageInflight.set(index, fetchP);
    // 成功・失敗を問わず登録を外す。失敗したPromiseが残り続けると、以後の取得が
    // 全て同じ失敗を返し「そのページだけ二度と読み込めない」状態になるため。
    // （アーカイブ切替でclear済みの場合、新しい登録を消さないよう同一性を確認）
    fetchP
      .catch(() => {})
      .finally(() => {
        if (pageInflight.get(index) === fetchP) pageInflight.delete(index);
      });
  }
  const { url, size } = await p;
  if (gen !== archiveGen) {
    // 取得中に別アーカイブへ切り替わっていた。キャッシュを汚さないよう破棄。
    URL.revokeObjectURL(url);
    return url;
  }
  if (!pageCache.has(index)) {
    pageCache.set(index, url);
    pageBytes.set(index, size);
    cacheBytesTotal += size;
    evict();
  }
  touch(index);
  return url;
}

// ページの実寸（幅・高さ）とGIFアニメーションかを取得（キャッシュ優先）。
// ヘッダーのみ読む軽量コマンドを使う（見開きの横長自動単独判定・リサイズ先読みの
// 目標サイズ計算・レイアウトに使う）。GIFはリサイズすると静止画になるため、
// animated=true の場合は表示時にリサイズをスキップし原寸のまま表示する。
async function getImageDims(
  index: number
): Promise<{ w: number; h: number; animated: boolean }> {
  const cached = pageDims.get(index);
  if (cached) return cached;
  const gen = archiveGen;
  const [w, h, animated] = await invoke<[number, number, boolean]>("get_page_dims", { index });
  const dims = { w, h, animated };
  if (gen === archiveGen) pageDims.set(index, dims); // 別アーカイブに切替済みなら汚さず破棄
  return dims;
}

// 現在の画面サイズ・フィットモード・回転から、ページの目標表示サイズ（回転前の実ピクセル数）を求める。
// applyLayoutSingle() の計算と同じロジック（そちらは自然寸法が既知の前提で共有する）。
function targetBoxFor(natW: number, natH: number): { w: number; h: number } {
  const vw = viewer.clientWidth || 1;
  const vh = viewer.clientHeight || 1;
  const swapped = rotation % 180 !== 0;
  const effW = swapped ? natH : natW;
  const effH = swapped ? natW : natH;
  let targetW: number;
  let targetH: number;
  switch (fitMode) {
    case "width": {
      const scale = vw / effW;
      targetW = vw;
      targetH = effH * scale;
      break;
    }
    case "height": {
      const scale = vh / effH;
      targetH = vh;
      targetW = effW * scale;
      break;
    }
    case "original":
      targetW = effW;
      targetH = effH;
      break;
    default: {
      const scale = Math.min(vw / effW, vh / effH);
      targetW = effW * scale;
      targetH = effH * scale;
    }
  }
  const preW = (swapped ? targetH : targetW) * zoomFactor;
  const preH = (swapped ? targetW : targetH) * zoomFactor;
  return { w: Math.max(1, Math.round(preW)), h: Math.max(1, Math.round(preH)) };
}

// バイト列を先読みしただけでは、めくった瞬間にブラウザのデコード待ちが残る。
// 高解像度の漫画ページではこのデコードが待ち時間の大半を占めるため、
// 次に見る可能性が高いページはデコードまで済ませておく。
// デコード済み画像はメモリを大きく使うので、保持するのは少数に限る。
const predecoded = new Map<number, HTMLImageElement>();
const PREDECODE_KEEP = 3;

async function predecode(index: number) {
  if (index < 0 || index >= pageCount || predecoded.has(index)) return;
  const gen = archiveGen;
  try {
    const url = await getPageUrl(index);
    if (gen !== archiveGen) return;
    const im = new Image();
    im.src = url;
    await im.decode();
    if (gen !== archiveGen || predecoded.has(index)) return;
    predecoded.set(index, im);
    while (predecoded.size > PREDECODE_KEEP) {
      const oldest = predecoded.keys().next().value;
      if (oldest === undefined) break;
      predecoded.delete(oldest);
    }
  } catch {
    // 先読みデコードの失敗は無視（実際に表示する時に改めて読み直す）
  }
}

// 現在ページの前後を裏で先読み（原寸バイト列を先読みし、めくった瞬間に表示できるようにする）。
function runPrefetch() {
  const targets: number[] = [];
  for (let d = 1; d <= PRELOAD_AHEAD; d++) targets.push(current + d);
  for (let d = 1; d <= PRELOAD_BEHIND; d++) targets.push(current - d);
  for (const t of targets) {
    if (t >= 0 && t < pageCount && !pageCache.has(t)) {
      getPageUrl(t).catch(() => {}); // 先読み失敗は無視
    }
  }
  // 直後に見るページ（見開き時はその次の組）だけデコードまで先に済ませる。
  const ahead = spreadMode ? 2 : 1;
  predecode(current + ahead);
  if (spreadMode) {
    // 見開きは表示前にページ寸法（横長かどうかの判定）が必要で、
    // これを待つ分だけめくりが遅れる。次の組の分を先に取っておく。
    for (const t of [current + 2, current + 3]) {
      if (t >= 0 && t < pageCount) getImageDims(t).catch(() => {});
    }
  }
}

// 先読みは「めくる手が止まってから」まとめて行う。ホイールを速く回すと
// ページ送りのたびに最大4ページ分の読み込みが積み重なり、通り過ぎるだけの
// ページのためにディスクI/Oとメモリを消費して、かえって重くなるため。
let prefetchTimer: number | undefined;
function prefetch() {
  window.clearTimeout(prefetchTimer);
  prefetchTimer = window.setTimeout(runPrefetch, 180);
}

function resetPageCache() {
  for (const url of pageCache.values()) URL.revokeObjectURL(url);
  pageCache.clear();
  pageBytes.clear();
  cacheBytesTotal = 0;
  predecoded.clear();
  pageInflight.clear();
  pageDims.clear();
  updateCacheUsageUi();
}

function clampNum(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// 現在の表示サイズ・ウィンドウサイズから、パン可能な範囲（片側の最大量）を求める。
// 画像が画面以下の軸は 0（＝その軸はパンできない）。
function panLimits(): { maxX: number; maxY: number } {
  const vw = viewer.clientWidth;
  const vh = viewer.clientHeight;
  return {
    maxX: Math.max(0, (dispW - vw) / 2),
    maxY: Math.max(0, (dispH - vh) / 2),
  };
}

// 手のひらツールが有効な状況か＝表示中の画像のいずれかの軸が画面より
// 大きい場合（原寸表示に限らず、幅/高さ合わせ等ではみ出た場合も含む）。
function canPan(): boolean {
  const vw = viewer.clientWidth;
  const vh = viewer.clientHeight;
  return dispW > vw + 0.5 || dispH > vh + 0.5;
}

// 同じ値でもstyleへ代入するとブラウザがスタイル再計算を予約してしまうため、
// 変化した時だけ書き込む（applyLayoutSettledが1回のページ送りで2回走る都合上、
// 2回目はほぼ同値になる。無駄な再計算を省くと体感が軽くなる）。
function setStyleIfChanged(el: HTMLElement, prop: "width" | "height" | "transform", value: string) {
  if (el.style[prop] !== value) el.style[prop] = value;
}

// 回転＋パン位置を反映するだけの軽量処理（サイズ計算はしない、ドラッグ中に多用）。
// 見開き時はパンをコンテナ（#spread）側で、回転は各画像側で扱う。
function updateTransform() {
  // translate3d を使うとGPU合成レイヤーに乗り、パン中の再描画がCPU側の
  // ペイントを伴わなくなる（2D translate だと環境により毎回ペイントが走る）。
  if (spreadMode) {
    setStyleIfChanged(spread, "transform", `translate3d(${panX}px, ${panY}px, 0)`);
  } else {
    setStyleIfChanged(
      img,
      "transform",
      `translate3d(${panX}px, ${panY}px, 0) rotate(${rotation}deg)`
    );
  }
}

// パン範囲の再クランプ・カーソル更新までまとめた共通の仕上げ処理。
function finishLayout() {
  const { maxX, maxY } = panLimits();
  panX = clampNum(panX, -maxX, maxX);
  panY = clampNum(panY, -maxY, maxY);
  updateTransform();
  if (!panning) viewer.style.cursor = canPan() ? "grab" : "";
  updateNavigatorVisibility();
  updateNavigatorViewportRect();
}

// ---- ナビゲーター（画像が画面より大きい時に自動表示するミニマップ） ----
let navThumbKey = ""; // 現在ナビゲーターに表示中の内容を示すキー（単ページ/見開きの組を区別する）
let navigatorWasVisible = false; // 前回のミニマップ表示状態（非表示→表示の瞬間にサムネを用意する）

function updateNavigatorVisibility() {
  // ミニマップは「画像が実際に画面からはみ出ている時」だけ。
  // パネル（リセットボタン）はズーム中（縮小含む）も出す。
  const pannable = canPan();
  const zoomed = Math.abs(zoomFactor - 1) > 0.001;
  navigatorPanel.classList.toggle("hidden", !(pannable || zoomed));
  navigatorEl.classList.toggle("hidden", !pannable);
  const label = `拡大率をリセット（${Math.round(zoomFactor * 100)}%）`;
  if (zoomResetBtn.textContent !== label) zoomResetBtn.textContent = label;
  // 非表示の間はサムネイル合成を止めているので、表示された瞬間に追いつかせる。
  if (pannable && !navigatorWasVisible) updateNavigatorThumb();
  navigatorWasVisible = pannable;
}

// ナビゲーター上の現在の表示範囲（矩形）を、パン位置・ズーム倍率から再計算する。
function updateNavigatorViewportRect() {
  if (navigatorEl.classList.contains("hidden")) return;
  const navW = navigatorEl.clientWidth;
  const navH = navigatorEl.clientHeight;
  if (!navW || !navH || !dispW || !dispH) return;
  const vw = viewer.clientWidth;
  const vh = viewer.clientHeight;
  // 画像のローカル座標系(0..dispW, 0..dispH)における、現在ビューポートに写っている範囲。
  const visLeft = clampNum((dispW - vw) / 2 - panX, 0, dispW);
  const visTop = clampNum((dispH - vh) / 2 - panY, 0, dispH);
  const visW = Math.min(vw, dispW);
  const visH = Math.min(vh, dispH);
  navViewport.style.left = `${(visLeft / dispW) * navW}px`;
  navViewport.style.top = `${(visTop / dispH) * navH}px`;
  navViewport.style.width = `${(visW / dispW) * navW}px`;
  navViewport.style.height = `${(visH / dispH) * navH}px`;
}

// 現在の表示内容（単ページ／見開き2ページ）のサムネイルをナビゲーターに読み込む。
// 見開き表示中は左右2ページ分を綴じ方向どおりに並べた1枚の画像に合成する
// （そうしないと見開きなのにナビゲーターだけ単ページ分しか映らないため）。
// 重要：ミニマップが非表示の間は何もしない（毎ページのサムネ取得＋合成が
// ページ送りの体感を重くしていたため。表示された瞬間に updateNavigatorVisibility が呼ぶ）。
async function updateNavigatorThumb() {
  if (pageCount === 0) return;
  if (navigatorEl.classList.contains("hidden")) return;
  const isSpread = spreadMode && shownCount === 2;
  const idxLeft = isSpread ? (bindMode === "rtl" ? current + 1 : current) : current;
  const idxRight = isSpread ? (bindMode === "rtl" ? current : current + 1) : current;
  const key = `${archiveGen}:` + (isSpread ? `spread:${idxLeft}-${idxRight}` : `single:${current}`);
  if (key === navThumbKey) return;
  navThumbKey = key;
  try {
    const indices = isSpread ? [idxLeft, idxRight] : [current];
    const bitmaps = await Promise.all(
      indices.map(async (i) => {
        const buf = await invoke<ArrayBuffer>("get_thumbnail", { index: i });
        return createImageBitmap(new Blob([buf]));
      })
    );
    if (key !== navThumbKey) return; // 取得中に表示内容が変わった
    const h = Math.max(...bitmaps.map((b) => b.height), 1);
    const widths = bitmaps.map((b) => (b.width * h) / b.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(widths.reduce((sum, w) => sum + w, 0)));
    canvas.height = Math.round(h);
    const ctx = canvas.getContext("2d")!;
    let x = 0;
    bitmaps.forEach((b, i) => {
      ctx.drawImage(b, x, 0, widths[i], h);
      x += widths[i];
      b.close();
    });
    // ナビゲーター枠自体を合成画像のアスペクト比に合わせる（矩形計算を正確にするため）。
    const maxSize = 270;
    const ratio = canvas.width / canvas.height || 1;
    const navW = ratio >= 1 ? maxSize : maxSize * ratio;
    const navH = ratio >= 1 ? maxSize / ratio : maxSize;
    navigatorEl.style.width = `${navW}px`;
    navigatorEl.style.height = `${navH}px`;
    // toDataURL（同期エンコード）はメインスレッドを塞ぐため、非同期の toBlob を使う。
    canvas.toBlob(
      (blob) => {
        if (!blob || key !== navThumbKey) return;
        const url = URL.createObjectURL(blob);
        const old = navThumb.src;
        navThumb.onload = () => {
          if (old.startsWith("blob:")) URL.revokeObjectURL(old);
          updateNavigatorViewportRect();
        };
        navThumb.src = url;
      },
      "image/jpeg",
      0.85
    );
    updateNavigatorViewportRect();
  } catch (e) {
    console.error("ナビゲーター用サムネイル取得失敗:", e);
  }
}

// ナビゲーター上のクリック/ドラッグで、その位置へ表示範囲を移動する。
function jumpNavigatorTo(clientX: number, clientY: number) {
  const rect = navigatorEl.getBoundingClientRect();
  const nx = clampNum(clientX - rect.left, 0, rect.width) / rect.width;
  const ny = clampNum(clientY - rect.top, 0, rect.height) / rect.height;
  // クリックした画像上の位置(nx*dispW, ny*dispH)が画面中央に来るようにパンする。
  panX = dispW / 2 - nx * dispW;
  panY = dispH / 2 - ny * dispH;
  finishLayout();
}

let navDragging = false;
navigatorEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  navDragging = true;
  jumpNavigatorTo(e.clientX, e.clientY);
});
window.addEventListener("mousemove", (e) => {
  if (navDragging) jumpNavigatorTo(e.clientX, e.clientY);
});
window.addEventListener("mouseup", () => {
  navDragging = false;
});

zoomResetBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  zoomResetAction();
});

// 「全体に合わせる」＝フィットモードを contain に切替（ズーム・パンもリセットされる）。
document.querySelector<HTMLButtonElement>("#nav-fit-btn")!.addEventListener("click", (e) => {
  e.stopPropagation();
  setFitMode("contain");
});

// 「ナビを隠す」＝押している間だけナビゲーター一式を透明にして背面の画像を見せる。
const navHideBtn = document.querySelector<HTMLButtonElement>("#nav-hide-btn")!;
navHideBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  navigatorPanel.classList.add("peek");
});
window.addEventListener("mouseup", () => {
  navigatorPanel.classList.remove("peek");
});

// ---- 表示レイアウト（回転・フィットモード・見開きに応じて px サイズを計算) ----
// 重要：spreadMode（ユーザー設定）ではなく「実際に見開きが画面に出ているか」で分岐する。
// 見開きモード中でも表紙・横長・GIFは単ページ表示にフォールバックするため、設定で
// 分岐すると、その間のリサイズ／フィット変更が非表示の見開き側だけ再計算して
// 表示中の単ページ画像を古いサイズのまま放置してしまう。
function applyLayout() {
  if (!spread.classList.contains("hidden")) applyLayoutSpread();
  else applyLayoutSingle();
}

function applyLayoutSingle() {
  if (!natW || !natH) return;
  const swapped = rotation % 180 !== 0; // 90/270度では見た目上の縦横が入れ替わる
  const box = targetBoxFor(natW, natH); // 回転前の実ピクセルサイズ（= imgに指定するサイズ）
  setStyleIfChanged(img, "width", `${box.w}px`);
  setStyleIfChanged(img, "height", `${box.h}px`);

  // dispW/dispH はパン範囲計算用の「回転後(見た目)の表示サイズ」。
  dispW = swapped ? box.h : box.w;
  dispH = swapped ? box.w : box.h;
  finishLayout();
}

// 見開き（2ページ）のレイアウト。両ページを同じ高さで揃えて並べる
// （ただし原寸表示だけは各ページ本来の実寸を優先し、高さは揃えない）。
// 見開き2ページ分の目標表示サイズ（回転前の実ピクセル数）を求める。
// 原寸表示以外は両ページの高さを揃え、幅はアスペクト比から算出する。
function spreadBoxesFor(
  dLeft: { w: number; h: number },
  dRight: { w: number; h: number }
): { left: { w: number; h: number }; right: { w: number; h: number } } {
  const vw = viewer.clientWidth || 1;
  const vh = viewer.clientHeight || 1;
  const swapped = rotation % 180 !== 0;
  const effL = swapped ? { w: dLeft.h, h: dLeft.w } : dLeft;
  const effR = swapped ? { w: dRight.h, h: dRight.w } : dRight;

  let hL: number;
  let hR: number;
  if (fitMode === "original") {
    hL = effL.h;
    hR = effR.h;
  } else {
    const ratioL = effL.w / effL.h;
    const ratioR = effR.w / effR.h;
    const totalWatH1 = ratioL + ratioR; // 両ページの高さを1とした時の合計幅
    let commonH: number;
    if (fitMode === "width") commonH = vw / totalWatH1;
    else if (fitMode === "height") commonH = vh;
    else commonH = Math.min(vh, vw / totalWatH1); // contain
    hL = commonH;
    hR = commonH;
  }
  const wL = hL * (effL.w / effL.h) * zoomFactor;
  const wR = hR * (effR.w / effR.h) * zoomFactor;
  hL *= zoomFactor;
  hR *= zoomFactor;
  const box = (w: number, h: number) => ({
    w: Math.max(1, Math.round(swapped ? h : w)),
    h: Math.max(1, Math.round(swapped ? w : h)),
  });
  // wL・wRをそれぞれ独立に四捨五入すると、合計（dispW）が実際の値より
  // 最大1px大きくなり得る（単ページの丸め誤差0.5pxの2倍）。これにより
  // 「全体に合わせる」でぴったり収まっているのに canPan() が誤って true を
  // 返し、ナビゲーターが表示されたままになる不具合があった。右ページの
  // 丸めを左ページの誤差ぶん調整し、合計の丸め誤差を単ページ時と同じ
  // 0.5px以内に収める。
  const wLRounded = Math.round(wL);
  const wRRounded = Math.round(wL + wR) - wLRounded;
  return { left: box(wLRounded, hL), right: box(wRRounded, hR) };
}

function applyLayoutSpread() {
  if (!spreadDims) return;
  const [dLeft, dRight] = spreadDims; // 表示順（左, 右）
  const swapped = rotation % 180 !== 0;
  const { left, right } = spreadBoxesFor(dLeft, dRight);

  const setImgBox = (el: HTMLImageElement, box: { w: number; h: number }) => {
    setStyleIfChanged(el, "width", `${box.w}px`);
    setStyleIfChanged(el, "height", `${box.h}px`);
    setStyleIfChanged(el, "transform", rotation ? `rotate(${rotation}deg)` : "");
  };
  setImgBox(pageLeftEl, left);
  setImgBox(pageRightEl, right);

  // dispW/dispHは「回転後(見た目)の表示サイズ」（パン範囲計算用）。
  const postL = swapped ? { w: left.h, h: left.w } : left;
  const postR = swapped ? { w: right.h, h: right.w } : right;
  dispW = postL.w + postR.w;
  dispH = Math.max(postL.h, postR.h);
  finishLayout();
}

// レイアウト計算直後に、次の描画フレームでもう一度計算し直す。
// ウィンドウのサイズ確定と描画タイミングがずれると、viewer.clientWidth/Height を
// 一瞬古い値で読んでしまい「全体表示のはずが黒枠が残る」ことがあるための保険。
function applyLayoutSettled() {
  applyLayout();
  requestAnimationFrame(() => applyLayout());
}

// 注：img の "load" イベントでも natW/natH 更新＋再レイアウトを行っていたが、
// renderSingle() 内の decode() 後の処理と重複するうえ、こちらにはページ切替の
// ガード（idx/gen チェック）が無く、素早いページ送り時に古い寸法で上書きして
// 表示倍率がずれることがあったため削除した（renderSingle 側の処理のみで足りる）。
window.addEventListener("resize", applyLayoutSettled);

// ---- 表示 ----
// 見開き時、実際に画面へ表示しているページ数（1 または 2）。
// サイドボタン／◀▶ は常にこの値に関係なく「1ページだけ」動く(go)。
// ホイール／クリックは、この値の分だけ動く(turnPage)＝見開き単位で読み進む。
let shownCount = 1;
// 単ページ表示（見開きから横長画像等でフォールバックした場合も含む）。
async function renderSingle() {
  const idx = current;
  const gen = archiveGen;
  spread.classList.add("hidden");
  // ズーム倍率はページ移動では維持する（表示位置のみ中央へ戻す）。
  panX = 0;
  panY = 0;
  try {
    const url = await getPageUrl(idx); // 原寸バイト列を取得し、拡縮はブラウザ(GPU)に任せる（軽快）
    if (idx !== current || gen !== archiveGen) return; // 表示待ちの間にめくられた／別アーカイブに切替わった場合は破棄
    img.src = url;
    // decode() でデコード完了を確実に待つ（img.complete の同期チェックは、要素を
    // 使い回している都合上、前の画像の寸法を読んでしまう競合が起き得るため使わない）。
    // decode() はメモリ逼迫時など失敗することがある（Chromiumの既知挙動）。その場合も
    // load 完了まで待てば naturalWidth は取得できるため、失敗時は load を待つ。
    // ここを怠ると寸法0でレイアウトがスキップされ、前ページのサイズのまま表示される。
    try {
      await img.decode();
    } catch {
      if (!img.complete || !img.naturalWidth) {
        await new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
          if (img.complete) resolve(); // リスナー登録前に完了していた場合の保険
        });
      }
    }
    if (idx !== current || gen !== archiveGen) return; // デコード待ちの間に切り替わった場合は破棄
    if (!img.naturalWidth || !img.naturalHeight) {
      console.error("画像寸法を取得できませんでした:", idx);
      return; // 寸法0のままレイアウトすると崩れるため中断
    }
    img.classList.add("loaded");
    natW = img.naturalWidth;
    natH = img.naturalHeight;
    applyLayoutSettled();
    shownCount = 1;
    counter.textContent = `${current + 1} / ${pageCount}`;
    seek.value = String(current);
    flashBar();
    prefetch();
    updateNavigatorThumb();
    updateBookmarkBtnUi();
  } catch (e) {
    console.error("ページ取得失敗:", e);
  }
}

// 見開き表示：常に「現在ページ＋次のページ」を組む（固定の偶奇組ではない）。
// これにより、サイドボタン／◀▶ で current を1つ動かすと組がそのまま1ページ分スライドする
// ＝見開きのズレ補正ができる。表紙(0ページ目)・最終ページ余り・横長画像は単独表示にする。
async function renderSpread() {
  const idx = current;
  const gen = archiveGen;
  if (idx === 0 || idx + 1 >= pageCount) {
    await renderSingle();
    return;
  }
  let a: { w: number; h: number; animated: boolean };
  let b: { w: number; h: number; animated: boolean };
  try {
    [a, b] = await Promise.all([getImageDims(idx), getImageDims(idx + 1)]);
  } catch {
    // 先読み等とのアーカイブ同時アクセスで一時的に失敗することがあるため、
    // 即座に単ページへフォールバックせず1回だけリトライする
    // （安易にフォールバックすると「ふいに単ページになる」ように見える）。
    try {
      [a, b] = await Promise.all([getImageDims(idx), getImageDims(idx + 1)]);
    } catch (e) {
      console.error("ページ寸法取得失敗:", e);
      await renderSingle();
      return;
    }
  }
  if (idx !== current || gen !== archiveGen) return;
  if (a.w > a.h || b.w > b.h || a.animated || b.animated) {
    // 横長画像・GIFアニメーションは見開きに混ぜず単独表示（ズレ防止／自動再生のため）。
    await renderSingle();
    return;
  }

  // ズーム倍率はページ移動では維持する（表示位置のみ中央へ戻す）。
  panX = 0;
  panY = 0;
  try {
    // rtl（右綴じ）：右＝若いページ（先に読む）、左＝次のページ。ltrはその逆。
    const dLeft = bindMode === "rtl" ? b : a;
    const dRight = bindMode === "rtl" ? a : b;
    const idxLeft = bindMode === "rtl" ? idx + 1 : idx;
    const idxRight = bindMode === "rtl" ? idx : idx + 1;
    const [leftUrl, rightUrl] = await Promise.all([
      getPageUrl(idxLeft),
      getPageUrl(idxRight),
    ]);
    if (idx !== current || gen !== archiveGen) return;
    spreadDims = [dLeft, dRight];
    pageLeftEl.src = leftUrl;
    pageRightEl.src = rightUrl;
    img.classList.remove("loaded");
    spread.classList.remove("hidden");
    applyLayoutSettled();
    shownCount = 2;
    counter.textContent = `${idx + 1}-${idx + 2} / ${pageCount}`;
    seek.value = String(idx);
    flashBar();
    prefetch();
    updateNavigatorThumb();
    updateBookmarkBtnUi();
  } catch (e) {
    console.error("見開きページ取得失敗:", e);
  }
}

async function render() {
  if (pageCount === 0) return;
  if (spreadMode) await renderSpread();
  else await renderSingle();
}

function go(delta: number) {
  if (pageCount === 0) return;
  const next = current + delta;
  if (next < 0) {
    handleStartReached();
    return;
  }
  if (next >= pageCount) {
    handleEndReached(1);
    return;
  }
  current = next;
  schedulePositionSave();
  render();
}

// 見開き単位で読み進む／戻る（単ページ時は go と同じ）。
// 見開き時は「今実際に表示している枚数(shownCount)」の分だけ current を動かす。
function turnPage(dir: 1 | -1) {
  if (pageCount === 0) return;
  if (!spreadMode) {
    go(dir);
    return;
  }
  const step = shownCount || 1;
  let next = current + dir * step;
  // 見開き(1,2)から2ページ戻ると -1 になるが、表紙(0)をまだ見ていないので
  // 前の巻へ遡らず表紙に着地させる（表紙飛ばし防止）。
  if (dir < 0 && next < 0 && current > 0) next = 0;
  if (next >= pageCount) {
    handleEndReached(dir);
    return;
  }
  if (next < 0) {
    handleStartReached();
    return;
  }
  if (next === current) return;
  current = next;
  schedulePositionSave();
  render();
}

function jump(index: number) {
  if (pageCount === 0) return;
  current = Math.max(0, Math.min(pageCount - 1, index));
  schedulePositionSave();
  render();
}

// 最終ページを超えて「次へ」しようとした時の挙動（巻末設定）。
function handleEndReached(dir: number) {
  if (dir < 0) return;
  if (endBehavior === "loop") {
    current = 0;
    schedulePositionSave();
    render();
  } else {
    goNextVolume();
  }
}

// 先頭ページより前へ「戻る」しようとした時の挙動：前の巻があれば、
// その最終ページへ移動する（遡って読み続けられるように）。無ければ何もしない。
function handleStartReached() {
  goVolume(-1, true);
}

// ---- 履歴（巻ごとの位置記憶）----
// ページ変更のたびに毎回保存すると重いので、少し間を置いてからまとめて保存する。
function schedulePositionSave() {
  if (!currentAnchor) return;
  window.clearTimeout(saveTimer);
  const anchor = currentAnchor;
  const page = current;
  saveTimer = window.setTimeout(() => {
    invoke("save_position", { anchor, page }).catch(() => {});
  }, 500);
}

// ウインドウタイトルに現在読み込んでいるファイル（アーカイブ/フォルダ）名を表示する。
function updateWindowTitle() {
  const title = currentAnchor ? `MameViewer - ${basenameOf(currentAnchor)}` : "MameViewer";
  getCurrentWindow()
    .setTitle(title)
    .catch(() => {}); // タイトル設定に失敗しても表示には影響しないため無視
}

// ---- フォルダツリーサイドパネル ----
// 現在開いているファイル／フォルダの親フォルダを起点に、都度切り替わる。
// 「上へ」ボタンで階層を遡れる。フォルダはクリックで遅延展開、
// アーカイブ・画像ファイルはクリックでそのまま開く。
interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  kind: "folder" | "archive" | "image" | "other";
  mtime: number; // 更新日時（UNIXエポック秒）
  size: number; // バイト数（フォルダは0）
}

type TreeSortKey = "name" | "date" | "kind" | "size";

const treePanel = document.querySelector<HTMLDivElement>("#tree-panel")!;
const treeUpBtn = document.querySelector<HTMLButtonElement>("#tree-up-btn")!;
const treeLocateBtn = document.querySelector<HTMLButtonElement>("#tree-locate-btn")!;
const treeRootPathEl = document.querySelector<HTMLSpanElement>("#tree-root-path")!;
const treeScrollEl = document.querySelector<HTMLDivElement>("#tree-scroll")!;

const TREE_ICONS: Record<string, string> = {
  folder: "📁",
  archive: "🗜️",
  image: "🖼️",
  other: "📄",
};

let treeRootDir: string | null = null;
let treeHighlightPath: string | null = null;
const treeExpanded = new Set<string>();

// 並び替え設定（次回起動時も維持）。
let treeSortKey: TreeSortKey = (localStorage.getItem("treeSortKey") as TreeSortKey | null) || "name";
let treeSortAsc = localStorage.getItem("treeSortAsc") !== "false";

// 種類の並び順（フォルダ→アーカイブ→画像→その他）。
const KIND_ORDER: Record<string, number> = { folder: 0, archive: 1, image: 2, other: 3 };

// 表示用に並び替えた配列を返す（元の配列は壊さない）。
// フォルダは常に先頭にまとめ、その中で選択中のキーで並べる
// （エクスプローラー等と同じく、フォルダとファイルが混ざらない方が探しやすいため）。
function sortedTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const dir = treeSortAsc ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    switch (treeSortKey) {
      case "date":
        cmp = a.mtime - b.mtime;
        break;
      case "size":
        cmp = a.size - b.size;
        break;
      case "kind":
        cmp = (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9);
        break;
    }
    // 名前順、または上記キーが同値だった場合は名前で決着させる。
    if (cmp === 0) return a.name.localeCompare(b.name, "ja", { numeric: true }) * dir;
    return cmp * dir;
  });
}
const treeChildrenCache = new Map<string, TreeEntry[]>();

async function fetchTreeDir(path: string): Promise<TreeEntry[]> {
  const cached = treeChildrenCache.get(path);
  if (cached) return cached;
  try {
    const entries = await invoke<TreeEntry[]>("list_tree_dir", { path });
    treeChildrenCache.set(path, entries);
    return entries;
  } catch (e) {
    console.error("フォルダ一覧取得失敗:", e);
    treeChildrenCache.set(path, []); // 失敗時は空扱いにして無限リトライを避ける
    return [];
  }
}

function buildTreeLevel(entries: TreeEntry[]): HTMLElement {
  const container = document.createElement("div");
  for (const entry of sortedTreeEntries(entries)) {
    const node = document.createElement("div");
    node.className = "tree-node";

    const row = document.createElement("div");
    row.className = "tree-row" + (entry.path === treeHighlightPath ? " current" : "");
    row.title = entry.path;

    const toggle = document.createElement("span");
    toggle.className = "tree-toggle";
    toggle.textContent = entry.isDir ? (treeExpanded.has(entry.path) ? "▼" : "▶") : "";

    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = TREE_ICONS[entry.isDir ? "folder" : entry.kind] ?? "📄";

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = entry.name;

    row.append(toggle, icon, name);
    row.addEventListener("click", () => {
      if (entry.isDir) toggleTreeNode(entry.path);
      else if (entry.kind === "archive" || entry.kind === "image") openPath(entry.path);
    });
    node.appendChild(row);

    if (entry.isDir && treeExpanded.has(entry.path)) {
      const childrenWrap = document.createElement("div");
      childrenWrap.className = "tree-children";
      const cached = treeChildrenCache.get(entry.path);
      if (cached) {
        childrenWrap.appendChild(buildTreeLevel(cached));
      } else {
        const loading = document.createElement("p");
        loading.textContent = "読み込み中…";
        loading.style.cssText = "padding:3px 8px;color:#888;";
        childrenWrap.appendChild(loading);
      }
      node.appendChild(childrenWrap);
    }
    container.appendChild(node);
  }
  return container;
}

function renderTree() {
  treeScrollEl.innerHTML = "";
  if (!treeRootDir) return;
  const rootEntries = treeChildrenCache.get(treeRootDir);
  if (!rootEntries) {
    const loading = document.createElement("p");
    loading.textContent = "読み込み中…";
    loading.style.cssText = "padding:8px 12px;color:#888;";
    treeScrollEl.appendChild(loading);
    return;
  }
  treeScrollEl.appendChild(buildTreeLevel(rootEntries));
}

async function toggleTreeNode(path: string) {
  if (treeExpanded.has(path)) {
    treeExpanded.delete(path);
    renderTree();
    return;
  }
  treeExpanded.add(path);
  renderTree(); // 展開直後（読み込み中）の状態を即座に見せる
  await fetchTreeDir(path);
  renderTree();
}

// ツリーの表示起点を切り替える。highlightPathを指定すると、その項目を強調表示する。
async function setTreeRoot(dir: string, highlightPath: string | null) {
  treeRootDir = dir;
  treeHighlightPath = highlightPath;
  treeRootPathEl.textContent = dir;
  treeRootPathEl.title = dir;
  renderTree(); // 読み込み中表示を即座に見せる
  await fetchTreeDir(dir);
  const parent = await invoke<string | null>("get_parent_dir", { path: dir }).catch(() => null);
  treeUpBtn.disabled = !parent;
  renderTree();
}

// 開いたファイル／フォルダ（アンカー）に応じてツリーの起点を更新する。
// アンカー自身の親フォルダを起点にし、アンカー自身をハイライトする。
async function setTreeRootForAnchor(anchor: string) {
  const parent = await invoke<string | null>("get_parent_dir", { path: anchor }).catch(() => null);
  await setTreeRoot(parent ?? anchor, anchor);
}

async function goTreeUp() {
  if (!treeRootDir) return;
  const parent = await invoke<string | null>("get_parent_dir", { path: treeRootDir }).catch(() => null);
  if (parent) await setTreeRoot(parent, treeHighlightPath);
}

treeUpBtn.addEventListener("click", goTreeUp);

// 現在見ているファイル／フォルダの位置へ、ツリーの起点を戻す。
treeLocateBtn.addEventListener("click", () => {
  if (currentAnchor) setTreeRootForAnchor(currentAnchor);
});

// フォルダツリーパネルの表示/非表示を切り替える。
document.querySelector<HTMLButtonElement>("#tree-toggle-btn")?.addEventListener("click", () => {
  treePanel.classList.toggle("hidden");
});

// ---- ツリーの並び替え ----
// 選択中のキーは強調表示し、昇順／降順を矢印で示す。
function updateTreeSortUi() {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#tree-sortbar button")) {
    const key = b.dataset.sort as TreeSortKey;
    const active = key === treeSortKey;
    b.classList.toggle("active", active);
    const label = b.dataset.label ?? (b.dataset.label = b.textContent ?? "");
    b.textContent = active ? `${label}${treeSortAsc ? "▲" : "▼"}` : label;
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>("#tree-sortbar button")) {
  b.addEventListener("click", () => {
    const key = b.dataset.sort as TreeSortKey;
    // 同じキーを再度押した場合は昇順／降順を反転、別のキーなら昇順から。
    if (key === treeSortKey) treeSortAsc = !treeSortAsc;
    else {
      treeSortKey = key;
      treeSortAsc = true;
    }
    localStorage.setItem("treeSortKey", treeSortKey);
    localStorage.setItem("treeSortAsc", String(treeSortAsc));
    updateTreeSortUi();
    renderTree();
  });
}
updateTreeSortUi();

// ---- アーカイブを開く ----
// reset=true の場合、記憶されている位置を無視して先頭ページから開く（「最初から読む」用）。
async function openArchive(path: string, reset = false) {
  stopProgressPolling(); // 前のファイルの進捗表示が残らないようにする
  resumeDialog.classList.add("hidden"); // 再開確認ダイアログが出ていても、新規に開く操作を優先する
  try {
    const res = await invoke<{ count: number; initialIndex: number }>("open_archive", {
      path,
      reset,
    });
    archiveGen++;
    resetPageCache();
    pageCount = res.count;
    current = res.initialIndex;
    currentAnchor = path;
    updateWindowTitle();
    if (shelfOpen) updateShelfAddBtnUi(); // 別の本を開いたら追加/削除の表示を切り替える
    loadBookmarkedPages(); // この本のしおり位置をまとめて取得（以後はIPCなしで判定）
    setTreeRootForAnchor(path);
    hint.style.display = "none";
    seek.disabled = false;
    seek.max = String(pageCount - 1);
    if (gridOpen) closeGrid();
    startProgressPolling();
    await render();
  } catch (e) {
    alert("開けませんでした: " + e);
  }
}

// ---- 単独の画像ファイル／フォルダを開く ----
// 画像ファイルなら、その親フォルダの画像を一覧化してその位置から表示する。
// フォルダなら、その中の画像を先頭から表示する。サブフォルダがあれば、
// 含めて読み込むかを確認する。reset=true の場合は先頭ページから開く。
async function openImageOrFolder(path: string, reset = false) {
  stopProgressPolling(); // 前のファイルの進捗表示が残らないようにする
  resumeDialog.classList.add("hidden"); // 再開確認ダイアログが出ていても、新規に開く操作を優先する
  try {
    const hasSubs = await invoke<boolean>("has_subfolders", { path });
    let recursive = false;
    if (hasSubs) {
      recursive = await ask(
        "このフォルダには下層フォルダがあります。中の画像も読み込みますか？",
        { title: "MameViewer", kind: "info" }
      );
    }
    const res = await invoke<{ count: number; initialIndex: number; dir: string }>(
      "open_folder",
      { path, recursive, reset }
    );
    archiveGen++;
    resetPageCache();
    pageCount = res.count;
    current = res.initialIndex;
    currentAnchor = res.dir;
    updateWindowTitle();
    if (shelfOpen) updateShelfAddBtnUi(); // 別の本を開いたら追加/削除の表示を切り替える
    loadBookmarkedPages(); // この本のしおり位置をまとめて取得（以後はIPCなしで判定）
    setTreeRootForAnchor(res.dir);
    hint.style.display = "none";
    seek.disabled = false;
    seek.max = String(pageCount - 1);
    if (gridOpen) closeGrid();
    startProgressPolling();
    await render();
  } catch (e) {
    alert("開けませんでした: " + e);
  }
}

// 拡張子からアーカイブ／画像・フォルダのどちらの開き方をすべきか振り分ける。
async function openPath(path: string) {
  const ext = extOf(path);
  if (ARCHIVE_EXTS.includes(ext)) {
    await openArchive(path);
  } else {
    await openImageOrFolder(path);
  }
}

// ---- 巻移動 ----
// 現在の巻(currentAnchor)と同じフォルダにある他の巻（アーカイブファイル／
// サブフォルダ）を自然順で前後に辿る。端に達していれば何もしない。
// landAtEnd=true の場合、移動先の巻を開いた後に最終ページへジャンプする
// （ページ末端に達したことで自動的に前の巻へ遡る場合に、続きから自然に読めるように）。
async function goVolume(dir: 1 | -1, landAtEnd = false) {
  if (!currentAnchor) return;
  try {
    const volumes = await invoke<string[]>("list_volumes", { anchor: currentAnchor });
    const idx = volumes.indexOf(currentAnchor);
    if (idx < 0) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= volumes.length) return;
    await openPath(volumes[nextIdx]);
    if (landAtEnd && pageCount > 0) {
      current = pageCount - 1;
      schedulePositionSave();
      render();
    }
  } catch (e) {
    console.error("巻移動に失敗:", e);
  }
}

function goNextVolume() {
  goVolume(1);
}
function goPrevVolume() {
  goVolume(-1);
}

async function pickFile() {
  const selected = await openDialog({
    multiple: false,
    filters: [
      {
        name: "アーカイブ・画像",
        extensions: [...ARCHIVE_EXTS, ...IMAGE_EXTS],
      },
    ],
  });
  if (typeof selected === "string") openPath(selected);
}

async function pickFolder() {
  const selected = await openDialog({ directory: true, multiple: false });
  if (typeof selected === "string") openImageOrFolder(selected);
}

// ---- 下部バー表示制御 ----
function flashBar() {
  bar.classList.add("show");
  window.clearTimeout(barTimer);
  barTimer = window.setTimeout(() => {
    bar.classList.remove("show");
  }, 1400);
}

// 上部バーは常時表示のため、下部バーのような自動開閉の制御は持たない。

// ---- メニュー（≡：ファイル操作・しおり・巻末挙動・キャッシュ設定） ----
// メニューの右端を、開くきっかけになったボタンの右端に揃えて表示する
// （画面端に固定していると、ボタンとメニューの位置関係が不自然に見えるため）。
// ボタンは上部バーにあるので、バーの直下から下向きに開く。
function positionMenuAboveButton(menuEl: HTMLElement, btn: HTMLElement) {
  const btnRect = btn.getBoundingClientRect();
  const barRect = topbar.getBoundingClientRect();
  // メニューは #viewer の子（position:absolute の基準が #viewer）。上部バーは
  // #viewer の外にあるため、ビューポート座標から #viewer の位置を引いて換算する。
  const viewerRect = viewer.getBoundingClientRect();
  menuEl.style.right = "auto";
  menuEl.style.bottom = "auto";
  menuEl.style.top = `${Math.max(4, barRect.bottom - viewerRect.top + 4)}px`;
  // メニューの左端をボタンの左端に合わせる。ただし画面右端からはみ出す場合は
  // 内側へ寄せる（ボタンが右端にある場合でも見切れないように）。
  // hidden を外した後に呼ぶ前提なので offsetWidth で実寸を測れる。
  const maxLeft = Math.max(4, viewerRect.width - menuEl.offsetWidth - 4);
  const left = Math.min(Math.max(4, btnRect.left - viewerRect.left), maxLeft);
  menuEl.style.left = `${left}px`;
}

function toggleMenu(force?: boolean) {
  const willShow = force ?? menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willShow);
  if (willShow) {
    toggleDisplayMenu(false); // 片方を開いたらもう片方は閉じる
    toggleSettingsMenu(false);
    const btn = document.querySelector<HTMLButtonElement>("#menu-btn")!;
    positionMenuAboveButton(menu, btn);
  }
}

function toggleSettingsMenu(force?: boolean) {
  const willShow = force ?? settingsMenu.classList.contains("hidden");
  settingsMenu.classList.toggle("hidden", !willShow);
  if (willShow) {
    toggleMenu(false); // 片方を開いたらもう片方は閉じる
    toggleDisplayMenu(false);
    const btn = document.querySelector<HTMLButtonElement>("#settings-menu-btn")!;
    positionMenuAboveButton(settingsMenu, btn);
    updateCacheUsageUi(); // 隠れている間は更新を省いているので、開いた時に反映する
  }
}

document
  .querySelector("#settings-menu-btn")
  ?.addEventListener("click", () => toggleSettingsMenu());

settingsMenu.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const act = target.dataset.act;
  if (!act) return; // キャッシュ設定のラジオ等はここで閉じない
  if (act === "help") openHelp();
  else if (act === "keybind") openKeybind();
  else if (act === "about") openAbout();
  toggleSettingsMenu(false);
});

menu.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const act = target.dataset.act;
  const end = target.dataset.end;
  if (end) {
    setEndBehavior(end as "loop" | "next");
    return;
  }
  if (!act) return;
  if (act === "open") pickFile();
  else if (act === "openFolder") pickFolder();
  else if (act === "grid") openGrid();
  else if (act === "first") jump(0);
  else if (act === "last") jump(pageCount - 1);
  else if (act === "bookmarkToggle") toggleBookmark();
  else if (act === "bookmarkList") openBookmarks();
  toggleMenu(false);
});

// ---- 説明書パネル ----
let helpOpen = false;
const helpEl = document.querySelector<HTMLDivElement>("#help")!;
const helpKbRows = document.querySelector<HTMLTableSectionElement>("#help-kb-rows")!;

// 説明書の「キーボード」表を現在のキー割り当てから組み立てる（変更すると即反映される）。
function renderHelpKeyboardTable() {
  helpKbRows.innerHTML = "";
  for (const id of ACTION_ORDER) {
    const tr = document.createElement("tr");
    const tdKey = document.createElement("td");
    tdKey.textContent = formatKeyLabel(keymap[id]);
    const tdLabel = document.createElement("td");
    tdLabel.textContent = ACTION_LABELS[id];
    tr.append(tdKey, tdLabel);
    helpKbRows.appendChild(tr);
  }
}

function openHelp() {
  helpOpen = true;
  renderHelpKeyboardTable();
  helpEl.classList.remove("hidden");
}

function closeHelp() {
  helpOpen = false;
  helpEl.classList.add("hidden");
}

document.querySelector("#help-close")?.addEventListener("click", closeHelp);

// ---- キー割り当て変更パネル ----
let keybindOpen = false;
let awaitingRebind: ActionId | null = null;
const keybindEl = document.querySelector<HTMLDivElement>("#keybind")!;
const keybindTable = document.querySelector<HTMLTableElement>("#keybind-table")!;

function renderKeybindTable() {
  keybindTable.innerHTML = "";
  for (const id of ACTION_ORDER) {
    const tr = document.createElement("tr");
    const tdLabel = document.createElement("td");
    tdLabel.textContent = ACTION_LABELS[id];

    const tdKey = document.createElement("td");
    const keyBadge = document.createElement("span");
    const b = keymap[id];
    keyBadge.className = "keybind-key" + (b.key ? "" : " unset");
    const waiting = awaitingRebind === id;
    keyBadge.textContent = waiting ? "キーを押してください…" : formatKeyLabel(b);

    const changeBtn = document.createElement("button");
    changeBtn.className = "keybind-change-btn" + (waiting ? " waiting" : "");
    changeBtn.textContent = waiting ? "キャンセル" : "変更";
    changeBtn.addEventListener("click", () => {
      awaitingRebind = awaitingRebind === id ? null : id; // もう一度押すとキャンセル
      renderKeybindTable();
    });

    tdKey.append(keyBadge, changeBtn);
    tr.append(tdLabel, tdKey);
    keybindTable.appendChild(tr);
  }
}

function openKeybind() {
  keybindOpen = true;
  awaitingRebind = null;
  renderKeybindTable();
  keybindEl.classList.remove("hidden");
}

function closeKeybind() {
  keybindOpen = false;
  awaitingRebind = null;
  keybindEl.classList.add("hidden");
}

document.querySelector("#keybind-close")?.addEventListener("click", closeKeybind);

// ---- このアプリについてパネル ----
let aboutOpen = false;
const aboutEl = document.querySelector<HTMLDivElement>("#about")!;

function openAbout() {
  aboutOpen = true;
  aboutEl.classList.remove("hidden");
}

function closeAbout() {
  aboutOpen = false;
  aboutEl.classList.add("hidden");
}

document.querySelector("#about-close")?.addEventListener("click", closeAbout);
document.querySelector("#keybind-reset")?.addEventListener("click", () => {
  keymap = { ...DEFAULT_KEYMAP };
  saveKeymap();
  awaitingRebind = null;
  renderKeybindTable();
});

// 新しいキーをactionへ割り当てる。既に他のactionに同じキーが割り当て済みなら、
// そちらは未設定にする（1つのキーが複数の操作を同時に発火させないように）。
function assignKey(action: ActionId, binding: KeyBinding) {
  for (const id of ACTION_ORDER) {
    const other = keymap[id];
    if (
      id !== action &&
      other.key &&
      other.key.toLowerCase() === binding.key.toLowerCase() &&
      !!other.ctrl === !!binding.ctrl
    ) {
      keymap[id] = { key: "" };
    }
  }
  keymap[action] = binding;
  saveKeymap();
}

// ---- 表示設定メニュー（見開き・回転・フィット） ----
function toggleDisplayMenu(force?: boolean) {
  const willShow = force ?? displayMenu.classList.contains("hidden");
  displayMenu.classList.toggle("hidden", !willShow);
  if (willShow) {
    toggleMenu(false); // 片方を開いたらもう片方は閉じる
    toggleSettingsMenu(false);
    const btn = document.querySelector<HTMLButtonElement>("#display-menu-btn")!;
    positionMenuAboveButton(displayMenu, btn);
  }
}

displayMenu.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const act = target.dataset.act;
  const fit = target.dataset.fit;
  if (fit) {
    setFitMode(fit as FitMode);
    return; // フィット選択はメニューを開いたまま比較しやすくする
  }
  if (!act) return;
  if (act === "rotate") cycleRotation();
  else if (act === "spread") toggleSpread();
});

document
  .querySelector("#display-menu-btn")
  ?.addEventListener("click", () => toggleDisplayMenu());

// ---- 回転・フィットモード・綴じ方向・見開き ----
function cycleRotation() {
  rotation = (rotation + 90) % 360;
  localStorage.setItem("rotation", String(rotation));
  panX = 0;
  panY = 0;
  applyLayoutSettled();
}

function setFitMode(mode: FitMode) {
  fitMode = mode;
  localStorage.setItem("fitMode", mode);
  for (const b of displayMenu.querySelectorAll<HTMLButtonElement>("[data-fit]")) {
    b.classList.toggle("active", b.dataset.fit === mode);
  }
  panX = 0;
  panY = 0;
  resetZoom();
  applyLayoutSettled();
}

// 綴じ方向ボタンの矢印を現在のbindModeに合わせて更新する。
// 矢印はページを読み進める方向（右綴じ＝左へ進む＝◀、左綴じ＝右へ進む＝▶）を示す。
function updateBindUi() {
  const rtl = bindMode === "rtl";
  bindArrow.textContent = rtl ? "◀" : "▶";
  bindToggle.title = `綴じ方向を切り替え（現在：${rtl ? "右綴じ" : "左綴じ"}）`;
}

function toggleBindMode() {
  bindMode = bindMode === "rtl" ? "ltr" : "rtl";
  localStorage.setItem("bindMode", bindMode);
  updateBindUi();
  if (spreadMode) render(); // 見開き時は左右の並びが変わるため再表示
}

function toggleSpread() {
  spreadMode = !spreadMode;
  localStorage.setItem("spreadMode", String(spreadMode));
  for (const b of displayMenu.querySelectorAll<HTMLButtonElement>('[data-act="spread"]')) {
    b.classList.toggle("active", spreadMode);
  }
  panX = 0;
  panY = 0;
  resetZoom();
  render();
}

// 巻末に達した時の挙動（ループ／次の巻へ）を設定・保存する。
function setEndBehavior(mode: "loop" | "next") {
  endBehavior = mode;
  for (const b of menu.querySelectorAll<HTMLButtonElement>("[data-end]")) {
    b.classList.toggle("active", b.dataset.end === mode);
  }
  invoke("set_end_behavior", { mode }).catch(() => {});
}

// 初期状態のハイライトを反映（前回終了時の設定を復元）
setFitMode(fitMode);
updateBindUi();
if (spreadMode) {
  for (const b of displayMenu.querySelectorAll<HTMLButtonElement>('[data-act="spread"]')) {
    b.classList.add("active");
  }
}

// ---- キャッシュ設定（動作の軽快さ／メモリ使用量） ----
function updateCacheUsageUi() {
  // ページを読むたびに呼ばれるが、設定メニューを開いていなければ誰も見ていない。
  // 隠れているDOMへの書き込みを省く（開いた時に必ず呼び直している）。
  if (settingsMenu.classList.contains("hidden")) return;
  const usedMb = currentCacheBytes() / (1024 * 1024);
  const limitMb = cacheLimitBytes / (1024 * 1024);
  const pct = limitMb > 0 ? Math.min(100, (usedMb / limitMb) * 100) : 0;
  cacheUsageFill.style.width = `${pct}%`;
  cacheUsageText.textContent = `${usedMb.toFixed(0)} / ${limitMb.toFixed(0)} MB`;
}

function setCacheLimitMb(mb: number) {
  cacheLimitBytes = mb * 1024 * 1024;
  localStorage.setItem("cacheMb", String(mb));
  evict(); // 縮小した場合は即座に反映
  updateCacheUsageUi();
}

function initCacheSettingsUi() {
  const currentMb = cacheLimitBytes / (1024 * 1024);
  const presetMatch = Array.from(cachePresetRadios).find(
    (r) => r.dataset.mb === String(currentMb)
  );
  if (presetMatch) {
    presetMatch.checked = true;
  } else {
    cacheCustomRadio.checked = true;
    cacheCustomMb.value = String(currentMb);
  }
  cacheCustomMb.value = cacheCustomMb.value || String(currentMb);

  for (const radio of cachePresetRadios) {
    radio.addEventListener("change", () => {
      if (radio.dataset.mb === "custom") {
        setCacheLimitMb(Number(cacheCustomMb.value) || 512);
      } else {
        setCacheLimitMb(Number(radio.dataset.mb));
      }
    });
  }
  cacheCustomMb.addEventListener("change", () => {
    if (cacheCustomRadio.checked) {
      const mb = Math.max(64, Number(cacheCustomMb.value) || 512);
      cacheCustomMb.value = String(mb);
      setCacheLimitMb(mb);
    }
  });
  updateCacheUsageUi();
}
initCacheSettingsUi();

// ---- サムネイル一覧 ----
function setThumbSize(px: number) {
  gridScroll.style.setProperty("--thumb", px + "px");
}

function adjustThumb(delta: number) {
  const min = Number(thumbSize.min);
  const max = Number(thumbSize.max);
  const v = Math.max(min, Math.min(max, Number(thumbSize.value) + delta));
  thumbSize.value = String(v);
  setThumbSize(v);
}

function openGrid() {
  if (pageCount === 0) return;
  gridOpen = true;
  gridGen++;
  buildGrid();
  grid.classList.remove("hidden");
}

function closeGrid() {
  gridOpen = false;
  gridGen++; // 保留中・実行中の生成を無効化
  grid.classList.add("hidden");
  io?.disconnect();
  io = null;
  for (const u of thumbUrls) URL.revokeObjectURL(u);
  thumbUrls = [];
  gridScroll.innerHTML = "";
}

function toggleGrid() {
  if (gridOpen) closeGrid();
  else openGrid();
}

// セルのクリックはここで一括して受ける（セルごとにリスナーを付けない）。
gridScroll.addEventListener("click", (e) => {
  const cell = (e.target as HTMLElement).closest<HTMLElement>(".cell");
  if (!cell || !gridScroll.contains(cell)) return;
  const idx = Number(cell.dataset.idx);
  if (!Number.isFinite(idx)) return;
  jump(idx);
  closeGrid();
});

function buildGrid() {
  gridScroll.innerHTML = "";
  setThumbSize(Number(thumbSize.value));
  io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          const cell = en.target as HTMLElement;
          loadThumb(cell, Number(cell.dataset.idx));
          io!.unobserve(cell);
        }
      }
    },
    { root: gridScroll, rootMargin: "300px" }
  );
  // 数千ページのアーカイブでは要素数が多いので、
  //  ・DocumentFragment にまとめてから1回だけ挿入（都度挿入だとレイアウトが繰り返し走る）
  //  ・クリックは1つの委譲ハンドラで受ける（ページ数分のリスナーを作らない）
  // として、一覧を開いた瞬間に固まらないようにする。
  const frag = document.createDocumentFragment();
  const cells: HTMLElement[] = [];
  for (let i = 0; i < pageCount; i++) {
    const cell = document.createElement("div");
    cell.className = "cell loading" + (i === current ? " current" : "");
    cell.dataset.idx = String(i);
    const no = document.createElement("div");
    no.className = "no";
    no.textContent = String(i + 1);
    cell.appendChild(no);
    frag.appendChild(cell);
    cells.push(cell);
  }
  gridScroll.appendChild(frag);
  for (const cell of cells) io.observe(cell);
  // 現在ページを画面内へ
  requestAnimationFrame(() => {
    gridScroll
      .querySelector(".cell.current")
      ?.scrollIntoView({ block: "center" });
  });
}

async function loadThumb(cell: HTMLElement, idx: number) {
  const gen = gridGen;
  await acquire();
  try {
    if (gen !== gridGen) return; // 一覧が閉じられた／切り替わった
    const buf = await invoke<ArrayBuffer>("get_thumbnail", { index: idx });
    if (gen !== gridGen) return;
    const url = URL.createObjectURL(new Blob([buf]));
    thumbUrls.push(url);
    const el = document.createElement("img");
    el.src = url;
    cell.classList.remove("loading");
    cell.insertBefore(el, cell.firstChild);
  } catch (e) {
    console.error("サムネ生成失敗:", idx, e);
    cell.classList.remove("loading");
  } finally {
    release();
  }
}

// ---- しおり（ブックマーク） ----
type BookmarkView = {
  id: number;
  anchor: string;
  page: number;
  fileName: string;
  thumbBase64: string;
  exists: boolean;
};

let bmScope: "file" | "all" = "file";
let bmOpen = false;
const bookmarksEl = document.querySelector<HTMLDivElement>("#bookmarks")!;
const bookmarksScroll = document.querySelector<HTMLDivElement>("#bookmarks-scroll")!;
const bmClearBrokenBtn = document.querySelector<HTMLButtonElement>("#bm-clear-broken")!;

// 現在のページのしおりを登録／解除する（トグル）。
// しおりボタンの見た目を、現在ページが登録済みかどうかで切り替える
// （どこにしおりを挟んだかが一目で分かるように）。
const bookmarkBtn = document.querySelector<HTMLButtonElement>("#bookmark-btn")!;

// 現在の本のしおりページ番号。ページ送りのたびにRust側へ問い合わせると
// IPC往復がページ数分積み重なるため、本を開いた時に一度だけ取得して保持する。
let bookmarkedPages = new Set<number>();
let bookmarkedAnchor: string | null = null;

async function loadBookmarkedPages() {
  bookmarkedPages = new Set();
  bookmarkedAnchor = currentAnchor;
  if (!currentAnchor) return;
  try {
    const list = await invoke<BookmarkView[]>("list_bookmarks", { anchor: currentAnchor });
    if (bookmarkedAnchor !== currentAnchor) return; // 取得中に別の本へ切り替わった
    for (const b of list) bookmarkedPages.add(b.page);
  } catch (e) {
    console.error("しおり情報の取得に失敗:", e);
  }
  updateBookmarkBtnUi();
}

function updateBookmarkBtnUi() {
  const marked = currentAnchor !== null && pageCount > 0 && bookmarkedPages.has(current);
  bookmarkBtn.classList.toggle("marked", marked);
  bookmarkBtn.title = marked
    ? "このページのしおりを外すのだ (B)"
    : "このページにしおりを挟むのだ (B)";
}

async function toggleBookmark() {
  if (!currentAnchor || pageCount === 0) return;
  try {
    const existingId = await invoke<number | null>("find_bookmark", {
      anchor: currentAnchor,
      page: current,
    });
    if (existingId != null) {
      await invoke("remove_bookmark", { id: existingId });
      bookmarkedPages.delete(current);
    } else {
      await invoke("add_bookmark", { anchor: currentAnchor, page: current });
      bookmarkedPages.add(current);
    }
    if (bmOpen) await buildBookmarksList();
    updateBookmarkBtnUi();
  } catch (e) {
    console.error("しおり操作に失敗:", e);
  }
}

bookmarkBtn.addEventListener("click", toggleBookmark);

// ---- 本棚（本＝ファイル単位のお気に入り） ----
interface ShelfItemView {
  anchor: string;
  fileName: string;
  thumbBase64: string;
  exists: boolean;
}

let shelfOpen = false;
const shelfEl = document.querySelector<HTMLDivElement>("#shelf")!;
const shelfScrollEl = document.querySelector<HTMLDivElement>("#shelf-scroll")!;
const shelfAddBtn = document.querySelector<HTMLButtonElement>("#shelf-add-btn")!;

async function buildShelfList() {
  try {
    const items = await invoke<ShelfItemView[]>("list_shelf");
    shelfScrollEl.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "shelf-empty";
      empty.textContent =
        "本棚は空です。読みたい本を開いて「この本を追加」を押すと、ここに並びます。";
      shelfScrollEl.appendChild(empty);
      return;
    }
    for (const item of items) {
      const cell = document.createElement("div");
      cell.className = "shelf-item" + (item.exists ? "" : " broken");
      cell.title = item.exists ? item.anchor : `${item.anchor}（見つかりません）`;

      const img = document.createElement("img");
      img.src = `data:image/jpeg;base64,${item.thumbBase64}`;
      img.alt = "";
      img.draggable = false;

      const name = document.createElement("div");
      name.className = "shelf-name";
      name.textContent = item.fileName;

      const removeBtn = document.createElement("button");
      removeBtn.className = "shelf-remove";
      removeBtn.textContent = "✕";
      removeBtn.title = "本棚から外す";
      removeBtn.addEventListener("click", async (e) => {
        e.stopPropagation(); // 本を開く動作と競合させない
        await invoke("remove_from_shelf", { anchor: item.anchor }).catch(() => {});
        await buildShelfList();
        updateShelfAddBtnUi();
      });

      if (item.exists) {
        // 本を選んだら棚は閉じる（サムネイル一覧・しおり一覧と同じ挙動。
        // 開いたままだと画面下部が塞がり、パン操作の邪魔になるため）。
        cell.addEventListener("click", () => {
          toggleShelf(false);
          openPath(item.anchor);
        });
      }
      cell.append(img, name, removeBtn);
      shelfScrollEl.appendChild(cell);
    }
  } catch (e) {
    console.error("本棚の読み込みに失敗:", e);
  }
}

// 「この本を追加」ボタンを、現在の本が登録済みかどうかで追加／削除に切り替える。
async function updateShelfAddBtnUi() {
  if (!currentAnchor) {
    shelfAddBtn.disabled = true;
    shelfAddBtn.textContent = "この本を追加";
    shelfAddBtn.classList.remove("remove");
    return;
  }
  shelfAddBtn.disabled = false;
  const inShelf = await invoke<boolean>("is_in_shelf", { anchor: currentAnchor }).catch(
    () => false
  );
  shelfAddBtn.textContent = inShelf ? "この本を本棚から外す" : "この本を追加";
  shelfAddBtn.classList.toggle("remove", inShelf);
}

shelfAddBtn.addEventListener("click", async () => {
  if (!currentAnchor || pageCount === 0) return;
  try {
    const inShelf = await invoke<boolean>("is_in_shelf", { anchor: currentAnchor });
    if (inShelf) {
      await invoke("remove_from_shelf", { anchor: currentAnchor });
    } else {
      // 表紙には現在表示中のページを使う（好きな場面を表紙にできる）。
      await invoke("add_to_shelf", { anchor: currentAnchor, page: current });
    }
    await buildShelfList();
    updateShelfAddBtnUi();
  } catch (e) {
    console.error("本棚の更新に失敗:", e);
  }
});

async function toggleShelf(force?: boolean) {
  shelfOpen = force ?? !shelfOpen;
  shelfEl.classList.toggle("hidden", !shelfOpen);
  if (shelfOpen) {
    bar.classList.add("show"); // 本棚は下部バーの上に出るため、バーも一緒に見せる
    await buildShelfList();
    updateShelfAddBtnUi();
  }
}

document.querySelector<HTMLButtonElement>("#shelf-btn")!.addEventListener("click", () => toggleShelf());
document.querySelector<HTMLButtonElement>("#shelf-close")!.addEventListener("click", () => toggleShelf(false));

async function jumpToBookmark(bm: BookmarkView) {
  closeBookmarks();
  if (bm.anchor !== currentAnchor) {
    await openPath(bm.anchor);
  }
  jump(bm.page);
}

function renderBookmarkCell(bm: BookmarkView): HTMLDivElement {
  const cell = document.createElement("div");
  cell.className = "bm-cell" + (bm.exists ? "" : " broken");

  const img = document.createElement("img");
  img.src = `data:image/jpeg;base64,${bm.thumbBase64}`;
  if (bm.exists) {
    img.title = "クリックでこのページへ";
    img.style.cursor = "pointer";
    img.addEventListener("click", () => jumpToBookmark(bm));
  }
  cell.appendChild(img);

  const info = document.createElement("div");
  info.className = "bm-info";
  const name = document.createElement("span");
  name.className = "bm-name";
  name.textContent = `${bm.fileName}　${bm.page + 1}ページ`;
  info.appendChild(name);
  cell.appendChild(info);

  if (!bm.exists) {
    const warn = document.createElement("div");
    warn.className = "bm-warn";
    warn.textContent = "見つかりません";
    cell.appendChild(warn);
  }

  const actions = document.createElement("div");
  actions.className = "bm-actions";
  const delBtn = document.createElement("button");
  delBtn.className = "bm-delete";
  delBtn.textContent = "削除";
  delBtn.addEventListener("click", async () => {
    await invoke("remove_bookmark", { id: bm.id });
    buildBookmarksList();
    loadBookmarkedPages(); // しおりボタンの点灯状態も同期させる
  });
  actions.appendChild(delBtn);
  cell.appendChild(actions);

  return cell;
}

async function buildBookmarksList() {
  try {
    const list = await invoke<BookmarkView[]>("list_bookmarks", {
      anchor: bmScope === "file" ? currentAnchor : null,
    });
    bookmarksScroll.innerHTML = "";
    for (const bm of list) {
      bookmarksScroll.appendChild(renderBookmarkCell(bm));
    }
    const hasBroken = list.some((b) => !b.exists);
    bmClearBrokenBtn.classList.toggle("hidden", !hasBroken);
  } catch (e) {
    console.error("しおり一覧の取得に失敗:", e);
  }
}

function openBookmarks() {
  bmOpen = true;
  bookmarksEl.classList.remove("hidden");
  buildBookmarksList();
}

function closeBookmarks() {
  bmOpen = false;
  bookmarksEl.classList.add("hidden");
}

function toggleBookmarksPanel() {
  if (bmOpen) closeBookmarks();
  else openBookmarks();
}

document.querySelector("#bookmarks-close")?.addEventListener("click", closeBookmarks);
document.querySelectorAll<HTMLButtonElement>(".bm-scope button").forEach((btn) => {
  btn.addEventListener("click", () => {
    bmScope = btn.dataset.scope as "file" | "all";
    document
      .querySelectorAll<HTMLButtonElement>(".bm-scope button")
      .forEach((b) => b.classList.toggle("active", b === btn));
    buildBookmarksList();
  });
});
bmClearBrokenBtn.addEventListener("click", async () => {
  const list = await invoke<BookmarkView[]>("list_bookmarks", {
    anchor: bmScope === "file" ? currentAnchor : null,
  });
  for (const bm of list) {
    if (!bm.exists) await invoke("remove_bookmark", { id: bm.id });
  }
  buildBookmarksList();
  loadBookmarkedPages(); // しおりボタンの点灯状態も同期させる
});

// ---- 入力 ----
// ホイール：一覧表示中は Ctrl でサイズ変更／それ以外はスクロール。通常時はページめくり。
window.addEventListener(
  "wheel",
  (e) => {
    if (helpOpen || keybindOpen || aboutOpen) return; // パネル表示中は通常のスクロールに任せる
    if (onUi(e)) return; // フォルダツリー等のUI上ではページめくりせず、その要素のスクロールに任せる
    if (gridOpen) {
      if (e.ctrlKey) {
        e.preventDefault();
        adjustThumb(e.deltaY < 0 ? 10 : -10);
      }
      return;
    }
    // S1（サイド奥ボタン）を押しながら、またはCtrlを押しながらのホイールはズーム。
    if (s1Down || e.ctrlKey) {
      e.preventDefault();
      if (s1Down) s1UsedForZoom = true;
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP);
      return;
    }
    // S2（サイド手前ボタン）を押しながらのホイールは巻送り。
    if (s2Down) {
      s2UsedForVolume = true;
      if (e.deltaY > 0) goNextVolume();
      else if (e.deltaY < 0) goPrevVolume();
      return;
    }
    if (e.deltaY > 0) turnPage(1);
    else if (e.deltaY < 0) turnPage(-1);
  },
  { passive: false }
);

// UI領域（バー・メニュー・一覧・案内）上のクリックはページ送りに使わない
function onUi(e: Event): boolean {
  return !!(e.target as HTMLElement).closest(
    "#tree-panel, #shelf, #bar, #topbar, #menu, #display-menu, #settings-menu, #grid, #hint, #bookmarks, #resume-dialog, #help, #keybind, #about"
  );
}

// マウスサイドボタン：S1(戻る/button3)＝前へ、S2(進む/button4)＝次へ
// （S2を押しながらホイールを回すと巻送りになる＝下のwheelハンドラ参照）
window.addEventListener("mousedown", (e) => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
  if (e.button === 3) {
    s1Down = true;
    s1UsedForZoom = false;
  }
  if (e.button === 4) {
    s2Down = true;
    s2UsedForVolume = false;
  }
  // 画像が画面より大きい時、左ボタンドラッグでパン開始（手のひらツール）。
  if (e.button === 0 && !gridOpen && !onUi(e) && canPan()) {
    e.preventDefault();
    panning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOrigX = panX;
    panOrigY = panY;
    viewer.style.cursor = "grabbing";
  }
});
window.addEventListener("mouseup", (e) => {
  if (panning && e.button === 0) {
    panning = false;
    viewer.style.cursor = canPan() ? "grab" : "";
    // 実際に動かした場合は、直後の click によるページめくりを抑止する。
    if (Math.abs(e.clientX - panStartX) > 2 || Math.abs(e.clientY - panStartY) > 2) {
      justPanned = true;
    }
    return;
  }
  if (e.button === 3) {
    s1Down = false;
  }
  if (e.button === 4) {
    s2Down = false;
  }
  if (gridOpen || onUi(e)) return; // フォルダツリー等のUI上ではページ移動を発火させない
  if (e.button === 3) {
    e.preventDefault();
    if (s1UsedForZoom) {
      s1UsedForZoom = false; // ホイールでズームに使った場合は1ページ移動を発火させない
    } else {
      go(-1);
    }
  } else if (e.button === 4) {
    e.preventDefault();
    if (s2UsedForVolume) {
      s2UsedForVolume = false; // ホイールで巻送りに使った場合は1ページ移動を発火させない
    } else {
      go(1);
    }
  }
});

// マウス左ボタン：次へ　右ボタン：前へ
window.addEventListener("click", (e) => {
  if (justPanned) {
    justPanned = false; // パン直後のクリックはページめくりに使わない
    return;
  }
  if (gridOpen || bmOpen || helpOpen || keybindOpen || aboutOpen || onUi(e)) return;
  if (!menu.classList.contains("hidden")) {
    toggleMenu(false); // メニュー表示中の画面クリックは閉じるだけ
    return;
  }
  if (!displayMenu.classList.contains("hidden")) {
    toggleDisplayMenu(false); // 表示設定メニュー表示中の画面クリックは閉じるだけ
    return;
  }
  if (!settingsMenu.classList.contains("hidden")) {
    toggleSettingsMenu(false); // 設定メニュー表示中の画面クリックは閉じるだけ
    return;
  }
  turnPage(1);
});
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (gridOpen || bmOpen || helpOpen || keybindOpen || aboutOpen || onUi(e)) return;
  turnPage(-1);
});

// キーボード
window.addEventListener("keydown", (e) => {
  // キー割り当て変更の「変更」待ち中：次に押されたキーをそのまま割り当てる。
  // Escapeは（システム的な意味を保つため）割り当てず、単に待機をキャンセルする。
  if (awaitingRebind) {
    e.preventDefault();
    const modifiersOnly = ["Control", "Shift", "Alt", "Meta"];
    if (modifiersOnly.includes(e.key)) return; // 修飾キー単体は無視
    if (e.key !== "Escape") {
      assignKey(awaitingRebind, { key: e.key, ctrl: e.ctrlKey });
    }
    awaitingRebind = null;
    renderKeybindTable();
    return;
  }
  // 説明書・キー割り当て・このアプリについてパネル表示中は閉じる操作だけ受け付ける（誤発火防止）。
  if (helpOpen) {
    if (e.key === "Escape" || matchAction(e, "toggleHelp")) closeHelp();
    return;
  }
  if (keybindOpen) {
    if (e.key === "Escape") closeKeybind();
    return;
  }
  if (aboutOpen) {
    if (e.key === "Escape") closeAbout();
    return;
  }
  // 説明書・サムネイル一覧・しおり一覧は、他のパネルが開いていても常に開閉できる。
  if (matchAction(e, "toggleHelp")) {
    e.preventDefault();
    openHelp();
    return;
  }
  if (matchAction(e, "toggleGrid")) {
    e.preventDefault();
    toggleGrid();
    return;
  }
  if (matchAction(e, "bookmarksList")) {
    e.preventDefault();
    toggleBookmarksPanel();
    return;
  }
  if (gridOpen) {
    if (e.key === "Escape") closeGrid();
    return;
  }
  if (bmOpen) {
    if (e.key === "Escape") closeBookmarks();
    return;
  }
  if (e.key === "Escape") {
    toggleMenu(false);
    toggleDisplayMenu(false);
    toggleSettingsMenu(false);
    return;
  }
  for (const action of ACTION_ORDER) {
    if (action === "toggleGrid" || action === "bookmarksList" || action === "toggleHelp") continue; // 上で処理済み
    if (matchAction(e, action)) {
      e.preventDefault();
      runAction(action);
      return;
    }
  }
});

// ウィンドウがフォーカスを失った場合の保険（ドラッグ状態が固着しないように）。
window.addEventListener("blur", () => {
  panning = false;
  viewer.style.cursor = canPan() ? "grab" : "";
});

// パン中の反映は描画フレームに合わせて間引く。ゲーミングマウス等では
// mousemove が毎秒数百回発火し、そのたびDOMを更新すると描画が追いつかず
// 引っかかって見えるため、1フレームにつき1回だけ反映する。
let panFramePending = false;
function schedulePanUpdate() {
  if (panFramePending) return;
  panFramePending = true;
  requestAnimationFrame(() => {
    panFramePending = false;
    // ドラッグが終わっていても反映は行う。ここで省くと、離す直前の移動分が
    // 画面に出ないまま内部座標だけ進み、次の操作時に画像が僅かに飛ぶ。
    updateTransform();
    updateNavigatorViewportRect(); // ドラッグ中もミニマップの青枠を追従させる
  });
}

// マウスを画面上端／下端に寄せたらバー表示／パン中は画像位置を更新
window.addEventListener("mousemove", (e) => {
  if (panning) {
    const { maxX, maxY } = panLimits();
    panX = clampNum(panOrigX + (e.clientX - panStartX), -maxX, maxX);
    panY = clampNum(panOrigY + (e.clientY - panStartY), -maxY, maxY);
    schedulePanUpdate();
    return;
  }
  if (gridOpen) return;
  if (e.clientY > window.innerHeight - 64) flashBar();
});

// バー・一覧の操作
document.querySelector("#open-btn")?.addEventListener("click", pickFile);
document.querySelector("#prev")?.addEventListener("click", () => go(-1));
document.querySelector("#next")?.addEventListener("click", () => go(1));
document.querySelector("#prev-vol")?.addEventListener("click", goPrevVolume);
document.querySelector("#next-vol")?.addEventListener("click", goNextVolume);
document.querySelector("#grid-btn")?.addEventListener("click", toggleGrid);
document.querySelector("#bind-toggle")?.addEventListener("click", toggleBindMode);
document.querySelector("#menu-btn")?.addEventListener("click", () => toggleMenu());
document.querySelector("#grid-close")?.addEventListener("click", closeGrid);
seek.addEventListener("input", () => jump(Number(seek.value)));
thumbSize.addEventListener("input", () => setThumbSize(Number(thumbSize.value)));

// ドラッグ＆ドロップ
getCurrentWebview().onDragDropEvent((event) => {
  if (event.payload.type === "drop" && event.payload.paths.length > 0) {
    openPath(event.payload.paths[0]);
  }
});

// ---- 起動時：履歴の読み込み・自動再開の確認 ----
function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

async function initHistoryAndResume() {
  try {
    // ファイル関連付け（拡張子ダブルクリック）から起動された場合は、そのファイルを
    // 最優先で開く（再開ダイアログより明示的な意図を優先する）。
    const launchPath = await invoke<string | null>("get_launch_path");
    if (launchPath) {
      await openPath(launchPath);
      return;
    }

    const h = await invoke<{
      lastOpened: string | null;
      positions: Record<string, number>;
      endBehavior: "loop" | "next";
    }>("get_history");
    setEndBehavior(h.endBehavior ?? "loop");
    const lastOpened = h.lastOpened;

    if (lastOpened) {
      const page = h.positions[lastOpened] ?? 0;
      resumeName.textContent = basenameOf(lastOpened);
      resumePage.textContent = String(page + 1);
      resumeDialog.classList.remove("hidden");

      const continueBtn = document.querySelector<HTMLButtonElement>("#resume-continue")!;
      const restartBtn = document.querySelector<HTMLButtonElement>("#resume-restart")!;
      continueBtn.onclick = () => {
        resumeDialog.classList.add("hidden");
        openPath(lastOpened);
      };
      restartBtn.onclick = async () => {
        resumeDialog.classList.add("hidden");
        const ext = extOf(lastOpened);
        if (ARCHIVE_EXTS.includes(ext)) await openArchive(lastOpened, true);
        else await openImageOrFolder(lastOpened, true);
      };
      // 「新しいファイル」＝ダイアログを閉じてファイル選択（旧キャンセルは実質これと同じ導線のため統合）。
      document.querySelector<HTMLButtonElement>("#resume-cancel")!.onclick = () => {
        resumeDialog.classList.add("hidden");
        pickFile();
      };
    }
  } catch (e) {
    console.error("履歴の読み込みに失敗:", e);
  }
}

initHistoryAndResume();

// 画質（リサイズフィルター）設定UIは、方式B（高速なブラウザ拡縮）へ戻したため
// 現在は主表示に効かず、UIごと外している。Rust側の実装（get_page_resized 等）は
// 将来「高画質モード」をオプションで復活させる際のために残置している。
