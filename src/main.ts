import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { open as openDialog, ask } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

const ARCHIVE_EXTS = ["zip", "cbz", "rar", "cbr", "7z", "cb7"];
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"];
const TEXT_EXTS = ["txt", "md"];
function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
}

// ---- 状態 ----
// ページの供給元。"archive"＝Rust側（アーカイブ・フォルダ・単独画像）、
// "pdf"＝フロント側のpdf.jsが各ページを画像として描画する。
// PDFもページ番号で扱う点は同じなので、見開き・拡大・しおり等は共通の仕組みに乗る。
let pageSource: "archive" | "pdf" | "text" = "archive";
let pageCount = 0;
let current = 0;
let barTimer: number | undefined;
// 本棚は下部バーの上に載るため、開いている間はバーを引っ込めない。
// flashBar() から参照するので、ここ（バー関連の状態）に置く。
let shelfOpen = false;

// 履歴・巻移動。currentAnchor は今開いている「巻」の識別パス
// （アーカイブファイルなら自身のパス、フォルダ/単独画像ならフォルダの基点パス）。
let currentAnchor: string | null = null;

// フォルダを「下層も含めて」開くと、同じフォルダでもページの並びと総数が変わる。
// 読書位置やしおりが別のページを指してしまうため、アンカーの末尾にこの印を付けて
// 別の本として扱う。`|` はWindowsのファイル名に使えないので実在のパスと衝突しない。
// （Rust側の RECURSIVE_MARK と同じ文字列。変える時は両方を合わせる。）
const RECURSIVE_MARK = "|下層込み";

/// アンカーから実在するパスの部分を取り出す（印を外す）。
function anchorPath(anchor: string): string {
  return anchor.endsWith(RECURSIVE_MARK)
    ? anchor.slice(0, -RECURSIVE_MARK.length)
    : anchor;
}

function isRecursiveAnchor(anchor: string): boolean {
  return anchor.endsWith(RECURSIVE_MARK);
}
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
// ドラッグ直後のクリックでページがめくれないようにする。真偽値ではなく時刻で持つ。
// ドラッグをウィンドウの外で離すと click が来ないため、真偽値だと立ったまま残り、
// 次の正当なクリックを1回食べてしまう（ページがめくれない）。
let justPannedAt = 0;
const PAN_CLICK_GUARD_MS = 400;

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

// 本文表示中の文字サイズ（rem）。拡大・縮小の操作をここへ割り当てる。
let textFontRem = Number(localStorage.getItem("textFontRem")) || 1;
const TEXT_FONT_MIN = 0.7;
const TEXT_FONT_MAX = 2.4;

function adjustTextFont(factor: number) {
  const next = clampNum(textFontRem * factor, TEXT_FONT_MIN, TEXT_FONT_MAX);
  if (next === textFontRem) return;
  textFontRem = next;
  localStorage.setItem("textFontRem", String(textFontRem));
  textviewBody.style.setProperty("--text-size", `${textFontRem}rem`);
  layoutTextPages(false); // 文字サイズが変われば1ページに入る量も変わる
}

// マウスカーソル位置を基準にズームする（カーソルの指す場所がズーム後も同じ位置に留まる）。
function zoomAt(clientX: number, clientY: number, factor: number) {
  // 本文表示中は「拡大」＝文字を大きくする、と読み替える。
  if (pageSource === "text") {
    adjustTextFont(factor);
    return;
  }
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
  // Alt・Windowsキーを伴う操作（Alt+Dのメニュー呼び出し等）は横取りしない。
  // どの割り当てもこれらを使わないので、押されていたら一致させない。
  if (e.altKey || e.metaKey) return false;
  if (e.key.toLowerCase() === b.key.toLowerCase()) return true;
  // "="の救済は、"="自体が他の操作に割り当てられていない時だけ行う。
  // でないと"="を割り当てても拡大が一緒に動いてしまう。
  if (b.key === "+" && e.key === "=" && !isKeyAssigned("=")) return true;
  return false;
}

/// そのキーが（"+"の救済を除いて）何かの操作に割り当てられているか。
function isKeyAssigned(key: string): boolean {
  const lower = key.toLowerCase();
  return ACTION_ORDER.some((id) => (keymap[id].key || "").toLowerCase() === lower);
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

// サムネイル1枚分のデータを取得する。PDFはRust側にページが無いので、
// pdf.jsで描いたページ画像をそのままサムネイルとして使う。
async function fetchThumbBlob(index: number): Promise<Blob> {
  // サムネイルを原寸2倍で描くと、一覧を開いただけで全ページ分の大きな画像を
  // 作ってしまう。Rust側のサムネイル（長辺360px）と同じ大きさに合わせる。
  if (pageSource === "pdf") return await renderPdfPage(index, THUMB_LONG_EDGE);
  const buf = await invoke<ArrayBuffer>("get_thumbnail", { index });
  return new Blob([buf]);
}

// ---- PDF（pdf.jsで各ページを画像として描画し、画像と同じ扱いに乗せる） ----
// ライブラリ本体は初回にPDFを開いた時だけ読み込む（起動を重くしないため）。
type PdfDoc = {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
};
/// 破棄はドキュメントではなく読み込みタスク側が持つ（版によって場所が違うため保持しておく）。
type PdfLoadingTask = { promise: Promise<unknown>; destroy: () => Promise<void> };
let pdfLoadingTask: PdfLoadingTask | null = null;

/// 開いているPDFを解放する。PDF以外を開いた時に呼ばないと、
/// pdf.jsのワーカーとPDF全体のバッファがセッション中ずっと残る。
async function releasePdf() {
  const task = pdfLoadingTask;
  pdfLoadingTask = null;
  pdfDoc = null;
  if (task) await task.destroy().catch(() => {});
}
type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => { promise: Promise<void> };
};

let pdfDoc: PdfDoc | null = null;
// 原寸の何倍で描画するか。1.0だと画面上で拡大した時に粗くなるため、少し余裕を持たせる。
const PDF_RENDER_SCALE = 2.0;
/// サムネイルの長辺（px）。Rust側の THUMB_MAX と揃える。
const THUMB_LONG_EDGE = 360;

/// 長辺を maxLongEdge に収める描画倍率（原寸の2倍を上限とする）。
function pdfScaleFor(page: PdfPage, maxLongEdge?: number): number {
  if (!maxLongEdge) return PDF_RENDER_SCALE;
  const base = page.getViewport({ scale: 1 });
  const long = Math.max(base.width, base.height) || 1;
  return Math.min(PDF_RENDER_SCALE, maxLongEdge / long);
}

async function loadPdfLib() {
  const lib = await import("pdfjs-dist");
  // ワーカーはバンドル済みのものを使う（外部から取得しない）。
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  lib.GlobalWorkerOptions.workerSrc = workerUrl;
  return lib;
}

async function pdfPageDims(index: number): Promise<{ w: number; h: number; animated: boolean }> {
  if (!pdfDoc) throw new Error("PDFが開かれていません");
  const page = await pdfDoc.getPage(index + 1); // pdf.jsのページ番号は1始まり
  const vp = page.getViewport({ scale: PDF_RENDER_SCALE });
  return { w: Math.round(vp.width), h: Math.round(vp.height), animated: false };
}

async function renderPdfPage(index: number, maxLongEdge?: number): Promise<Blob> {
  if (!pdfDoc) throw new Error("PDFが開かれていません");
  const page = await pdfDoc.getPage(index + 1);
  const viewport = page.getViewport({ scale: pdfScaleFor(page, maxLongEdge) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return await new Promise<Blob>((resolve, reject) => {
    // 文字主体のPDFでも劣化しにくいようPNGではなく高品質JPEGにする
    // （PNGだと写真ページで容量が跳ね上がり、キャッシュを圧迫するため）。
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("PDFページの画像化に失敗しました"))),
      "image/jpeg",
      0.92
    );
  });
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
// 取得している間に別の本へ切り替わった時に投げる印。表示側は黙って諦める。
const PAGE_STALE = "__stale_page__";
function isStalePage(e: unknown): boolean {
  return String(e).includes(PAGE_STALE);
}

async function getPageUrl(index: number, quiet = false): Promise<string> {
  const hit = pageCache.get(index);
  if (hit !== undefined) {
    touch(index);
    return hit;
  }
  const gen = archiveGen;
  let p = pageInflight.get(index);
  if (!p) {
    const fetchP = (async () => {
      if (pageSource === "pdf") {
        const blob = await renderPdfPage(index);
        return { url: URL.createObjectURL(blob), size: blob.size };
      }
      const buf = await invoke<ArrayBuffer>("get_page", { index, quiet });
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
    // 解放済みのURLは表示に使えないので、返さずに諦めたことを伝える。
    URL.revokeObjectURL(url);
    throw new Error(PAGE_STALE);
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
  if (pageSource === "pdf") {
    // PDFは実際に描画しなくても寸法が分かるので、ページ情報だけ引く。
    const dims = await pdfPageDims(index);
    if (gen === archiveGen) pageDims.set(index, dims);
    return dims;
  }
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
    const url = await getPageUrl(index, true);
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
      getPageUrl(t, true).catch(() => {}); // 先読み失敗は無視
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
  // 見開き用の2枚は src を指したままだと、URLを解放しても実体が残る。
  // 別の本へ移った後もセッション中ずっと保持され、設定した上限を超える。
  pageLeftEl.removeAttribute("src");
  pageRightEl.removeAttribute("src");
  for (const url of pageCache.values()) URL.revokeObjectURL(url);
  pageCache.clear();
  pageBytes.clear();
  pageNames.clear();
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
  // 本文は段組みで送るので、そもそもパンしない。
  // ここで弾かないと、前に開いていた画像の寸法(dispW/dispH)が残っている間は
  // 本文の上でドラッグがパン扱いになり、preventDefault で文字が選択できなくなる。
  if (pageSource === "text") return false;
  const vw = viewer.clientWidth;
  const vh = viewer.clientHeight;
  return dispW > vw + 0.5 || dispH > vh + 0.5;
}

// 同じ値でもstyleへ代入するとブラウザがスタイル再計算を予約してしまうため、
// 変化した時だけ書き込む（applyLayoutSettledが1回のページ送りで2回走る都合上、
// 2回目はほぼ同値になる。無駄な再計算を省くと体感が軽くなる）。
function setStyleIfChanged(
  el: HTMLElement,
  prop: "width" | "height" | "transform" | "margin",
  value: string
) {
  if (el.style[prop] !== value) el.style[prop] = value;
}

// 回転＋パン位置を反映するだけの軽量処理（サイズ計算はしない、ドラッグ中に多用）。
// 見開き時はパンをコンテナ（#spread）側で、回転は各画像側で扱う。
function updateTransform() {
  // translate3d を使うとGPU合成レイヤーに乗り、パン中の再描画がCPU側の
  // ペイントを伴わなくなる（2D translate だと環境により毎回ペイントが走る）。
  // 重要：applyLayout() と同じく、spreadMode（設定）ではなく実際の表示で分岐する。
  // 見開き設定のままでも表紙・横長・GIF・単ページのファイルは単ページ表示に
  // フォールバックしており、設定で分岐すると非表示の #spread 側へ位置を書き込み、
  // 見えている画像が動かない（手のひらツールが効かないように見える）。
  if (!spread.classList.contains("hidden")) {
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
let navThumbUrl = ""; // ミニマップに今出している画像のURL（差し替え時に解放する）
let navigatorWasVisible = false; // 前回のミニマップ表示状態（非表示→表示の瞬間にサムネを用意する）

function updateNavigatorVisibility() {
  // ミニマップは「画像が実際に画面からはみ出ている時」だけ。
  // パネル（リセットボタン）はズーム中（縮小含む）も出す。
  // 本文は拡大・パンの対象ではない（拡大は文字サイズの変更に読み替えている）。
  // 前に開いていた画像の倍率が残っていると、リセットボタンだけ本文の上に出てしまう。
  const isText = pageSource === "text";
  const pannable = canPan();
  const zoomed = !isText && Math.abs(zoomFactor - 1) > 0.001;
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
/// ビットマップを指定角度だけ回したキャンバスを作る（90/270度では縦横が入れ替わる）。
function rotateToCanvas(b: ImageBitmap, deg: number): HTMLCanvasElement {
  const swapped = deg % 180 !== 0;
  const c = document.createElement("canvas");
  c.width = Math.max(1, swapped ? b.height : b.width);
  c.height = Math.max(1, swapped ? b.width : b.height);
  const g = c.getContext("2d")!;
  g.translate(c.width / 2, c.height / 2);
  g.rotate((deg * Math.PI) / 180);
  g.drawImage(b, -b.width / 2, -b.height / 2);
  return c;
}

async function updateNavigatorThumb() {
  if (pageCount === 0) return;
  if (navigatorEl.classList.contains("hidden")) return;
  const isSpread = spreadMode && shownCount === 2;
  const idxLeft = isSpread ? (bindMode === "rtl" ? current + 1 : current) : current;
  const idxRight = isSpread ? (bindMode === "rtl" ? current : current + 1) : current;
  // 回転もキーに含める。含めないと、回した後もミニマップが回す前の絵を映し続け、
  // 表示範囲の枠（回転後の寸法で計算している）と噛み合わなくなる。
  const key =
    `${archiveGen}:${rotation}:` +
    (isSpread ? `spread:${idxLeft}-${idxRight}` : `single:${current}`);
  if (key === navThumbKey) return;
  navThumbKey = key;
  try {
    const indices = isSpread ? [idxLeft, idxRight] : [current];
    const bitmaps = await Promise.all(
      indices.map(async (i) => {
        return createImageBitmap(await fetchThumbBlob(i));
      })
    );
    if (key !== navThumbKey) return; // 取得中に表示内容が変わった
    // 画面では「各ページを回してから横に並べる」順序なので、合成も同じ順序で行う。
    // 並べてから全体を回すと、見開きの左右が入れ替わって見えてしまう。
    const parts = bitmaps.map((b) => {
      const src: CanvasImageSource = rotation ? rotateToCanvas(b, rotation) : b;
      const swapped = rotation % 180 !== 0;
      return { src, w: swapped ? b.height : b.width, h: swapped ? b.width : b.height };
    });
    const h = Math.max(...parts.map((p) => p.h), 1);
    const widths = parts.map((p) => (p.w * h) / p.h);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(widths.reduce((sum, w) => sum + w, 0)));
    canvas.height = Math.round(h);
    const ctx = canvas.getContext("2d")!;
    let x = 0;
    parts.forEach((p, i) => {
      ctx.drawImage(p.src, x, 0, widths[i], h);
      x += widths[i];
    });
    bitmaps.forEach((b) => b.close());
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
        // 解放を onload まで遅らせると、次のページの分が先に届いた時に
        // onload が上書きされ、前のURLが解放されないまま残る。
        // 差し替えた直後に前の分を解放する（既に読み込み済みなので安全）。
        const prev = navThumbUrl;
        navThumbUrl = url;
        navThumb.onload = () => updateNavigatorViewportRect();
        navThumb.src = url;
        if (prev.startsWith("blob:")) URL.revokeObjectURL(prev);
      },
      "image/jpeg",
      0.85
    );
    updateNavigatorViewportRect();
  } catch (e) {
    // 先に印を付けてしまっているので戻す。戻さないと、このページに対しては
    // 二度と取り直さず、ミニマップが前のページの絵を映したままになる。
    navThumbKey = "";
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
  if (!navDragging) return;
  // ウィンドウ外で離された場合に備え、押されていなければ解除する。
  if (!(e.buttons & 1)) {
    navDragging = false;
    return;
  }
  jumpNavigatorTo(e.clientX, e.clientY);
});
window.addEventListener("mouseup", () => {
  // ミニマップ外まで引っ張って離すと、click はミニマップではなく画像側で
  // 発生する（クリック対象は押した位置と離した位置の共通の親になるため）。
  // onUi() では弾けないので、パン操作と同じくフラグで次のクリックを抑止する。
  if (navDragging) justPannedAt = Date.now();
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
  // 本文表示中は画像の寸法（natW/natH）が前の本のまま残っている。
  // そのまま計算すると、ナビゲーターが本文の上に出たり、
  // canPan() が真になって本文の文字が選択できなくなる。
  if (pageSource === "text") {
    dispW = 0;
    dispH = 0;
    updateNavigatorVisibility();
    return;
  }
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
    // CSSのrotateは「見た目」だけを回し、場所取り（レイアウト箱）は回さない。
    // 見開きは2枚を横に並べるため、90/270度では箱と見た目のずれぶん
    // 2枚が中央で重なってしまう。差分を余白で補い、見た目どおりの幅を取らせる。
    const mx = swapped ? (box.h - box.w) / 2 : 0;
    const my = swapped ? (box.w - box.h) / 2 : 0;
    setStyleIfChanged(el, "margin", mx || my ? `${my}px ${mx}px` : "");
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
// 表示領域の広さが変わった時の作り直し。ウィンドウのリサイズと、
// ツリーパネルの幅変更の両方から呼ぶ。
function relayoutForViewerSize() {
  // 本文は画面幅で段組みが変わる＝総ページ数も変わるため、組み直す。
  if (pageSource === "text") layoutTextPages(false);
  else applyLayoutSettled();
}

window.addEventListener("resize", () => {
  relayoutForViewerSize();
  // ウィンドウを狭めた時、ツリーの幅は上限（画面幅の6割）を超えたまま残り、
  // 表示領域を潰してしまう。今の幅を入れ直して上限を効かせる。
  applyTreeWidth(treeWidth);
  // 開いているメニューは、上部バーやボタンの位置が変わると置き場所がずれる。
  repositionOpenMenus();
});

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
  // 隠した時点で単ページ。デコード失敗などで途中で抜けても2のまま残さない
  // （残るとページ送りが2つずつ進み、1ページ飛ばしになる）。
  shownCount = 1;
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
    if (!isStalePage(e)) console.error("ページ取得失敗:", e);
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
    // レイアウトより先に2枚扱いにする。applyLayout はミニマップの用意も呼ぶので、
    // 1枚のままだと単ページ用の絵を一度作ってから作り直す無駄が出る。
    shownCount = 2;
    applyLayoutSettled();
    counter.textContent = `${idx + 1}-${idx + 2} / ${pageCount}`;
    seek.value = String(idx);
    flashBar();
    prefetch();
    updateNavigatorThumb();
    updateBookmarkBtnUi();
  } catch (e) {
    if (!isStalePage(e)) console.error("見開きページ取得失敗:", e);
  }
}

// ---- 本文表示（txt / md） ----
// 段組み（CSS columns）で1画面ぶんずつ区切り、横にずらして「めくる」。
// 自前で文字数を数えて区切ると、見出し・箇条書き・長い行で破綻するため、
// ブラウザの段組み機能に区切りを任せている。
const textview = document.querySelector<HTMLDivElement>("#textview")!;
const textviewBody = document.querySelector<HTMLDivElement>("#textview-body")!;
const TEXT_COLUMN_GAP = 48;

let textSource = ""; // 表示中の本文（再区切りのために保持）
let textIsMarkdown = false;
let textPageTotal = 1;

/// HTMLとして解釈されうる文字を無効化する。本文は必ずこれを通してから組み立てる
/// （テキスト内に書かれたタグを、そのままの文字として見せるため）。
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/// 行内の装飾（太字・斜体・コード・リンク）を適用する。
/// 入力は必ずエスケープ済みであること。リンクは http/https のみ許可する。
function inlineMarkdown(s: string): string {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/// Markdownを整形済みHTMLへ変換する（見出し・箇条書き・引用・区切り線・コード）。
function renderMarkdown(src: string): string {
  const lines = escapeHtml(src).split(/\r?\n/);
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let inCode = false;
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      closeList();
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(line + "\n");
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(---|___|\*\*\*)\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      continue;
    }
    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inlineMarkdown((ul ?? ol)![1])}</li>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (inCode) out.push("</pre>");
  return out.join("");
}

/// 素のテキストを段落として組む（空行を段落の区切りとみなす）。
function renderPlainText(src: string): string {
  return escapeHtml(src)
    .split(/\r?\n\r?\n+/)
    .map((block) => `<p>${block.replace(/\r?\n/g, "<br />")}</p>`)
    .join("");
}

// ---- 本文の読み位置（文字位置で持つ） ----
// 本文のページ数は画面幅と文字サイズで変わる。ページ番号で位置を覚えると、
// 窓の大きさを変えただけで読書位置としおりが別の場所を指してしまう。
// そこで「先頭から何文字目か」で記録し、表示のたびに今のページ番号へ換算する。
// 換算表は、一定間隔の文字が組版後にどの段（＝ページ）へ落ちたかを
// 範囲(Range)の座標で測って作る（本文自体は一切書き換えない）。
const TEXT_SAMPLE_MIN_STEP = 80; // 測る間隔（文字）＝戻れる位置の細かさ
const TEXT_SAMPLE_MAX_COUNT = 4000; // 測る回数の上限（長文で時間がかかり過ぎないように）
let textNodes: { node: Text; start: number }[] = [];
let textCharTotal = 0;
let textPageOffsets: number[] = []; // ページ番号 -> そのページ先頭の文字位置

/// 本文中のテキストノードを、先頭から何文字目かと一緒に並べて控える。
/// buildTextView で本文を差し込んだ直後に呼ぶ（以後は本文を書き換えない）。
function collectTextNodes() {
  const walker = document.createTreeWalker(textviewBody, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; start: number }[] = [];
  let total = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.length === 0) continue;
    nodes.push({ node: t, start: total });
    total += t.length;
  }
  textNodes = nodes;
  textCharTotal = total;
}

/// 指定の文字位置が今どこに組まれているかを測る（本文枠の左端からのx座標）。
/// 目印の要素を挟む方法だと組版に影響し得るため、範囲(Range)の位置を読む。
function measureXForOffset(off: number, bodyLeft: number): number | null {
  // 二分探索でその文字を含むノードを見つける。
  let lo = 0;
  let hi = textNodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (textNodes[mid].start <= off) lo = mid;
    else hi = mid - 1;
  }
  const entry = textNodes[lo];
  if (!entry) return null;
  const k = Math.min(off - entry.start, entry.node.length - 1);
  if (k < 0) return null;
  const range = document.createRange();
  range.setStart(entry.node, k);
  range.setEnd(entry.node, k + 1);
  const rect = range.getBoundingClientRect();
  range.detach();
  if (rect.width === 0 && rect.height === 0) return null; // 折り返しの隙間など
  return rect.left - bodyLeft;
}

/// 「ページ番号 -> 先頭の文字位置」の表を作る。
function computeTextPageOffsets(stride: number) {
  textPageOffsets = new Array(Math.max(1, textPageTotal)).fill(-1);
  textPageOffsets[0] = 0;
  if (textCharTotal === 0) return;
  const bodyLeft = textviewBody.getBoundingClientRect().left;
  const step = Math.max(
    TEXT_SAMPLE_MIN_STEP,
    Math.ceil(textCharTotal / TEXT_SAMPLE_MAX_COUNT)
  );
  for (let off = 0; off < textCharTotal; off += step) {
    const x = measureXForOffset(off, bodyLeft);
    if (x === null) continue;
    const p = Math.min(textPageTotal - 1, Math.max(0, Math.floor(x / stride)));
    if (textPageOffsets[p] < 0) textPageOffsets[p] = off;
  }
  // 測れなかった／文字が載っていないページは、直前のページと同じ位置として扱う。
  for (let i = 1; i < textPageOffsets.length; i++) {
    if (textPageOffsets[i] < 0) textPageOffsets[i] = textPageOffsets[i - 1];
  }
}

function textOffsetOfPage(page: number): number {
  if (textPageOffsets.length === 0) return 0;
  const p = Math.min(textPageOffsets.length - 1, Math.max(0, page));
  return textPageOffsets[p];
}

function textPageOfOffset(off: number): number {
  if (textPageOffsets.length === 0) return 0;
  // 表は単調非減少。文字が載っていないページは直前と同じ値で埋めてあるため、
  // 同じ値が並ぶことがある。その場合は「先に出てくる方」を返す
  // （後ろを返すと、記録した位置より先へ飛んでしまい読み飛ばしになる）。
  let hit = 0;
  let best = -1;
  for (let i = 0; i < textPageOffsets.length; i++) {
    const o = textPageOffsets[i];
    if (o > off) break;
    if (o > best) {
      best = o;
      hit = i;
    }
  }
  return hit;
}

/// 記録する値。画像は「ページ番号」、本文は「先頭から何文字目か」。
function positionKeyOf(page: number): number {
  return pageSource === "text" ? textOffsetOfPage(page) : page;
}

/// 記録された値から、今のレイアウトでのページ番号へ戻す。
function pageOfPositionKey(key: number): number {
  return pageSource === "text" ? textPageOfOffset(key) : key;
}

// 文字位置の測り直しは、文庫1冊ぶん（約20万文字）で40ms前後かかる。
// ウィンドウの端をドラッグすると毎フレーム組み直しが走るので、そのたびに
// 測り直すと明確にカクつく。ドラッグ中は段組みだけ直し、手が止まってから測る。
let textRemeasureTimer: number | undefined;
// 連続変更に入る直前の文字位置。測り直しを飛ばしている間、ここへ預けておく
// （ページ番号は幅の変化で意味が変わるため、番号では預けられない）。
let textHeldOffset: number | null = null;

function scheduleTextRemeasure() {
  window.clearTimeout(textRemeasureTimer);
  textRemeasureTimer = window.setTimeout(() => layoutTextPages(true), 150);
}

/// 本文を段組みし直して総ページ数を求める。画面サイズ・文字サイズの変更後に呼ぶ。
/// 組み直すとページ番号の意味が変わるので、直前の文字位置を保って戻す。
/// remeasure=false は連続変更中の軽い経路（測り直しは手が止まってから行う）。
function layoutTextPages(remeasure = true) {
  if (textview.classList.contains("hidden")) return;
  const w = textviewBody.clientWidth;
  if (w <= 0) return;
  // 連続変更の初回に、今の文字位置を預ける（以後の組み直しでは触らない）。
  if (!remeasure && textHeldOffset === null && textPageOffsets.length > 0) {
    textHeldOffset = textOffsetOfPage(current);
  }
  textviewBody.style.transform = "";
  textviewBody.style.columnWidth = `${w}px`;
  textviewBody.style.columnGap = `${TEXT_COLUMN_GAP}px`;
  textviewBody.style.columnFill = "auto";
  const stride = w + TEXT_COLUMN_GAP;
  textPageTotal = Math.max(1, Math.round(textviewBody.scrollWidth / stride));
  pageCount = textPageTotal;
  seek.max = String(pageCount - 1);
  if (remeasure) {
    window.clearTimeout(textRemeasureTimer);
    const keepOffset =
      textHeldOffset ?? (textPageOffsets.length > 0 ? textOffsetOfPage(current) : 0);
    textHeldOffset = null;
    computeTextPageOffsets(stride);
    // 幅が変われば同じ文字位置でもページ番号が変わる。番号ではなく位置で戻す。
    current = Math.min(pageCount - 1, textPageOfOffset(keepOffset));
    recomputeBookmarkedPages(); // しおりの点灯も新しいページ番号で取り直す
  } else {
    current = clampNum(current, 0, pageCount - 1);
    scheduleTextRemeasure();
  }
  showTextPage(current);
}

function showTextPage(index: number) {
  const stride = textviewBody.clientWidth + TEXT_COLUMN_GAP;
  textviewBody.style.transform = `translateX(-${index * stride}px)`;
  counter.textContent = `${index + 1} / ${pageCount}`;
  seek.value = String(index);
  updateBookmarkBtnUi();
}

/// 本文を組み直す（ファイルを開いた時・画面や文字サイズが変わった時だけ）。
function buildTextView() {
  textviewBody.style.setProperty("--text-size", `${textFontRem}rem`); // 前回の文字サイズを反映
  // 画像側の表示要素は隠し、本文だけを見せる。
  img.classList.remove("loaded");
  spread.classList.add("hidden");
  textview.classList.remove("hidden");
  textviewBody.innerHTML = textIsMarkdown
    ? renderMarkdown(textSource)
    : renderPlainText(textSource);
  textPageOffsets = [];
  textHeldOffset = null;
  collectTextNodes(); // 文字位置を測るための下準備（本文自体は書き換えない）
  // 段組みは実際の描画幅が要るため、レイアウト確定後に計算する。
  layoutTextPages();
  requestAnimationFrame(() => layoutTextPages());
  flashBar();
}

/// 単体のテキストファイルを開く（画像と同じく、ページ送りで読む）。
async function openTextFile(path: string, reset = false, seq = beginOpenRequest()) {
  stopProgressPolling();
  resumeDialog.classList.add("hidden");
  try {
    invoke("note_open_seq", { seq }).catch(() => {}); // PDFと同じ理由
    const body = await invoke<string>("read_text_file", { path });
    if (!isCurrentOpen(seq)) return; // 読み込み中に別のファイルが開かれた
    // 読めてから前の本を閉じる（絵・一覧を引き継がせないため）。先に閉じると、
    // 読めなかった時（大きすぎる等）に画面は前の本のまま中身だけが消え、めくれなくなる。
    await invoke("close_archive", { seq }).catch(() => {});
    if (!isCurrentOpen(seq)) return;
    textSource = body;
    textIsMarkdown = extOf(path) === "md";
    releasePdf(); // PDF以外へ移るのでワーカーとバッファを解放する
    pageSource = "text";
    archiveGen++;
    resetPageCache();
    current = 0;
    pageCount = 1; // 実際の総数は段組み後に確定する
    currentAnchor = path;
    updateWindowTitle();
    if (shelfOpen) updateShelfAddBtnUi();
    loadBookmarkedPages();
    setTreeRootForAnchor(path);
    hint.style.display = "none";
    seek.disabled = false;
    closeStalePanels(); // 前の本を指したままのパネルを閉じる
    setOpeningPhase("本文を組み立て中…");
    buildTextView();
    if (!reset) {
      const h = await invoke<{ positions: Record<string, number> }>("get_history");
      if (!isCurrentOpen(seq)) return; // 待っている間に別のファイルが開かれた
      // 記録されているのは「先頭から何文字目か」。今の幅でのページ番号へ換算する。
      const savedOffset = h.positions[path] ?? 0;
      const page = Math.min(Math.max(0, pageCount - 1), textPageOfOffset(savedOffset));
      if (page > 0) {
        current = page;
        showTextPage(current);
      }
    }
  } catch (e) {
    if (isSuperseded(e)) return; // 別のファイルが開かれたので捨てられただけ。失敗ではない
    alert("開けませんでした: " + e);
  }
}

/// 画像以外の表示要素を片付ける（画像・PDFの表示へ戻る時に呼ぶ）。
function hideTextView() {
  textview.classList.add("hidden");
  // 本文のDOMと文字位置の控えは、文庫1冊なら数十万文字ぶん残る。
  // 画像へ移ったら手放す（軽快さを保つため）。ページ送りごとに呼ばれるので、
  // 抱えている時だけ片付ける。
  if (textCharTotal > 0 || textviewBody.firstChild) {
    textviewBody.textContent = "";
    textNodes = [];
    textCharTotal = 0;
    textPageOffsets = [];
    textSource = "";
  }
}

// ---- 同梱テキスト（アーカイブ／フォルダに含まれる説明書き等） ----
// 画像のページ列には混ぜず、必要な時だけここから開く（読書の流れを乱さないため）。
const textsPanel = document.querySelector<HTMLDivElement>("#texts")!;
const textsList = document.querySelector<HTMLDivElement>("#texts-list")!;
const textsReader = document.querySelector<HTMLDivElement>("#texts-reader")!;
// 本文の差し込み先は内側の入れ物。#texts-reader 自体へ書くと入れ物ごと消える。
const textsReaderBody = document.querySelector<HTMLDivElement>("#texts-reader-body")!;
let textsReadSeq = 0;

// 本文・同梱テキスト中のリンク。既定の動作に任せると、クリックがページ送りにも
// 使われたうえで、アプリの中に枠だけのブラウザ窓が開いてしまう。
// 既定のブラウザで開き、ページ送りには使わない。
function handleTextLinkClick(e: MouseEvent) {
  const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!a) return;
  e.preventDefault();
  e.stopPropagation(); // 画面全体の click（ページ送り）へ届かせない
  const href = a.getAttribute("href") ?? "";
  // 組み立て時に http/https だけを通しているが、念のためここでも確かめる。
  if (/^https?:\/\//i.test(href)) {
    openUrl(href).catch((err) => console.error("リンクを開けませんでした:", err));
  }
}
textviewBody.addEventListener("click", handleTextLinkClick);
textsReaderBody.addEventListener("click", handleTextLinkClick);
let textsOpen = false;

async function openTextsPanel() {
  textsOpen = true;
  textsPanel.classList.remove("hidden");
  textsReader.classList.add("hidden");
  textsList.classList.remove("hidden");
  textsList.innerHTML = "";
  try {
    const names = await invoke<string[]>("list_archive_texts");
    if (names.length === 0) {
      const empty = document.createElement("div");
      empty.className = "texts-empty";
      empty.textContent = "このファイルにテキストは含まれていません。";
      textsList.appendChild(empty);
      return;
    }
    for (const name of names) {
      const btn = document.createElement("button");
      btn.textContent = name;
      btn.addEventListener("click", () => showArchiveText(name));
      textsList.appendChild(btn);
    }
  } catch (e) {
    console.error("同梱テキストの一覧取得に失敗:", e);
  }
}

async function showArchiveText(name: string) {
  const mySeq = ++textsReadSeq;
  try {
    const body = await invoke<string>("read_archive_text", { name });
    if (mySeq !== textsReadSeq) return; // 読んでいる間に別のテキストが選ばれた
    textsReaderBody.innerHTML = name.toLowerCase().endsWith(".md")
      ? renderMarkdown(body)
      : renderPlainText(body);
    textsList.classList.add("hidden");
    textsReader.classList.remove("hidden");
    textsReader.scrollTop = 0;
  } catch (e) {
    alert("テキストを開けませんでした: " + e);
  }
}

function closeTextsPanel() {
  // 本文を見ている時は一覧へ戻り、一覧まで戻っていればパネルを閉じる。
  if (!textsReader.classList.contains("hidden")) {
    textsReader.classList.add("hidden");
    textsList.classList.remove("hidden");
    return;
  }
  textsOpen = false;
  textsPanel.classList.add("hidden");
}

document.querySelector("#texts-close")?.addEventListener("click", closeTextsPanel);

// 上部バーに出す「今見ているページのファイル名」。
// 表示中のものが分かると、どのファイルを読んでいるか確認するために
// ウィンドウのタイトルやフォルダを見に行く必要がなくなる。
const currentFileEl = document.querySelector<HTMLSpanElement>("#current-file")!;
// ページ名はアーカイブを開いている間は変わらないので覚えておく。
// ページ送りのたびにIPCを往復させると、軽快さを損なうため。
const pageNames = new Map<number, string>();

async function fetchPageName(index: number): Promise<string> {
  const hit = pageNames.get(index);
  if (hit !== undefined) return hit;
  const gen = archiveGen;
  const name = await invoke<string>("get_page_name", { index }).catch(() => "");
  if (gen === archiveGen) pageNames.set(index, name);
  return name;
}

async function updateCurrentFileName() {
  if (pageCount === 0) {
    currentFileEl.textContent = "";
    currentFileEl.title = "";
    return;
  }
  // PDFとテキストはRust側にページ一覧が無いので、ファイル自体の名前を出す。
  if (pageSource !== "archive") {
    const name = currentAnchor ? basenameOf(anchorPath(currentAnchor)) : "";
    currentFileEl.textContent = name;
    currentFileEl.title = name;
    return;
  }
  // 取得中にページが進んだ場合、古い結果で上書きしないよう控えておく。
  const gen = archiveGen;
  const at = current;
  const count = shownCount === 2 ? 2 : 1; // 見開き表示中は2ページ分を並べる
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = await fetchPageName(at + i);
    if (n) names.push(n);
  }
  if (gen !== archiveGen || at !== current) return;
  const text = names.join(" ／ ");
  currentFileEl.textContent = text;
  currentFileEl.title = text;
}

async function render() {
  if (pageSource === "text") {
    // 本文は既に組んであるので、表示位置をずらすだけ（組み直しはしない）。
    showTextPage(current);
    updateCurrentFileName();
    return;
  }
  hideTextView();
  if (pageCount === 0) return;
  if (spreadMode) await renderSpread();
  else await renderSingle();
  updateCurrentFileName();
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
  if (!spreadMode || pageSource === "text") {
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
    // 読み進めて次の巻へ渡る時は1ページ目から。記憶した位置（途中）から
    // 始まると、遡る側が最終ページに着くのと釣り合わず、読み飛ばしになる。
    goVolume(1, false, true);
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
  const page = positionKeyOf(current);
  // 読書中はページを次々に送るため、書き込みは最後の1回にまとめたい。
  // 0.5秒だと連続してめくる速さと競合して書き込み回数が増えるので、間隔を広げる
  // （途中で閉じた場合に失うのは直前のめくり1回分だけなので実害は小さい）。
  saveTimer = window.setTimeout(() => {
    invoke("save_position", { anchor, page }).catch(() => {});
  }, 1500);
}

// 待機中の保存を今すぐ書き出す。間隔を広げた分、閉じる直前の位置を取りこぼさないため。
function flushPositionSave() {
  if (saveTimer === undefined) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!currentAnchor) return;
  invoke("save_position", { anchor: currentAnchor, page: positionKeyOf(current) }).catch(() => {});
}

// ウインドウタイトルに現在読み込んでいるファイル（アーカイブ/フォルダ）名を表示する。
function updateWindowTitle() {
  const title = currentAnchor
    ? `MameViewer - ${basenameOf(anchorPath(currentAnchor))}` +
      (isRecursiveAnchor(currentAnchor) ? "（下層込み）" : "")
    : "MameViewer";
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
  kind: "folder" | "archive" | "image" | "pdf" | "text" | "other";
  mtime: number; // 更新日時（UNIXエポック秒）
  size: number; // バイト数（フォルダは0）
}

type TreeSortKey = "name" | "date" | "kind" | "size";

const treePanel = document.querySelector<HTMLDivElement>("#tree-panel")!;
const treeUpBtn = document.querySelector<HTMLButtonElement>("#tree-up-btn")!;
const treeLocateBtn = document.querySelector<HTMLButtonElement>("#tree-locate-btn")!;
const treeRootPathEl = document.querySelector<HTMLSpanElement>("#tree-root-path")!;
const treeScrollEl = document.querySelector<HTMLDivElement>("#tree-scroll")!;
const treeSortbar = document.querySelector<HTMLDivElement>("#tree-sortbar")!;

const TREE_ICONS: Record<string, string> = {
  folder: "📁",
  archive: "🗜️",
  image: "🖼️",
  other: "📄",
};

let treeRootDir: string | null = null;
let treeHighlightPath: string | null = null;
// 今まさに開こうとしている項目。開き終わるまでツリー上で「読み込み中」として示す。
let treeLoadingPath: string | null = null;
const treeExpanded = new Set<string>();

// ドライブ直下からさらに上へ辿った時に出す「場所」一覧。ドライブの一覧と
// よく使うフォルダを並べ、ここから別のドライブへ移れるようにする
// （従来はドライブ直下が行き止まりで、開いた本と別のドライブへ移れなかった）。
interface PlaceEntry {
  name: string;
  path: string;
  kind: string;
}
// 登録した場所（フォルダのお気に入り）。本棚＝本のお気に入りとは役割が別。
interface FavoritePlace {
  path: string;
  name: string;
  addedAt: number;
}
let treeAtPlaces = false;

// ツリーの移動履歴。サイドボタンで「戻る／進む」ができるようにする。
// 記録するのは表示起点の移動だけで、フォルダの開閉は含めない
// （エクスプローラーの戻る／進むと同じ考え方）。
type TreeLocation = { kind: "places" } | { kind: "dir"; path: string; highlight: string | null };
let treeHistory: TreeLocation[] = [];
let treeHistoryIndex = -1;
let treeNavigating = false; // 履歴を辿っている最中は新たに積まない

function pushTreeHistory(loc: TreeLocation) {
  if (treeNavigating) return;
  const cur = treeHistory[treeHistoryIndex];
  // 同じ場所への移動は積まない（重複で戻る回数が増えるのを防ぐ）
  if (cur && cur.kind === loc.kind) {
    if (loc.kind === "places") return;
    if (cur.kind === "dir" && cur.path === loc.path) return;
  }
  treeHistory = treeHistory.slice(0, treeHistoryIndex + 1); // 分岐したら先の履歴は捨てる
  treeHistory.push(loc);
  // 長時間の閲覧で無制限に伸びるのを防ぐ（古い方から捨てる）。
  const TREE_HISTORY_MAX = 200;
  if (treeHistory.length > TREE_HISTORY_MAX) {
    treeHistory = treeHistory.slice(treeHistory.length - TREE_HISTORY_MAX);
  }
  treeHistoryIndex = treeHistory.length - 1;
}

async function applyTreeLocation(loc: TreeLocation) {
  treeNavigating = true;
  try {
    if (loc.kind === "places") await showPlaces();
    else await setTreeRoot(loc.path, loc.highlight);
  } finally {
    treeNavigating = false;
  }
}

async function treeGoBack() {
  if (treeHistoryIndex <= 0) return;
  treeHistoryIndex--;
  await applyTreeLocation(treeHistory[treeHistoryIndex]);
}

async function treeGoForward() {
  if (treeHistoryIndex >= treeHistory.length - 1) return;
  treeHistoryIndex++;
  await applyTreeLocation(treeHistory[treeHistoryIndex]);
}

const PLACE_ICONS: Record<string, string> = {
  "drive-fixed": "💽",
  "drive-remote": "🌐",
  "drive-removable": "🔌",
  "drive-other": "💿",
  folder: "📁",
};

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
// フォルダの中身は外から増減する。一度覚えたまま使い続けると、追加した本が
// いつまでも出てこない／消した本が残る。かといって開閉のたびに取り直すと重いので、
// 短い有効期間を設けて、切れていたら取り直す。
type TreeCacheEntry = { entries: TreeEntry[]; expires: number };
const treeChildrenCache = new Map<string, TreeCacheEntry>();
const TREE_CACHE_TTL_MS = 20_000;
// 取得に失敗した場合（未接続のネットワークドライブ等）は、復帰したらすぐ拾えるよう
// ごく短い間だけ空として扱う。長く覚えると「繋いだのに永遠に空」になる。
const TREE_CACHE_FAIL_TTL_MS = 3_000;
const TREE_CACHE_MAX = 400;

/// 描画用。期限切れでも持っているものを返す（「読み込み中…」に戻すより自然）。
function cachedTreeEntries(path: string): TreeEntry[] | undefined {
  return treeChildrenCache.get(path)?.entries;
}

function putTreeCache(path: string, entries: TreeEntry[], ttl: number) {
  treeChildrenCache.delete(path); // 挿入順を最新にし直す（古い順に捨てるため）
  treeChildrenCache.set(path, { entries, expires: Date.now() + ttl });
  while (treeChildrenCache.size > TREE_CACHE_MAX) {
    const oldest = treeChildrenCache.keys().next().value;
    if (oldest === undefined || oldest === path) break;
    treeChildrenCache.delete(oldest);
  }
}

async function fetchTreeDir(path: string, force = false): Promise<TreeEntry[]> {
  const hit = treeChildrenCache.get(path);
  if (hit && !force && Date.now() < hit.expires) return hit.entries;
  try {
    const entries = await invoke<TreeEntry[]>("list_tree_dir", { path });
    putTreeCache(path, entries, TREE_CACHE_TTL_MS);
    return entries;
  } catch (e) {
    console.error("フォルダ一覧取得失敗:", e);
    putTreeCache(path, [], TREE_CACHE_FAIL_TTL_MS);
    return [];
  }
}

function buildTreeLevel(entries: TreeEntry[]): HTMLElement {
  const container = document.createElement("div");
  for (const entry of sortedTreeEntries(entries)) {
    const node = document.createElement("div");
    node.className = "tree-node";

    const row = document.createElement("div");
    row.className =
      "tree-row" +
      (entry.path === treeHighlightPath ? " current" : "") +
      (entry.path === treeLoadingPath ? " loading" : "");
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
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation(); // 画面の右クリック（前のページへ）を発火させない
      openTreeContext(entry, e.clientX, e.clientY);
    });
    row.addEventListener("click", () => {
      if (entry.isDir) toggleTreeNode(entry.path);
      else if (
        entry.kind === "archive" ||
        entry.kind === "image" ||
        entry.kind === "pdf" ||
        entry.kind === "text"
      )
        openPath(entry.path);
    });
    node.appendChild(row);

    if (entry.isDir && treeExpanded.has(entry.path)) {
      const childrenWrap = document.createElement("div");
      childrenWrap.className = "tree-children";
      const cached = cachedTreeEntries(entry.path);
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
  // 「場所」一覧を出している間は描かない。遅いフォルダの取得が後から届いて
  // ここへ来ると、先に消してから抜けるため、場所一覧が空欄になってしまう。
  if (treeAtPlaces) return;
  treeScrollEl.innerHTML = "";
  if (!treeRootDir) return;
  const rootEntries = cachedTreeEntries(treeRootDir);
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

// 「場所」一覧を表示する（ドライブ直下からさらに上へ辿った時の行き先）。
// 「場所」一覧の表示回数。取得を待つ間にもう一度開かれた場合、
// 古い方の結果を書き足さないために使う（放置すると項目が二重に並ぶ）。
let placesSeq = 0;

async function showPlaces() {
  const mySeq = ++placesSeq;
  pushTreeHistory({ kind: "places" });
  treeAtPlaces = true;
  treeRootDir = null;
  treeRootPathEl.textContent = "PC";
  treeRootPathEl.title = "この PC の場所";
  treeUpBtn.disabled = true; // ここが最上位
  treeSortbar.classList.add("hidden"); // ドライブ一覧に並び替えは要らない
  treeScrollEl.innerHTML = "";
  treeScrollEl.appendChild(buildPathInputRow());
  try {
    const places = await invoke<PlaceEntry[]>("list_places");
    if (!treeAtPlaces || mySeq !== placesSeq) return; // 取得中に移動または再表示された

    // お気に入りはツリー下部に常設しているので、ここには重ねて出さない。
    const drives = places.filter((p) => p.kind.startsWith("drive-"));
    const folders = places.filter((p) => !p.kind.startsWith("drive-"));
    if (drives.length > 0) {
      treeScrollEl.appendChild(buildPlaceHeading("ドライブ"));
      for (const p of drives) {
        treeScrollEl.appendChild(buildPlaceRow(PLACE_ICONS[p.kind] ?? "💽", p.name, p.path));
      }
    }
    if (folders.length > 0) {
      treeScrollEl.appendChild(buildPlaceHeading("よく使う場所"));
      for (const p of folders) {
        treeScrollEl.appendChild(buildPlaceRow(PLACE_ICONS[p.kind] ?? "📁", p.name, p.path));
      }
    }
  } catch (e) {
    console.error("場所一覧の取得に失敗:", e);
  }
}

function buildPlaceHeading(text: string): HTMLElement {
  const h = document.createElement("div");
  h.className = "tree-heading";
  h.textContent = text;
  return h;
}

function buildPlaceRow(icon: string, label: string, path: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "tree-row";
  row.title = path;
  const iconEl = document.createElement("span");
  iconEl.className = "tree-icon";
  iconEl.textContent = icon;
  const name = document.createElement("span");
  name.className = "tree-name";
  name.textContent = label;
  row.append(iconEl, name);
  row.addEventListener("click", async () => {
    // 切断中のネットワーク上の場所はここで初めて失敗が分かる（一覧表示時は確認しない）。
    const ok = await invoke<boolean>("dir_exists", { path }).catch(() => false);
    if (!ok) {
      alert("開けませんでした。接続状態をご確認ください:\n" + path);
      return;
    }
    await setTreeRoot(path, null);
  });
  return row;
}

// ---- お気に入りの場所（ツリー下部に常設） ----
// ツリーのどこを見ていても、登録した置き場へ一手で移れるようにする。
const treeFavList = document.querySelector<HTMLDivElement>("#tree-fav-list")!;
const treeFavHeader = document.querySelector<HTMLDivElement>("#tree-fav-header")!;
const treeFavCaret = document.querySelector<HTMLSpanElement>("#tree-fav-caret")!;
let treeFavCollapsed = localStorage.getItem("treeFavCollapsed") === "true";

function applyFavCollapsed() {
  treeFavList.classList.toggle("hidden", treeFavCollapsed);
  treeFavCaret.textContent = treeFavCollapsed ? "▲" : "▼";
}

treeFavHeader.addEventListener("click", () => {
  treeFavCollapsed = !treeFavCollapsed;
  localStorage.setItem("treeFavCollapsed", String(treeFavCollapsed));
  applyFavCollapsed();
});

async function refreshFavorites() {
  try {
    const favorites = await invoke<FavoritePlace[]>("list_favorites");
    treeFavList.innerHTML = "";
    if (favorites.length === 0) {
      const empty = document.createElement("div");
      empty.className = "tree-fav-empty";
      empty.textContent = "フォルダを右クリックして追加できます";
      treeFavList.appendChild(empty);
      return;
    }
    for (const fav of favorites) {
      const row = buildPlaceRow("⭐", fav.name, fav.path);
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFavoriteContext(fav, e.clientX, e.clientY);
      });
      treeFavList.appendChild(row);
    }
  } catch (e) {
    console.error("お気に入りの取得に失敗:", e);
  }
}

applyFavCollapsed();
refreshFavorites();

// お気に入り行の右クリック（解除のみ）。
function openFavoriteContext(fav: FavoritePlace, clientX: number, clientY: number) {
  treeContextEl.innerHTML = "";
  const btn = document.createElement("button");
  btn.textContent = "お気に入りから外す";
  btn.addEventListener("click", async () => {
    closeTreeContext();
    await invoke("remove_favorite", { path: fav.path }).catch(() => {});
    await refreshFavorites();
  });
  treeContextEl.appendChild(btn);
  treeContextEl.classList.remove("hidden");
  const rect = treeContextEl.getBoundingClientRect();
  treeContextEl.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - rect.width - 4))}px`;
  treeContextEl.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - rect.height - 4))}px`;
}

// 一覧に出ない場所（`\\server\share` 等）へ移るための入力欄。
// 常設せず「場所」一覧の中だけに置く（普段の画面を増やさないため）。
function buildPathInputRow(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tree-path-entry";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "パスを入力（例 \\\\server\\share）";
  const go = document.createElement("button");
  go.textContent = "移動";
  const err = document.createElement("div");
  err.className = "tree-path-error hidden";
  const submit = async () => {
    // エクスプローラーの「パスのコピー」は "C:\…" のように二重引用符で囲まれる。
    // そのまま貼ると存在しない扱いになるので、両端の引用符は外す。
    const path = input.value.trim().replace(/^"(.*)"$/, "$1").trim();
    if (!path) return;
    err.classList.add("hidden");
    go.disabled = true;
    const ok = await invoke<boolean>("dir_exists", { path }).catch(() => false);
    go.disabled = false;
    if (!ok) {
      // ネットワーク上の場所は、未接続・認証未了でもここに来る。
      err.textContent = "開けませんでした。パスと接続状態をご確認ください。";
      err.classList.remove("hidden");
      return;
    }
    await setTreeRoot(path, null);
  };
  go.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  wrap.append(input, go, err);
  return wrap;
}

// ツリーの表示起点を切り替える。highlightPathを指定すると、その項目を強調表示する。
async function setTreeRoot(dir: string, highlightPath: string | null) {
  pushTreeHistory({ kind: "dir", path: dir, highlight: highlightPath });
  treeAtPlaces = false;
  treeSortbar.classList.remove("hidden");
  treeRootDir = dir;
  treeHighlightPath = highlightPath;
  treeRootPathEl.textContent = dir;
  treeRootPathEl.title = dir;
  renderTree(); // 読み込み中表示を即座に見せる
  await fetchTreeDir(dir);
  // 取得している間に別の場所へ移っていたら、この結果では描かない
  // （「上へ」ボタンの状態も、移った先のものを上書きしてしまう）。
  if (treeAtPlaces || treeRootDir !== dir) return;
  // ドライブ直下（親が無い）でも「場所」一覧へ抜けられるので、上へは常に押せる。
  treeUpBtn.disabled = false;
  renderTree();
}

// 開いたファイル／フォルダ（アンカー）に応じてツリーの起点を更新する。
// アンカー自身の親フォルダを起点にし、アンカー自身をハイライトする。
async function setTreeRootForAnchor(anchor: string) {
  // ツリーは実在するパスしか扱えないので印を外す。
  const real = anchorPath(anchor);
  const parent = await invoke<string | null>("get_parent_dir", { path: real }).catch(() => null);
  await setTreeRoot(parent ?? real, real);
}

async function goTreeUp() {
  if (treeAtPlaces) return; // ここが最上位
  if (!treeRootDir) {
    await showPlaces();
    return;
  }
  const parent = await invoke<string | null>("get_parent_dir", { path: treeRootDir }).catch(() => null);
  // 親が無い＝ドライブ直下。ここからさらに上は「場所」一覧（別ドライブへの入口）。
  if (parent) await setTreeRoot(parent, treeHighlightPath);
  else await showPlaces();
}

// ---- ツリーの右クリックメニュー ----
// 項目はこの配列に足すだけで増やせるようにしてある（今後の機能追加のため）。
// enabled を省いた項目は常に表示・実行可能。
interface TreeMenuItem {
  label: (entry: TreeEntry) => string;
  enabled?: (entry: TreeEntry) => boolean;
  run: (entry: TreeEntry) => void | Promise<void>;
}

const TREE_MENU_ITEMS: TreeMenuItem[] = [
  {
    // 場所のお気に入り。本棚（本のお気に入り）とは役割を分けている。
    label: () => "お気に入りの場所に追加",
    enabled: (entry) => entry.isDir,
    run: async (entry) => {
      try {
        await invoke("add_favorite", { path: entry.path });
        await refreshFavorites();
      } catch (e) {
        alert("お気に入りに追加できませんでした: " + e);
      }
    },
  },
  {
    label: () => "本棚に追加",
    // 本＝アーカイブかフォルダ。単独の画像やテキストは本棚の対象にしない。
    enabled: (entry) => entry.isDir || entry.kind === "archive",
    run: async (entry) => {
      try {
        await invoke("add_path_to_shelf", { path: entry.path });
        if (shelfOpen) await buildShelfList();
        updateShelfAddBtnUi();
      } catch (e) {
        alert("本棚に追加できませんでした: " + e);
      }
    },
  },
];

const treeContextEl = document.querySelector<HTMLDivElement>("#tree-context")!;

function closeTreeContext() {
  treeContextEl.classList.add("hidden");
}

function openTreeContext(entry: TreeEntry, clientX: number, clientY: number) {
  treeContextEl.innerHTML = "";
  for (const item of TREE_MENU_ITEMS) {
    if (item.enabled && !item.enabled(entry)) continue;
    const btn = document.createElement("button");
    btn.textContent = item.label(entry);
    btn.addEventListener("click", async () => {
      closeTreeContext();
      await item.run(entry);
    });
    treeContextEl.appendChild(btn);
  }
  if (!treeContextEl.firstChild) return; // 出せる項目が無ければ開かない
  treeContextEl.classList.remove("hidden");
  // 画面外へはみ出さない位置に置く（右端・下端で折り返す）。
  const rect = treeContextEl.getBoundingClientRect();
  const x = Math.min(clientX, window.innerWidth - rect.width - 4);
  const y = Math.min(clientY, window.innerHeight - rect.height - 4);
  treeContextEl.style.left = `${Math.max(4, x)}px`;
  treeContextEl.style.top = `${Math.max(4, y)}px`;
}

// メニュー以外を押したら閉じる（メニュー自身の項目クリックは上で処理済み）。
window.addEventListener("mousedown", (e) => {
  if (!treeContextEl.classList.contains("hidden") && !treeContextEl.contains(e.target as Node)) {
    closeTreeContext();
  }
});

treeUpBtn.addEventListener("click", goTreeUp);

// 最上位（ドライブ一覧）へ一気に戻る。深い階層から「上へ」を連打せずに済む。
document.querySelector<HTMLButtonElement>("#tree-home-btn")?.addEventListener("click", showPlaces);

// 現在見ているファイル／フォルダの位置へ、ツリーの起点を戻す。
treeLocateBtn.addEventListener("click", () => {
  if (currentAnchor) setTreeRootForAnchor(currentAnchor);
});

// フォルダツリーパネルの表示/非表示を切り替える。
// ---- ツリーパネルの幅変更（境界のドラッグ） ----
const treeResizer = document.querySelector<HTMLDivElement>("#tree-resizer")!;
const TREE_WIDTH_MIN = 150;
let treeWidth = Number(localStorage.getItem("treeWidth")) || 260;

function applyTreeWidth(px: number) {
  // 表示領域を潰しきらないよう、画面幅の6割までに抑える。
  const max = Math.max(TREE_WIDTH_MIN, window.innerWidth * 0.6);
  treeWidth = clampNum(Math.round(px), TREE_WIDTH_MIN, max);
  treePanel.style.width = `${treeWidth}px`;
}
applyTreeWidth(treeWidth); // 前回の幅を復元

let treeResizing = false;
let treeResizeFramePending = false;
let treeResizePendingX = 0;

treeResizer.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault(); // ドラッグ中に文字が選択されるのを防ぐ
  treeResizing = true;
  treeResizer.classList.add("dragging");
});

window.addEventListener("mousemove", (e) => {
  if (!treeResizing) return;
  if (!(e.buttons & 1)) {
    treeResizing = false;
    treeResizer.classList.remove("dragging");
    return;
  }
  // 描画フレームに合わせて間引く（毎イベントで作り直すと画像の再計算が重なる）。
  treeResizePendingX = e.clientX;
  if (treeResizeFramePending) return;
  treeResizeFramePending = true;
  requestAnimationFrame(() => {
    treeResizeFramePending = false;
    applyTreeWidth(treeResizePendingX - treePanel.getBoundingClientRect().left);
    relayoutForViewerSize(); // 表示領域が狭まった分、画像や本文を合わせ直す
  });
});

window.addEventListener("mouseup", () => {
  if (!treeResizing) return;
  treeResizing = false;
  treeResizer.classList.remove("dragging");
  localStorage.setItem("treeWidth", String(treeWidth));
  relayoutForViewerSize();
});

document.querySelector<HTMLButtonElement>("#tree-toggle-btn")?.addEventListener("click", () => {
  treePanel.classList.toggle("hidden");
  // 境界はパネルと一緒に出し入れする。
  treeResizer.classList.toggle("hidden", treePanel.classList.contains("hidden"));
  relayoutForViewerSize();
  // まだ何も開いていない時に開いたら、行き先として「場所」一覧を出す
  // （従来は空のまま何も操作できなかった）。
  if (!treePanel.classList.contains("hidden") && !treeRootDir && !treeAtPlaces) {
    showPlaces();
  }
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
async function openArchive(path: string, reset = false, seq = beginOpenRequest()) {
  stopProgressPolling(); // 前のファイルの進捗表示が残らないようにする
  resumeDialog.classList.add("hidden"); // 再開確認ダイアログが出ていても、新規に開く操作を優先する
  try {
    const res = await invoke<{ count: number; initialIndex: number }>("open_archive", {
      path,
      reset,
      seq,
    });
    if (!isCurrentOpen(seq)) return; // 読み込み中に別のファイルが開かれた
    archiveGen++;
    releasePdf(); // PDF以外へ移るのでワーカーとバッファを解放する
    pageSource = "archive";
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
    closeStalePanels(); // 前の本を指したままのパネルを閉じる
    startProgressPolling();
    setOpeningPhase("1ページ目を読み込み中…");
    await render();
  } catch (e) {
    if (isSuperseded(e)) return; // 別のファイルが開かれたので捨てられただけ。失敗ではない
    alert("開けませんでした: " + e);
  }
}

// ---- 単独の画像ファイル／フォルダを開く ----
// 画像ファイルなら、その親フォルダの画像を一覧化してその位置から表示する。
// フォルダなら、その中の画像を先頭から表示する。サブフォルダがあれば、
// 含めて読み込むかを確認する。reset=true の場合は先頭ページから開く。
/// recursiveOverride を渡すと「下層も読み込むか」を確認せずその値で開く
/// （しおり・本棚・前回の続きから開く場合。選択は記録済みのため）。
async function openImageOrFolder(
  path: string,
  reset = false,
  seq = beginOpenRequest(),
  recursiveOverride?: boolean
) {
  stopProgressPolling(); // 前のファイルの進捗表示が残らないようにする
  resumeDialog.classList.add("hidden"); // 再開確認ダイアログが出ていても、新規に開く操作を優先する
  try {
    const shape = await invoke<{ hasSubfolders: boolean; hasDirectImages: boolean }>(
      "folder_shape",
      { path }
    );
    let recursive = recursiveOverride ?? false;
    if (shape.hasSubfolders && !shape.hasDirectImages) {
      // 直下に画像が無いので、下層を含めなければ1枚も開けない。尋ねる意味がない。
      recursive = true;
    } else if (recursiveOverride === undefined && shape.hasSubfolders) {
      recursive = await ask(
        "このフォルダには下層フォルダがあります。中の画像も読み込みますか？",
        { title: "MameViewer", kind: "info" }
      );
    }
    const res = await invoke<{
      count: number;
      initialIndex: number;
      dir: string;
      anchor: string;
    }>("open_folder", { path, recursive, reset, seq });
    if (!isCurrentOpen(seq)) return; // 読み込み中に別のファイルが開かれた
    archiveGen++;
    releasePdf(); // PDF以外へ移るのでワーカーとバッファを解放する
    pageSource = "archive";
    resetPageCache();
    pageCount = res.count;
    current = res.initialIndex;
    currentAnchor = res.anchor; // 下層込みなら印が付く（別の本として記憶する）
    updateWindowTitle();
    if (shelfOpen) updateShelfAddBtnUi(); // 別の本を開いたら追加/削除の表示を切り替える
    loadBookmarkedPages(); // この本のしおり位置をまとめて取得（以後はIPCなしで判定）
    setTreeRootForAnchor(res.dir);
    hint.style.display = "none";
    seek.disabled = false;
    seek.max = String(pageCount - 1);
    closeStalePanels(); // 前の本を指したままのパネルを閉じる
    startProgressPolling();
    setOpeningPhase("1ページ目を読み込み中…");
    await render();
  } catch (e) {
    if (isSuperseded(e)) return; // 別のファイルが開かれたので捨てられただけ。失敗ではない
    alert("開けませんでした: " + e);
  }
}

// ---- 開く要求の通し番号 ----
// 遅いファイルAを開いている最中に軽いファイルBを開くと、Bが先に表示された後で
// Aが完了して勝手にAへ切り替わってしまう。後から始まった方を正として、
// 古い要求の結果は静かに捨てる。
let openSeq = 0;
function beginOpenRequest(): number {
  // 画面が再読み込みされると変数は0に戻るが、Rust側の番号は下がらない。
  // 巻き戻ると以後すべての要求が「追い越された」と判定されて捨てられ、
  // 何を開いても無反応になる。時刻を下限にして必ず増え続けるようにする。
  openSeq = Math.max(openSeq + 1, Date.now());
  return openSeq;
}
function isCurrentOpen(seq: number): boolean {
  return seq === openSeq;
}
/// 途中で別のファイルが開かれた時にRust側が返す印。失敗ではないので警告は出さない。
const OPEN_SUPERSEDED = "__superseded__";
function isSuperseded(e: unknown): boolean {
  return String(e).includes(OPEN_SUPERSEDED);
}

// ---- PDFを開く ----
// ページの中身はpdf.jsが供給するが、ページ番号・履歴・しおりは画像と同じ仕組みに乗せる。
async function openPdf(path: string, reset = false, seq = beginOpenRequest()) {
  stopProgressPolling();
  resumeDialog.classList.add("hidden");
  try {
    // 実際に開くコマンドを呼ばないので、番号だけ先にRustへ伝える
    // （追い越されたアーカイブ読み込みをRust側でも捨てられるようにするため）。
    invoke("note_open_seq", { seq }).catch(() => {});
    const lib = await loadPdfLib();
    const buf = await invoke<ArrayBuffer>("read_file_bytes", { path });
    const task = lib.getDocument({ data: new Uint8Array(buf) }) as unknown as PdfLoadingTask;
    let doc: PdfDoc;
    try {
      doc = (await task.promise) as PdfDoc;
    } catch (err) {
      await task.destroy().catch(() => {}); // 壊れたPDFでもワーカーを残さない
      throw err;
    }
    if (!isCurrentOpen(seq)) {
      // 読み込み中に別のファイルが開かれた。開いたワーカーとPDF全体の
      // バッファを解放してから抜ける（放置するとスレッドが漏れる）。
      await task.destroy().catch(() => {});
      return;
    }
    // 読めてから前のアーカイブを閉じる。残したままだとサムネイル一覧・しおりの絵・
    // 同梱テキストが「前の本のもの」になる。先に閉じると、壊れたPDFを開こうとした
    // だけで、画面は前の本のまま中身が消えてめくれなくなる。
    await invoke("close_archive", { seq }).catch(() => {});
    if (!isCurrentOpen(seq)) {
      await task.destroy().catch(() => {});
      return;
    }
    // 前のPDFの読み込みタスクを片付けてから差し替える（ワーカーを残さないため）。
    await releasePdf();
    pdfLoadingTask = task;
    pdfDoc = doc;
    pageSource = "pdf";
    archiveGen++;
    resetPageCache();
    pageCount = doc.numPages;
    // 読書位置の記憶はRust側の履歴をそのまま使う（アンカーはPDFのパス）。
    let initial = 0;
    if (!reset) {
      const h = await invoke<{ positions: Record<string, number> }>("get_history");
      if (!isCurrentOpen(seq)) return; // 待っている間に別のファイルが開かれた
      initial = Math.min(h.positions[path] ?? 0, Math.max(0, pageCount - 1));
    }
    current = initial;
    currentAnchor = path;
    updateWindowTitle();
    if (shelfOpen) updateShelfAddBtnUi();
    loadBookmarkedPages();
    setTreeRootForAnchor(path);
    hint.style.display = "none";
    seek.disabled = false;
    seek.max = String(pageCount - 1);
    closeStalePanels(); // 前の本を指したままのパネルを閉じる
    setOpeningPhase("1ページ目を読み込み中…");
    await render();
  } catch (e) {
    if (isSuperseded(e)) return; // 別のファイルが開かれたので捨てられただけ。失敗ではない
    alert("開けませんでした: " + e);
  }
}

// 拡張子からアーカイブ／PDF／テキスト／画像・フォルダのどの開き方をすべきか振り分ける。
/// fromAnchor=true のときは、しおり・本棚・前回の続きから開く場合。
/// この場合はフォルダの「下層も読み込むか」が既に決まっているので確認しない
/// （確認を挟むと、記録した時と違う選択をされてページ番号が食い違う）。
async function openPath(path: string, reset = false, fromAnchor = false) {
  // 印はディスク上に存在しないので、実際に開くパスからは外しておく。
  const real = fromAnchor ? anchorPath(path) : path;
  const recursive = fromAnchor ? isRecursiveAnchor(path) : (inheritRecursive ?? undefined);
  // ネットワーク上の大きなファイルは開き終わるまで数十秒かかることがある。
  // その間、選択したことが画面に出ないと「押しても反応しない」と見えるため、
  // 待ちに入る前に、選んだ項目と読み込み中であることを先に表示する。
  const seq = beginOpenRequest();
  beginOpening(real, seq);
  try {
    const ext = extOf(real);
    if (ARCHIVE_EXTS.includes(ext)) {
      await openArchive(real, reset, seq);
    } else if (ext === "pdf") {
      await openPdf(real, reset, seq);
    } else if (TEXT_EXTS.includes(ext)) {
      await openTextFile(real, reset, seq);
    } else {
      await openImageOrFolder(real, reset, seq, recursive);
    }
  } finally {
    endOpening(seq); // 自分が出した表示だけを消す
  }
}

// ---- 開いている最中の表示 ----
// ネットワーク上のファイルは開き終わるまで時間がかかる。何も出ないと
// 固まったように見えるため、選んだ項目と「読み込み中」を先に見せる。
const loadingNote = document.querySelector<HTMLDivElement>("#loading-note")!;
const loadingName = document.querySelector<HTMLSpanElement>("#loading-name")!;
const loadingPhase = document.querySelector<HTMLSpanElement>("#loading-phase")!;
const loadingStep = document.querySelector<HTMLSpanElement>("#loading-step")!;

// バイト数を読みやすい単位にする。
function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// 今この表示を出している要求の番号。別経路（フォルダ選択ダイアログや
// 再開ダイアログ）が通し番号だけ進めた場合でも、表示を出した本人が
// 消せるようにしておく（持ち主を見ないと表示が消えずに残る）。
let loadingNoteSeq = 0;

function beginOpening(path: string, seq: number) {
  loadingNoteSeq = seq;
  treeLoadingPath = path;
  treeHighlightPath = path; // 選んだ項目をその場で選択状態にする
  // 「場所」一覧の表示中は renderTree() が一覧を消してしまうため触らない。
  if (!treeAtPlaces) renderTree();
  loadingName.textContent = basenameOf(path);
  setOpeningPhase("開いています…");
  loadingStep.textContent = "";
  loadingStep.classList.add("hidden");
  loadingNote.classList.remove("hidden");
  // ファイルの大きさが分かると、待ちが長い理由が伝わる（取得は軽いので先に出す）。
  invoke<number>("get_file_size", { path })
    .then((size) => {
      if (treeLoadingPath === path && size > 0) {
        loadingName.textContent = `${basenameOf(path)}（${formatBytes(size)}）`;
      }
    })
    .catch(() => {});
  startReadProgressPolling();
}

// 読み出し中のページについて「読めた量／全体量」を出し続ける。
// 段階の文言だけだと、遅い回線では止まって見えるため、数字が動くことで
// 進んでいると分かるようにする。
let readProgressTimer: number | undefined;
function startReadProgressPolling() {
  window.clearInterval(readProgressTimer);
  readProgressTimer = window.setInterval(async () => {
    try {
      const p = await invoke<{
        done: number;
        total: number;
        unit: string;
        stepLabel: string;
        stepDone: number;
        stepTotal: number;
      }>("get_read_progress");

      // 上段：大きな段取り（内部アーカイブの何個目か等）。中を1個処理するたびに
      // 下段は始め直されるため、全体のどのあたりかは上段で保つ。
      loadingStep.textContent = p.stepLabel
        ? `${p.stepLabel} ${p.stepDone.toLocaleString()} / ${p.stepTotal.toLocaleString()}`
        : "";
      loadingStep.classList.toggle("hidden", !p.stepLabel);

      if (!p.unit) return; // 細かい計測は走っていない
      if (p.unit === "bytes") {
        const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        setOpeningPhase(
          `読み込み中 ${formatBytes(p.done)} / ${formatBytes(p.total)}（${pct}%）`
        );
      } else {
        // 件数。総数が分からない形式（Rar）は実数だけを出す。
        const n = p.done.toLocaleString();
        setOpeningPhase(
          p.total > 0
            ? `ファイルを確認中 ${n} / ${p.total.toLocaleString()} 件`
            : `ファイルを確認中 ${n} 件`
        );
      }
    } catch {
      stopReadProgressPolling();
    }
  }, 200); // 数字が動いて見える程度の間隔
}

function stopReadProgressPolling() {
  window.clearInterval(readProgressTimer);
  readProgressTimer = undefined;
}

// 今どの段階にいるかを出す。所要時間は読めないが、段階が進むこと自体が
// 「止まっていない」証拠になるため、節目ごとに文言を差し替える。
function setOpeningPhase(text: string) {
  loadingPhase.textContent = text;
}

function endOpening(seq: number) {
  if (loadingNoteSeq !== seq) return; // 後から始まった読み込みの表示は消さない
  treeLoadingPath = null;
  stopReadProgressPolling();
  loadingNote.classList.add("hidden");
  if (!treeAtPlaces) renderTree();
  // 開いた時点で「最後に開いた本」として記録する。ページを送るまで記録しないと、
  // 開いてすぐ閉じた場合に次回の再開が前の本に戻ってしまう。
  schedulePositionSave();
}

// ---- 巻移動 ----
// 現在の巻(currentAnchor)と同じフォルダにある他の巻（アーカイブファイル／
// サブフォルダ）を自然順で前後に辿る。端に達していれば何もしない。
// landAtEnd=true の場合、移動先の巻を開いた後に最終ページへジャンプする
// （ページ末端に達したことで自動的に前の巻へ遡る場合に、続きから自然に読めるように）。
// 巻移動が重ならないようにする。端で連打すると複数の移動が同時に走り、
// 最後に開いた本とは別の本の末尾を指してしまう。
let volumeMoving = false;
/// 巻移動の最中だけ、フォルダの「下層も読み込むか」をこの値で引き継ぐ。
/// null の間は通常どおり（必要なら確認する）。
let inheritRecursive: boolean | null = null;

/// dir=1 で次の巻、-1 で前の巻へ。
/// landAtEnd=true なら移動先の最終ページへ（遡って読み続ける時）。
/// fromStart=true なら移動先を1ページ目から開く（読み進めて次の巻へ渡る時）。
async function goVolume(dir: 1 | -1, landAtEnd = false, fromStart = false) {
  if (!currentAnchor || volumeMoving) return;
  volumeMoving = true;
  try {
    const volumes = await invoke<string[]>("list_volumes", { anchor: currentAnchor });
    // 一覧は実在パス。アンカーに印が付いている場合は外して突き合わせる。
    const idx = volumes.indexOf(anchorPath(currentAnchor));
    if (idx < 0) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= volumes.length) return;
    const target = volumes[nextIdx];
    // 巻移動は読み進めている流れの途中。ここで「下層も読み込むか」を尋ねると
    // 流れが止まるので、今読んでいる巻と同じ選択を引き継ぐ
    // （直下に画像が無いフォルダは、開く側が自動で下層込みにする）。
    inheritRecursive = isRecursiveAnchor(currentAnchor);
    try {
      await openPath(target, fromStart);
    } finally {
      inheritRecursive = null;
    }
    // 開けたかを確かめる。失敗しても openPath は例外を投げないため、
    // 確認せずに進めると「読んでいた本」が最終ページへ飛んでしまう。
    if (landAtEnd && currentAnchor !== null && anchorPath(currentAnchor) === target && pageCount > 0) {
      current = pageCount - 1;
      schedulePositionSave();
      render();
    }
  } catch (e) {
    console.error("巻移動に失敗:", e);
  } finally {
    volumeMoving = false;
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
        name: "アーカイブ・画像・PDF・テキスト",
        extensions: [...ARCHIVE_EXTS, ...IMAGE_EXTS, "pdf", ...TEXT_EXTS],
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
  if (shelfOpen) return; // 本棚を開いている間は引っ込めない（土台ごと消えてしまう）
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
  else if (act === "texts") openTextsPanel();
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

// 実際に動いているアプリのバージョン（tauri.conf.json の version）を表示する。
getVersion()
  .then((v) => {
    document.querySelector<HTMLParagraphElement>("#about-version")!.textContent =
      `バージョン ${v}`;
  })
  .catch((e) => console.error("バージョン取得に失敗:", e));

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
  refreshKeyLabels(); // メニューやボタンの「(B)」等の表記も合わせる
}

/// メニュー項目やボタンに出しているキー表記を、現在の割り当てから書き直す。
/// 固定文字で書いていると、割り当てを変えた後も古いキーを案内し続けるため。
function refreshKeyLabels() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-key-of]")) {
    applyKeyLabel(el);
  }
}

/// 1つの要素にキー表記を反映する。
function applyKeyLabel(el: HTMLElement) {
  const id = el.dataset.keyOf as ActionId;
  const b = keymap[id];
  if (!b) return;
  const extra = el.dataset.keyExtra ? ` / ${el.dataset.keyExtra}` : "";
  const inner = b.key ? formatKeyLabel(b) + extra : el.dataset.keyExtra || "";
  const suffix = inner ? ` (${inner})` : "";
  const titleBase = el.dataset.titleBase;
  if (titleBase !== undefined) {
    const title = titleBase + suffix;
    if (el.title !== title) el.title = title;
    return;
  }
  // 初回の文字列を基準として覚えておく（二度目以降に重ねて付けないため）。
  if (el.dataset.labelBase === undefined) el.dataset.labelBase = el.textContent ?? "";
  const label = el.dataset.labelBase + suffix;
  if (el.textContent !== label) el.textContent = label;
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

/// 開いているドロップダウンの位置を、今のボタン位置に合わせて置き直す。
function repositionOpenMenus() {
  const pairs: [HTMLElement, string][] = [
    [menu, "#menu-btn"],
    [settingsMenu, "#settings-menu-btn"],
    [displayMenu, "#display-menu-btn"],
  ];
  for (const [menuEl, btnSel] of pairs) {
    if (menuEl.classList.contains("hidden")) continue;
    const btn = document.querySelector<HTMLElement>(btnSel);
    if (btn) positionMenuAboveButton(menuEl, btn);
  }
}

// ---- 回転・フィットモード・綴じ方向・見開き ----
function cycleRotation() {
  rotation = (rotation + 90) % 360;
  resetZoom(); // フィット変更・見開き切替と挙動を揃える
  localStorage.setItem("rotation", String(rotation));
  panX = 0;
  panY = 0;
  applyLayoutSettled();
  updateRotationUi();
  // ミニマップは「隠れていたものが出た瞬間」しか作り直さないので、
  // 出たままの状態で回した時はここから作り直す。
  updateNavigatorThumb();
}

/// 回転の状態をメニューに出す。次の起動まで保持される設定なので、
/// 表示が斜めのまま起動した時に理由が分かるようにしておく。
function updateRotationUi() {
  const btn = displayMenu.querySelector<HTMLButtonElement>('[data-act="rotate"]');
  if (!btn) return;
  btn.textContent = rotation === 0 ? "回転（クリックで90°ずつ）" : `回転 ${rotation}°（クリックで90°ずつ）`;
  btn.classList.toggle("active", rotation !== 0);
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
updateRotationUi();
refreshKeyLabels();
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
  // 見開き・綴じ方向・回転と同じく、次の起動でも同じ大きさで開けるようにする。
  localStorage.setItem("thumbSize", String(px));
}

// 前回の大きさを復元する（スライダーの初期値にも反映する）。
{
  const saved = Number(localStorage.getItem("thumbSize"));
  if (saved) {
    const min = Number(thumbSize.min);
    const max = Number(thumbSize.max);
    thumbSize.value = String(clampNum(saved, min, max));
  }
  setThumbSize(Number(thumbSize.value));
}

function adjustThumb(delta: number) {
  const min = Number(thumbSize.min);
  const max = Number(thumbSize.max);
  const v = Math.max(min, Math.min(max, Number(thumbSize.value) + delta));
  thumbSize.value = String(v);
  setThumbSize(v);
}

// 別の本を開いた時、前の本の内容を指したまま残るパネルを閉じる。
// 開きっぱなしだと前の本の一覧が出続けるうえ、開閉フラグのせいで
// クリックやキー操作も封じられたままになる。
function closeStalePanels() {
  if (gridOpen) closeGrid();
  if (bmOpen) closeBookmarks();
  if (textsOpen) closeTextsPanel();
}

function openGrid() {
  if (pageCount === 0) return;
  if (pageSource === "text") return; // 本文にはページの絵が無い
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
    const blob = await fetchThumbBlob(idx);
    if (gen !== gridGen) return;
    const url = URL.createObjectURL(blob);
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

// 現在の本のしおり。ページ送りのたびにRust側へ問い合わせるとIPC往復が
// ページ数分積み重なるため、本を開いた時に一度だけ取得して保持する。
// 記録値（画像=ページ番号／本文=文字位置）と、今のレイアウトでの表示ページを分けて持つ。
// 本文は組み直すとページ番号が変わるため、表示ページの方は作り直す必要がある。
let bookmarkedKeys = new Set<number>();
let bookmarkedPages = new Set<number>();

/// 記録値から今のページ番号を引き直す（本文の組み直し後・しおり取得後に呼ぶ）。
function recomputeBookmarkedPages() {
  bookmarkedPages = new Set([...bookmarkedKeys].map(pageOfPositionKey));
  updateBookmarkBtnUi();
}

async function loadBookmarkedPages() {
  // 比較対象はローカルに控える。共有の変数どうしを比べると、後から始まった
  // 呼び出しが両方を書き換えてしまい、判定が永久に成立しない。
  const anchor = currentAnchor;
  bookmarkedKeys = new Set();
  bookmarkedPages = new Set();
  if (!anchor) return;
  try {
    const list = await invoke<BookmarkView[]>("list_bookmarks", { anchor });
    if (anchor !== currentAnchor) return; // 取得中に別の本へ切り替わった
    for (const b of list) bookmarkedKeys.add(b.page);
  } catch (e) {
    console.error("しおり情報の取得に失敗:", e);
  }
  recomputeBookmarkedPages();
}

function updateBookmarkBtnUi() {
  const marked = currentAnchor !== null && pageCount > 0 && bookmarkedPages.has(current);
  bookmarkBtn.classList.toggle("marked", marked);
  // 説明文だけ差し替え、キーの表記は refreshKeyLabels に任せる
  // （ここで固定の「(B)」を書くと、割り当てを変えても古いキーを案内し続ける）。
  bookmarkBtn.dataset.titleBase = marked
    ? "このページのしおりを外すのだ"
    : "このページにしおりを挟むのだ";
  applyKeyLabel(bookmarkBtn); // ページ送りごとに呼ばれるので、このボタンだけ更新する
}

/// 今のページに対応する記録値。本文は、組み直しで文字位置が少しずれても
/// 「このページに載っているしおり」を拾えるよう、既存の記録値を優先して返す。
function bookmarkKeyForCurrentPage(): number {
  if (pageSource === "text") {
    for (const k of bookmarkedKeys) {
      if (textPageOfOffset(k) === current) return k;
    }
  }
  return positionKeyOf(current);
}

async function toggleBookmark() {
  if (!currentAnchor || pageCount === 0) return;
  try {
    const key = bookmarkKeyForCurrentPage();
    const existingId = await invoke<number | null>("find_bookmark", {
      anchor: currentAnchor,
      page: key,
    });
    if (existingId != null) {
      await invoke("remove_bookmark", { id: existingId });
      bookmarkedKeys.delete(key);
    } else {
      await invoke("add_bookmark", { anchor: currentAnchor, page: key });
      bookmarkedKeys.add(key);
    }
    if (bmOpen) await buildBookmarksList();
    recomputeBookmarkedPages();
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

const shelfEl = document.querySelector<HTMLDivElement>("#shelf")!;
const shelfScrollEl = document.querySelector<HTMLDivElement>("#shelf-scroll")!;
const shelfAddBtn = document.querySelector<HTMLButtonElement>("#shelf-add-btn")!;
const shelfClearBrokenBtn = document.querySelector<HTMLButtonElement>("#shelf-clear-broken")!;

async function buildShelfList() {
  try {
    const items = await invoke<ShelfItemView[]>("list_shelf");
    shelfScrollEl.innerHTML = "";
    shelfClearBrokenBtn.classList.toggle("hidden", !items.some((i) => !i.exists));
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
      // 絵を作れない種類（PDF・テキスト）では空で返る。壊れた画像を出さない。
      if (item.thumbBase64) img.src = `data:image/jpeg;base64,${item.thumbBase64}`;
      else img.classList.add("no-thumb");
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
          openPath(item.anchor, false, true); // 登録時の「下層込み」の選択をそのまま使う
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
  const anchor = currentAnchor; // 問い合わせている間に別の本へ移ることがある
  const inShelf = await invoke<boolean>("is_in_shelf", { anchor }).catch(() => false);
  if (anchor !== currentAnchor) return; // 別の本の答えでボタンを書き換えない
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

// 見つからなくなった本をまとめて外す（しおり一覧と同じ導線）。
// 外付けドライブやネットワークの本を並べていると、少しずつ死んだ項目が溜まるため。
shelfClearBrokenBtn.addEventListener("click", async () => {
  const items = await invoke<ShelfItemView[]>("list_shelf").catch(() => []);
  const broken = items.filter((i) => !i.exists);
  if (broken.length === 0) return;
  const ok = await ask(`見つからない本 ${broken.length} 件を本棚から外します。よろしいですか？`, {
    title: "MameViewer",
    kind: "warning",
  });
  if (!ok) return;
  for (const i of broken) {
    await invoke("remove_from_shelf", { anchor: i.anchor }).catch(() => {});
  }
  await buildShelfList();
  updateShelfAddBtnUi();
});

async function toggleShelf(force?: boolean) {
  shelfOpen = force ?? !shelfOpen;
  shelfEl.classList.toggle("hidden", !shelfOpen);
  if (shelfOpen) {
    // 本棚は下部バーの上に出るため、バーも一緒に見せたままにする。
    // 予約済みの引っ込め処理を取り消さないと、1.4秒後に土台だけ消えてしまう。
    window.clearTimeout(barTimer);
    bar.classList.add("show");
    await buildShelfList();
    updateShelfAddBtnUi();
  } else {
    flashBar(); // 閉じたら通常どおり少し見せてから引っ込める
  }
}

document.querySelector<HTMLButtonElement>("#shelf-btn")!.addEventListener("click", () => toggleShelf());
document.querySelector<HTMLButtonElement>("#shelf-close")!.addEventListener("click", () => toggleShelf(false));

async function jumpToBookmark(bm: BookmarkView) {
  closeBookmarks();
  if (bm.anchor !== currentAnchor) {
    await openPath(bm.anchor, false, true); // しおりを付けた時と同じ開き方に揃える
    // 開けなかった場合にそのまま進めると、読んでいた本が別のページへ飛ぶ。
    if (currentAnchor !== bm.anchor) return;
  }
  jump(pageOfPositionKey(bm.page)); // 本文は文字位置で記録しているので今のページ番号へ換算
}

/// しおりの位置の見せ方。本文は文字位置で記録しているため、
/// 今開いている本文ならページ番号へ換算し、そうでなければ文字位置のまま示す
/// （別の本のページ数は、その本を開かないと分からない）。
function bookmarkPositionLabel(bm: BookmarkView): string {
  const isText = TEXT_EXTS.includes(extOf(anchorPath(bm.anchor)));
  if (!isText) return `${bm.page + 1}ページ`;
  if (bm.anchor === currentAnchor && pageSource === "text") {
    return `${textPageOfOffset(bm.page) + 1}ページ`;
  }
  return `${bm.page + 1}文字目`;
}

function renderBookmarkCell(bm: BookmarkView): HTMLDivElement {
  const cell = document.createElement("div");
  cell.className = "bm-cell" + (bm.exists ? "" : " broken");

  const img = document.createElement("img");
  if (bm.thumbBase64) img.src = `data:image/jpeg;base64,${bm.thumbBase64}`;
  else img.classList.add("no-thumb");
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
  name.textContent = `${bm.fileName}　${bookmarkPositionLabel(bm)}`;
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
    // パネル表示中は背後のページを送らない（そのパネル内のスクロールに任せる）
    if (helpOpen || keybindOpen || aboutOpen || bmOpen || textsOpen) return;
    if (onUi(e)) return; // フォルダツリー等のUI上ではページめくりせず、その要素のスクロールに任せる
    if (gridOpen) {
      if (e.ctrlKey) {
        e.preventDefault();
        adjustThumb(e.deltaY < 0 ? 10 : -10);
      }
      return;
    }
    // S1（サイド奥ボタン）を押しながら、またはCtrlを押しながらのホイールはズーム。
    // タッチパッドのピンチもCtrl付きのホイールとして届く。
    if (s1Down || e.ctrlKey) {
      e.preventDefault();
      if (s1Down) s1UsedForZoom = true;
      zoomAt(e.clientX, e.clientY, wheelZoomFactor(e));
      return;
    }
    // S2（サイド手前ボタン）を押しながらのホイールは巻送り。
    if (s2Down) {
      s2UsedForVolume = true;
      if (e.deltaY > 0) goNextVolume();
      else if (e.deltaY < 0) goPrevVolume();
      return;
    }
    const steps = wheelPageSteps(e);
    for (let i = 0; i < Math.abs(steps); i++) turnPage(steps > 0 ? 1 : -1);
  },
  { passive: false }
);

// ---- ホイール量の扱い ----
// マウスのホイールは1ノッチで大きな量（ピクセル換算で100前後）が1回届く。
// 一方タッチパッドは、1回なぞるだけで細かい量のイベントが数十回届く。
// 1イベント＝1ページにすると、タッチパッドでは一度なぞっただけで数十ページ飛び、
// 巻末を越えて次の巻まで進んでしまう。そこで、大きな量は従来どおり1回で1ページ、
// 細かい量は溜めて「1ノッチ分」に達するごとに1ページ、とする。
// （マウスの操作感は変えず、タッチパッドだけを量に比例させる）
const WHEEL_NOTCH = 100; // 1ノッチ相当の量（ピクセル換算）
const WHEEL_NOTCH_MIN = 50; // これ以上は1回でマウスの1ノッチとみなす
let wheelAcc = 0;
let wheelLastAt = 0;

/// ホイール量をピクセル換算にそろえる（行単位・ページ単位で届く環境もあるため）。
function wheelPixels(e: WheelEvent): number {
  if (e.deltaMode === 1) return e.deltaY * 33; // 行単位
  if (e.deltaMode === 2) return e.deltaY * WHEEL_NOTCH; // ページ単位
  return e.deltaY;
}

/// このイベントで送るページ数（符号付き）。
function wheelPageSteps(e: WheelEvent): number {
  const dy = wheelPixels(e);
  if (dy === 0) return 0;
  if (Math.abs(dy) >= WHEEL_NOTCH_MIN) {
    wheelAcc = 0;
    return Math.sign(dy); // マウスの1ノッチ：従来どおり1ページ
  }
  const now = performance.now();
  // 向きが変わった／間が空いた時は溜まった端数を捨てる（前の操作を持ち越さない）
  if (now - wheelLastAt > 250 || Math.sign(dy) !== Math.sign(wheelAcc)) wheelAcc = 0;
  wheelLastAt = now;
  wheelAcc += dy;
  const steps = Math.trunc(wheelAcc / WHEEL_NOTCH);
  wheelAcc -= steps * WHEEL_NOTCH;
  return steps;
}

/// ズームの倍率。マウスの1ノッチは従来どおり1段、細かい量（ピンチ等）は量に比例させる。
/// 比例させないと、ピンチ1回で数十段ぶん拡大され、一瞬で最大倍率に張り付く。
function wheelZoomFactor(e: WheelEvent): number {
  const dy = wheelPixels(e);
  if (Math.abs(dy) >= WHEEL_NOTCH_MIN) return dy < 0 ? ZOOM_WHEEL_STEP : 1 / ZOOM_WHEEL_STEP;
  return Math.pow(ZOOM_WHEEL_STEP, -dy / WHEEL_NOTCH);
}

// UI領域（バー・メニュー・一覧・案内）上のクリックはページ送りに使わない
function onUi(e: Event): boolean {
  return !!(e.target as HTMLElement).closest(
    "#tree-panel, #tree-resizer, #tree-context, #shelf, #bar, #topbar, #menu, #display-menu, #settings-menu, #grid, #hint, #bookmarks, #resume-dialog, #help, #keybind, #about, #navigator-panel, #texts"
  );
}

// ボタンを押した時点でUI上かどうかを控えておく。
// ツリーの行を押すと、その処理の中で一覧が作り直されるため、click が window へ
// 届く頃には押した要素が既にDOMから外れている。その状態では closest() が親を
// 辿れず「画像上のクリック」と誤判定され、意図せずページが送られてしまう。
// 押した瞬間ならDOMは元のままなので、ここで判定して記録しておく。
let pressedOnUi = false;
// ツリー上で押したかどうかも同時に控える（サイドボタンの行き先を分けるため）。
let pressedOnTree = false;
window.addEventListener(
  "mousedown",
  (e) => {
    pressedOnUi = onUi(e);
    pressedOnTree = !!(e.target as HTMLElement).closest("#tree-panel");
  },
  true // 他のどの処理よりも先に記録する
);

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
  if (e.button === 0 && !gridOpen && !textsOpen && !onUi(e) && canPan()) {
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
      justPannedAt = Date.now();
    }
    return;
  }
  if (e.button === 3) {
    s1Down = false;
  }
  if (e.button === 4) {
    s2Down = false;
  }
  // ツリー上ではサイドボタンを「見ていた場所へ戻る／進む」に割り当てる
  // （エクスプローラーと同じ操作感。画像の上では従来どおりページ送り）。
  if (pressedOnTree) {
    if (e.button === 3) {
      e.preventDefault();
      s1UsedForZoom = false;
      treeGoBack();
    } else if (e.button === 4) {
      e.preventDefault();
      s2UsedForVolume = false;
      treeGoForward();
    }
    return;
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
  if (Date.now() - justPannedAt < PAN_CLICK_GUARD_MS) {
    justPannedAt = 0; // パン直後のクリックはページめくりに使わない
    return;
  }
  if (gridOpen || bmOpen || helpOpen || keybindOpen || aboutOpen || textsOpen) return;
  if (pressedOnUi || onUi(e)) return; // パネル上で押した場合はページ送りに使わない
  // 本文をドラッグして文字を選んだ直後の click はページ送りに使わない。
  // 送ってしまうと選んだ範囲ごと次のページへ流れ、コピーできない。
  // （普通のクリックは押した瞬間に選択が畳まれるので、ここには掛からない）
  if (pageSource === "text") {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
  }
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
  if (gridOpen || bmOpen || helpOpen || keybindOpen || aboutOpen || textsOpen) return;
  if (pressedOnUi || onUi(e)) return;
  turnPage(-1);
});

// キーボード
window.addEventListener("keydown", (e) => {
  // 文字を入力している最中はキー割り当てを発火させない。
  // これが無いと、パス入力欄に打った a・d・b などが操作として奪われ、
  // preventDefault で文字そのものが入らなくなる（入力欄が使えなくなる）。
  const target = e.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  ) {
    return;
  }
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
  if (textsOpen) {
    if (e.key === "Escape") closeTextsPanel();
    return;
  }
  // 再開確認ダイアログ表示中は、選ばれる前にページ操作が走らないようにする
  // （選択待ちの裏でめくられると、再開位置が分からなくなる）。
  if (!resumeDialog.classList.contains("hidden")) {
    if (e.key === "Escape") resumeDialog.classList.add("hidden");
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
  // ウィンドウの外でボタンを離すと mouseup が届かず、押下状態が固着する。
  // 固着すると「ホイールがズームや巻送りのまま戻らない」「ボタンを押して
  // いないのにミニマップやツリー幅が追従し続ける」といった状態になる。
  panning = false;
  s1Down = false;
  s2Down = false;
  navDragging = false;
  treeResizing = false;
  treeResizer.classList.remove("dragging");
  justPannedAt = 0;
  viewer.style.cursor = canPan() ? "grab" : "";
  flushPositionSave(); // 閉じる・切り替える直前に読書位置を確定させる
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

    // もう無いファイルを勧めない（消した・外付けを外した本で「続きから」を
    // 押すとエラーになるだけなので、最初から出さない）。
    if (lastOpened && !(await invoke<boolean>("path_exists", { path: lastOpened }))) {
      return;
    }
    if (lastOpened) {
      const page = h.positions[lastOpened] ?? 0;
      resumeName.textContent =
        basenameOf(anchorPath(lastOpened)) +
        (isRecursiveAnchor(lastOpened) ? "（下層込み）" : "");
      resumePage.textContent = String(page + 1);
      resumeDialog.classList.remove("hidden");

      const continueBtn = document.querySelector<HTMLButtonElement>("#resume-continue")!;
      const restartBtn = document.querySelector<HTMLButtonElement>("#resume-restart")!;
      continueBtn.onclick = () => {
        resumeDialog.classList.add("hidden");
        openPath(lastOpened, false, true); // 前回と同じ開き方（下層込みの有無）で
      };
      restartBtn.onclick = async () => {
        resumeDialog.classList.add("hidden");
        // openPath と同じ振り分けを使う（PDF・テキストを取りこぼさないため）。
        await openPath(lastOpened, true, true);
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
