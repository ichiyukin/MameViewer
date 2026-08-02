use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering as AtomicOrd};
use std::sync::{mpsc, Arc, LazyLock, Mutex};

/// アーカイブ形式（拡張子で判定）。Folder は単独画像・フォルダを開いた場合。
#[derive(Clone, Copy, PartialEq)]
enum Format {
    Zip,
    Rar,
    SevenZ,
    /// フォルダ直読み。entries には画像ファイルの絶対パスをそのまま格納する。
    Folder,
}

/// 入れ子アーカイブ（アーカイブ内のZip/Rar/7z）への参照。
#[derive(Clone)]
struct InnerRef {
    /// 外側アーカイブ内でのエントリ名（並び順のグループ化キーにも使う）。
    outer_name: String,
    format: Format,
    /// 内部Rarのみ：unrarクレートがファイルパスを要求するため、
    /// 開いた時点で一時ファイルへ展開してそのパスを保持する。
    temp_path: Option<PathBuf>,
}

/// 1ページの所在。container が None ならアーカイブ直下（またはフォルダのファイル）、
/// Some なら入れ子アーカイブの中の画像。
#[derive(Clone)]
struct PageEntry {
    container: Option<InnerRef>,
    name: String,
}

impl PageEntry {
    fn direct(name: String) -> Self {
        Self { container: None, name }
    }
    /// 並び順のキー。入れ子の画像は「内部アーカイブ名/画像名」として比較することで、
    /// 内部アーカイブ（＝巻）毎にまとまった読書順になる。
    fn sort_key(&self) -> String {
        match &self.container {
            Some(c) => format!("{}/{}", c.outer_name, self.name),
            None => self.name.clone(),
        }
    }
}

/// 現在開いているアーカイブの状態。
struct ArchiveState {
    path: PathBuf,
    format: Format,
    /// ページエントリを自然順（入れ子は内部アーカイブ毎にまとめて）ソートして保持。
    entries: Vec<PageEntry>,
}

static ARCHIVE: LazyLock<Mutex<Option<ArchiveState>>> = LazyLock::new(|| Mutex::new(None));

/// 入れ子アーカイブの展開済みバイト列キャッシュ（直近2つのLRU）。
/// ページ読み出しのたびに外側アーカイブから内部アーカイブ全体を取り出すのは
/// 重すぎるため、直近に使った内部アーカイブを丸ごとメモリに保持する。
/// 2つなのは「読書中の巻」と「境界をまたいだ隣の巻」を同時に持てるようにするため。
static INNER_CACHE: LazyLock<Mutex<Vec<(String, Arc<Vec<u8>>)>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));
const INNER_CACHE_CAP: usize = 2;

// ---- 履歴・巻移動 ----
// 「巻（アーカイブファイル or フォルダ）」ごとの最終閲覧ページを記憶し、
// 起動時の自動再開・巻間移動時の位置復元に使う。
// 保存先は %APPDATA%\MameViewer\history.json（Tauriの path API は AppHandle が
// 必要でこの環境では cargo test を壊すため使わず、環境変数から直接求める）。

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct HistoryData {
    /// 最後に開いていた「巻」の識別パス（アーカイブファイルパス or フォルダパス）。
    #[serde(rename = "lastOpened")]
    last_opened: Option<String>,
    /// 巻ごとの最終閲覧ページ（0始まり）。キーは last_opened と同じ識別パス。
    positions: HashMap<String, usize>,
    /// 巻末に達した時の挙動："loop"（同じ巻の先頭へ）または "next"（次の巻へ）。
    #[serde(rename = "endBehavior", default = "default_end_behavior")]
    end_behavior: String,
}

fn default_end_behavior() -> String {
    "loop".to_string()
}

fn history_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("MameViewer").join("history.json")
}

fn load_history_from_disk() -> HistoryData {
    let path = history_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn persist_history(h: &HistoryData) {
    let path = history_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(h) {
        let _ = std::fs::write(&path, json);
    }
}

static HISTORY: LazyLock<Mutex<HistoryData>> = LazyLock::new(|| Mutex::new(load_history_from_disk()));

/// 起動時などにフロントが履歴全体を取得する。
#[tauri::command]
fn get_history() -> HistoryData {
    HISTORY.lock().unwrap().clone()
}

/// 現在のページ位置を「巻」ごとに記憶し、最後に開いた巻としても記録する。
#[tauri::command]
fn save_position(anchor: String, page: usize) -> Result<(), String> {
    let mut h = HISTORY.lock().unwrap();
    h.positions.insert(anchor.clone(), page);
    h.last_opened = Some(anchor);
    persist_history(&h);
    Ok(())
}

/// 巻末に達した時の挙動（ループ／次の巻へ）を設定する。
#[tauri::command]
fn set_end_behavior(mode: String) -> Result<(), String> {
    let mut h = HISTORY.lock().unwrap();
    h.end_behavior = mode;
    persist_history(&h);
    Ok(())
}

// ---- 画質設定（リサイズフィルター） ----
// 保存先は %APPDATA%\MameViewer\settings.json（history.jsonと同じ理由でAppHandle不使用）。

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ResizeSettings {
    /// true＝おまかせ（縮小=Lanczos3・拡大=バイキュービックを自動選択）。
    auto: bool,
    #[serde(rename = "shrinkFilter")]
    shrink_filter: String,
    #[serde(rename = "enlargeFilter")]
    enlarge_filter: String,
    /// 0で無効。resize後にimageクレートのunsharpenを適用する強さ（sigma）。
    unsharp: f32,
}

impl Default for ResizeSettings {
    fn default() -> Self {
        Self {
            auto: true,
            shrink_filter: "lanczos3".to_string(),
            enlarge_filter: "bicubic".to_string(),
            unsharp: 0.0,
        }
    }
}

fn settings_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("MameViewer").join("settings.json")
}

fn load_settings_from_disk() -> ResizeSettings {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn persist_settings(s: &ResizeSettings) {
    let path = settings_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(&path, json);
    }
}

static SETTINGS: LazyLock<Mutex<ResizeSettings>> =
    LazyLock::new(|| Mutex::new(load_settings_from_disk()));

#[tauri::command]
fn get_settings() -> ResizeSettings {
    SETTINGS.lock().unwrap().clone()
}

#[tauri::command]
fn set_settings(settings: ResizeSettings) -> Result<(), String> {
    persist_settings(&settings);
    *SETTINGS.lock().unwrap() = settings;
    RESIZED_CACHE.lock().unwrap().clear(); // フィルター変更後は再生成させる
    Ok(())
}

/// 縮小/拡大かに応じて使うフィルター名を決める（おまかせ or 詳細設定）。
fn resolve_filter(settings: &ResizeSettings, nw: u32, nh: u32, tw: u32, th: u32) -> String {
    let shrinking = (tw as u64) * (th as u64) < (nw as u64) * (nh as u64);
    if settings.auto {
        if shrinking { "lanczos3" } else { "bicubic" }.to_string()
    } else if shrinking {
        settings.shrink_filter.clone()
    } else {
        settings.enlarge_filter.clone()
    }
}

fn filter_algorithm(name: &str) -> fast_image_resize::ResizeAlg {
    use fast_image_resize::{FilterType, ResizeAlg};
    match name {
        "nearest" => ResizeAlg::Nearest,
        "bilinear" => ResizeAlg::Convolution(FilterType::Bilinear),
        "mitchell" => ResizeAlg::Convolution(FilterType::Mitchell),
        "lanczos3" => ResizeAlg::Convolution(FilterType::Lanczos3),
        "box" => ResizeAlg::Convolution(FilterType::Box),
        _ => ResizeAlg::Convolution(FilterType::CatmullRom), // "bicubic"
    }
}

/// RGB画像を指定フィルターで指定サイズへリサイズする。
fn resize_with_filter(
    rgb: image::RgbImage,
    target_w: u32,
    target_h: u32,
    filter_name: &str,
) -> Result<image::RgbImage, String> {
    use fast_image_resize as fr;
    let (src_w, src_h) = rgb.dimensions();
    let src_image = fr::images::Image::from_vec_u8(src_w, src_h, rgb.into_raw(), fr::PixelType::U8x3)
        .map_err(|e| e.to_string())?;
    let mut dst_image = fr::images::Image::new(target_w, target_h, fr::PixelType::U8x3);
    let mut resizer = fr::Resizer::new();
    let options = fr::ResizeOptions::new().resize_alg(filter_algorithm(filter_name));
    resizer
        .resize(&src_image, &mut dst_image, &options)
        .map_err(|e| e.to_string())?;
    image::RgbImage::from_raw(target_w, target_h, dst_image.into_vec())
        .ok_or_else(|| "リサイズ後のバッファ変換に失敗".to_string())
}

/// リサイズ済みページのキャッシュ（(ページ, 幅, 高さ) -> JPEGバイト列）。
static RESIZED_CACHE: LazyLock<Mutex<HashMap<(usize, u32, u32), Arc<Vec<u8>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// ページを実際にデコード・指定サイズへリサイズしてJPEGへエンコードする（重い処理）。
fn render_page_resized(index: usize, width: u32, height: u32) -> Result<Vec<u8>, String> {
    let raw = read_page_bytes(index)?;
    let img = image::load_from_memory(&raw[..]).map_err(|e| format!("画像デコード失敗: {e}"))?;
    let (nw, nh) = (img.width(), img.height());
    let settings = SETTINGS.lock().unwrap().clone();
    let filter = resolve_filter(&settings, nw, nh, width.max(1), height.max(1));
    let resized_rgb = resize_with_filter(img.to_rgb8(), width.max(1), height.max(1), &filter)?;
    let mut dynamic = image::DynamicImage::ImageRgb8(resized_rgb);
    if settings.unsharp > 0.0 {
        dynamic = dynamic.unsharpen(settings.unsharp, 2);
    }
    let mut out = Cursor::new(Vec::new());
    dynamic
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .map_err(|e| e.to_string())?;
    Ok(out.into_inner())
}

/// 指定ページを指定サイズへリサイズして返す（別スレッド実行・キャッシュ・世代ガード付き）。
#[tauri::command]
async fn get_page_resized(index: usize, width: u32, height: u32) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = (index, width, height);
        if let Some(b) = RESIZED_CACHE.lock().unwrap().get(&key).cloned() {
            return Ok(tauri::ipc::Response::new((*b).clone()));
        }
        let gen = THUMB_GEN.load(AtomicOrd::Relaxed);
        let bytes = render_page_resized(index, width, height)?;
        // デコード・リサイズの間に別アーカイブへ切り替わっていた場合はキャッシュへ書き込まない
        // （サムネイルキャッシュと同じ、切替時の混入を防ぐ世代ガード）。
        if THUMB_GEN.load(AtomicOrd::Relaxed) == gen {
            RESIZED_CACHE.lock().unwrap().insert(key, Arc::new(bytes.clone()));
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ページの実寸だけを軽量に返す（ヘッダーのみ読み、フルデコードしない）。
#[tauri::command]
/// 幅・高さに加え、GIF（アニメーションの可能性がある形式）かどうかを返す。
/// GIFはリサイズすると静止画になり自動再生を失うため、フロント側は表示時に
/// リサイズをスキップして原寸のまま表示する（ブラウザの標準再生に任せる）。
async fn get_page_dims(index: usize) -> Result<(u32, u32, bool), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = read_page_bytes(index)?;
        let reader = image::ImageReader::new(Cursor::new(&raw[..]))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let is_gif = matches!(reader.format(), Some(image::ImageFormat::Gif));
        let (w, h) = reader.into_dimensions().map_err(|e| e.to_string())?;
        Ok((w, h, is_gif))
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- ブックマーク（しおり） ----
// 全ファイル横断で一覧できるよう、サムネイルを埋め込んで保存する
// （元ファイルが移動・削除されても一覧上で中身が分かるように）。
// 保存先は history.json と同じ %APPDATA%\MameViewer\ 配下。

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Bookmark {
    id: u64,
    anchor: String,
    page: usize,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "fileSize")]
    file_size: u64,
    #[serde(rename = "thumbBase64")]
    thumb_base64: String,
}

/// フロントへ返す表示用ビュー。exists はアンカーが今も存在するか（削除優先UIの判定に使う）。
#[derive(serde::Serialize)]
struct BookmarkView {
    id: u64,
    anchor: String,
    page: usize,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "thumbBase64")]
    thumb_base64: String,
    exists: bool,
}

fn bookmarks_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("MameViewer").join("bookmarks.json")
}

fn load_bookmarks_from_disk() -> Vec<Bookmark> {
    std::fs::read_to_string(bookmarks_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn persist_bookmarks(list: &[Bookmark]) {
    let path = bookmarks_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(list) {
        let _ = std::fs::write(&path, json);
    }
}

static BOOKMARKS: LazyLock<Mutex<Vec<Bookmark>>> =
    LazyLock::new(|| Mutex::new(load_bookmarks_from_disk()));

/// 同名・同サイズのファイルが新しい場所で開かれた時、移動先へ自動でリンクし直す。
/// フォルダ（サイズ比較が意味を持たない）は対象外。
fn try_relink_bookmarks(new_path: &str) {
    let Ok(meta) = std::fs::metadata(new_path) else {
        return;
    };
    if meta.is_dir() {
        return;
    }
    let size = meta.len();
    let name = Path::new(new_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut list = BOOKMARKS.lock().unwrap();
    let mut changed = false;
    for b in list.iter_mut() {
        if b.anchor != new_path
            && !Path::new(&b.anchor).exists()
            && b.file_name == name
            && b.file_size == size
        {
            b.anchor = new_path.to_string();
            changed = true;
        }
    }
    if changed {
        persist_bookmarks(&list);
    }
}

fn add_bookmark_sync(anchor: String, page: usize) -> Result<BookmarkView, String> {
    let thumb = make_thumbnail(page)?;
    let thumb_base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &*thumb);
    let file_name = Path::new(&anchor)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let file_size = std::fs::metadata(&anchor)
        .ok()
        .filter(|m| !m.is_dir())
        .map(|m| m.len())
        .unwrap_or(0);

    let mut list = BOOKMARKS.lock().unwrap();
    let id = list.iter().map(|b| b.id).max().unwrap_or(0) + 1;
    let bm = Bookmark {
        id,
        anchor,
        page,
        file_name,
        file_size,
        thumb_base64,
    };
    list.push(bm.clone());
    persist_bookmarks(&list);
    Ok(BookmarkView {
        id: bm.id,
        anchor: bm.anchor,
        page: bm.page,
        file_name: bm.file_name,
        thumb_base64: bm.thumb_base64,
        exists: true,
    })
}

/// 現在のページをしおりとして登録する（サムネイルを生成し埋め込む）。
#[tauri::command]
async fn add_bookmark(anchor: String, page: usize) -> Result<BookmarkView, String> {
    tauri::async_runtime::spawn_blocking(move || add_bookmark_sync(anchor, page))
        .await
        .map_err(|e| e.to_string())?
}

/// 指定したしおりを削除する。
#[tauri::command]
fn remove_bookmark(id: u64) -> Result<(), String> {
    let mut list = BOOKMARKS.lock().unwrap();
    list.retain(|b| b.id != id);
    persist_bookmarks(&list);
    Ok(())
}

/// しおり一覧を返す。anchor を指定すればそのファイルのみ、省略すれば全ファイル横断。
#[tauri::command]
fn list_bookmarks(anchor: Option<String>) -> Vec<BookmarkView> {
    let list = BOOKMARKS.lock().unwrap();
    list.iter()
        .filter(|b| anchor.as_deref().map_or(true, |a| b.anchor == a))
        .map(|b| BookmarkView {
            id: b.id,
            anchor: b.anchor.clone(),
            page: b.page,
            file_name: b.file_name.clone(),
            thumb_base64: b.thumb_base64.clone(),
            exists: Path::new(&b.anchor).exists(),
        })
        .collect()
}

/// 現在のページが既にしおり登録済みか調べる（ボタン/キーのトグル判定用）。
#[tauri::command]
fn find_bookmark(anchor: String, page: usize) -> Option<u64> {
    BOOKMARKS
        .lock()
        .unwrap()
        .iter()
        .find(|b| b.anchor == anchor && b.page == page)
        .map(|b| b.id)
}

// ---- 本棚（本＝ファイル/フォルダ単位のお気に入り） ----
// しおり（ページ単位）とは別に、「また読みたい本」を表紙付きで並べておくための機能。
// 保存先は bookmarks.json と同じ %APPDATA%\MameViewer\ 配下。

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct ShelfItem {
    /// 本の識別パス（アーカイブファイル or フォルダの基点パス）。
    anchor: String,
    #[serde(rename = "fileName")]
    file_name: String,
    /// 表紙サムネイル（登録時のページ）。元ファイルが消えても一覧で中身が分かるように埋め込む。
    #[serde(rename = "thumbBase64")]
    thumb_base64: String,
    /// 登録日時（UNIXエポック秒）。新しい順に並べるため。
    #[serde(rename = "addedAt", default)]
    added_at: u64,
}

/// フロントへ返す表示用ビュー。exists はアンカーが今も存在するか。
#[derive(serde::Serialize)]
struct ShelfItemView {
    anchor: String,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "thumbBase64")]
    thumb_base64: String,
    exists: bool,
}

fn shelf_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(base).join("MameViewer").join("shelf.json")
}

fn load_shelf_from_disk() -> Vec<ShelfItem> {
    std::fs::read_to_string(shelf_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn persist_shelf(list: &[ShelfItem]) {
    let path = shelf_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(list) {
        let _ = std::fs::write(&path, json);
    }
}

static SHELF: LazyLock<Mutex<Vec<ShelfItem>>> = LazyLock::new(|| Mutex::new(load_shelf_from_disk()));

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 現在の本を本棚に追加する（既に登録済みなら表紙だけ更新）。page は表紙に使うページ番号。
#[tauri::command]
async fn add_to_shelf(anchor: String, page: usize) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let thumb = make_thumbnail(page)?;
        let thumb_base64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &*thumb);
        let file_name = Path::new(&anchor)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut list = SHELF.lock().unwrap();
        if let Some(existing) = list.iter_mut().find(|s| s.anchor == anchor) {
            existing.thumb_base64 = thumb_base64;
        } else {
            list.push(ShelfItem {
                anchor,
                file_name,
                thumb_base64,
                added_at: now_epoch_secs(),
            });
        }
        persist_shelf(&list);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn remove_from_shelf(anchor: String) -> Result<(), String> {
    let mut list = SHELF.lock().unwrap();
    list.retain(|s| s.anchor != anchor);
    persist_shelf(&list);
    Ok(())
}

/// 本棚の一覧を、登録が新しい順に返す。
#[tauri::command]
fn list_shelf() -> Vec<ShelfItemView> {
    let list = SHELF.lock().unwrap();
    let mut items: Vec<&ShelfItem> = list.iter().collect();
    items.sort_by(|a, b| b.added_at.cmp(&a.added_at));
    items
        .into_iter()
        .map(|s| ShelfItemView {
            anchor: s.anchor.clone(),
            file_name: s.file_name.clone(),
            thumb_base64: s.thumb_base64.clone(),
            exists: Path::new(&s.anchor).exists(),
        })
        .collect()
}

/// 指定の本が本棚に登録済みか（ボタンのトグル表示用）。
#[tauri::command]
fn is_in_shelf(anchor: String) -> bool {
    SHELF.lock().unwrap().iter().any(|s| s.anchor == anchor)
}

/// サムネイルのキャッシュ（ページ番号 -> JPEGバイト列）。アーカイブを開くたびにクリア。
static THUMBS: LazyLock<Mutex<HashMap<usize, Arc<Vec<u8>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// サムネイル生成時の最大長辺（px）。実際の表示サイズはフロント側でCSS縮小する。
const THUMB_MAX: u32 = 360;

/// サムネイル事前生成の世代番号。アーカイブを開き直すたびに増やし、旧世代の生成を中断させる。
static THUMB_GEN: AtomicU64 = AtomicU64::new(0);

/// サムネイル事前生成の進捗（完了数・総数）。フロントはこれをポーリングして
/// 読み込み中の進捗バーを表示する（プッシュ通知ではなくポーリング方式）。
static THUMB_DONE: AtomicUsize = AtomicUsize::new(0);
static THUMB_TOTAL: AtomicUsize = AtomicUsize::new(0);

/// 対応画像拡張子か判定。
fn is_image(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]
        .iter()
        .any(|e| l.ends_with(e))
}

/// 拡張子からアーカイブ形式を判定。
fn detect_format(path: &str) -> Result<Format, String> {
    let l = path.to_ascii_lowercase();
    if l.ends_with(".zip") || l.ends_with(".cbz") {
        Ok(Format::Zip)
    } else if l.ends_with(".rar") || l.ends_with(".cbr") {
        Ok(Format::Rar)
    } else if l.ends_with(".7z") || l.ends_with(".cb7") {
        Ok(Format::SevenZ)
    } else {
        Err("対応していないファイル形式です（Zip/Rar/7z）".into())
    }
}

/// 自然順比較（"2" < "10" となるよう数字の連なりは数値として比較）。
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let a = a.to_ascii_lowercase();
    let b = b.to_ascii_lowercase();
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    let mut na = String::new();
                    while let Some(&c) = ai.peek() {
                        if c.is_ascii_digit() {
                            na.push(c);
                            ai.next();
                        } else {
                            break;
                        }
                    }
                    let mut nb = String::new();
                    while let Some(&c) = bi.peek() {
                        if c.is_ascii_digit() {
                            nb.push(c);
                            bi.next();
                        } else {
                            break;
                        }
                    }
                    let va: u128 = na.trim_start_matches('0').parse().unwrap_or(0);
                    let vb: u128 = nb.trim_start_matches('0').parse().unwrap_or(0);
                    match va.cmp(&vb) {
                        Ordering::Equal => match na.len().cmp(&nb.len()) {
                            Ordering::Equal => {}
                            o => return o,
                        },
                        o => return o,
                    }
                } else {
                    match ca.cmp(&cb) {
                        Ordering::Equal => {
                            ai.next();
                            bi.next();
                        }
                        o => return o,
                    }
                }
            }
        }
    }
}

// ---- 形式別：エントリ一覧 ----

/// アーカイブ内の全ファイル名を列挙する（画像・入れ子アーカイブ等の選別は呼び出し側）。
fn list_zip(path: &str) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|e| format!("ファイルを開けません: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Zipを読めません: {e}"))?;
    let mut entries = Vec::new();
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_file() {
            entries.push(f.name().to_string());
        }
    }
    Ok(entries)
}

fn list_rar(path: &str) -> Result<Vec<String>, String> {
    let archive = unrar::Archive::new(path)
        .open_for_listing()
        .map_err(|e| format!("Rarを読めません: {e}"))?;
    let mut entries = Vec::new();
    for entry in archive {
        let e = entry.map_err(|e| e.to_string())?;
        if e.is_file() {
            entries.push(e.filename.to_string_lossy().to_string());
        }
    }
    Ok(entries)
}

fn list_7z(path: &str) -> Result<Vec<String>, String> {
    let sz = sevenz_rust::SevenZReader::open(path, sevenz_rust::Password::empty())
        .map_err(|e| format!("7zを読めません: {e}"))?;
    let mut entries = Vec::new();
    for entry in &sz.archive().files {
        if !entry.is_directory() {
            entries.push(entry.name().to_string());
        }
    }
    Ok(entries)
}

/// メモリ上のZipバイト列から全ファイル名を列挙する（入れ子アーカイブ用）。
fn list_zip_bytes(bytes: &[u8]) -> Result<Vec<String>, String> {
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Zipを読めません: {e}"))?;
    let mut entries = Vec::new();
    for i in 0..zip.len() {
        let f = zip.by_index(i).map_err(|e| e.to_string())?;
        if f.is_file() {
            entries.push(f.name().to_string());
        }
    }
    Ok(entries)
}

/// メモリ上のZipバイト列から1エントリを読み出す（入れ子アーカイブ用）。
fn read_zip_entry_bytes(bytes: &[u8], name: &str) -> Result<Vec<u8>, String> {
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Zipを読めません: {e}"))?;
    let mut entry = zip.by_name(name).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// メモリ上の7zバイト列から全ファイル名を列挙する（入れ子アーカイブ用）。
fn list_7z_bytes(bytes: &[u8]) -> Result<Vec<String>, String> {
    let sz = sevenz_rust::SevenZReader::new(
        Cursor::new(bytes),
        bytes.len() as u64,
        sevenz_rust::Password::empty(),
    )
    .map_err(|e| format!("7zを読めません: {e}"))?;
    let mut entries = Vec::new();
    for entry in &sz.archive().files {
        if !entry.is_directory() {
            entries.push(entry.name().to_string());
        }
    }
    Ok(entries)
}

/// メモリ上の7zバイト列から1エントリを読み出す（入れ子アーカイブ用）。
fn read_7z_entry_bytes(bytes: &[u8], name: &str) -> Result<Vec<u8>, String> {
    let mut sz = sevenz_rust::SevenZReader::new(
        Cursor::new(bytes),
        bytes.len() as u64,
        sevenz_rust::Password::empty(),
    )
    .map_err(|e| format!("7zを読めません: {e}"))?;
    let mut out: Option<Vec<u8>> = None;
    sz.for_each_entries(|entry, reader| {
        if !entry.is_directory() && entry.name() == name {
            let mut buf = Vec::new();
            reader.read_to_end(&mut buf)?;
            out = Some(buf);
            Ok(false)
        } else {
            Ok(true)
        }
    })
    .map_err(|e| e.to_string())?;
    out.ok_or_else(|| "エントリが見つかりません".into())
}

/// path が指すファイル/フォルダから、対象となる基点フォルダを求める。
/// ファイルならその親フォルダ、フォルダ自身ならそのままを返す。
fn resolve_base_dir(path: &Path) -> Result<PathBuf, String> {
    if path.is_dir() {
        Ok(path.to_path_buf())
    } else {
        path.parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "親フォルダが見つかりません".to_string())
    }
}

// ---- フォルダツリーパネル ----

#[derive(serde::Serialize)]
struct TreeEntry {
    name: String,
    path: String,
    #[serde(rename = "isDir")]
    is_dir: bool,
    /// アイコン種別："folder" | "archive" | "image" | "other"（isDir=trueの時は無視）。
    kind: String,
    /// 更新日時（UNIXエポック秒）。取得できない場合は0。フロントの並び替えに使う。
    mtime: u64,
    /// ファイルサイズ（バイト）。フォルダは0。フロントの並び替えに使う。
    size: u64,
}

fn entry_kind(name: &str, is_dir: bool) -> String {
    if is_dir {
        "folder".to_string()
    } else if is_archive_ext(name) {
        "archive".to_string()
    } else if is_image(name) {
        "image".to_string()
    } else {
        "other".to_string()
    }
}

/// 指定フォルダ直下（非再帰）のエントリ一覧を、フォルダ優先＋自然順で返す。
/// サイドパネルのツリー表示用（クリック時に遅延で子フォルダを取得する）。
#[tauri::command]
async fn list_tree_dir(path: String) -> Result<Vec<TreeEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = Path::new(&path);
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = p.is_dir();
            // メタ情報が読めない項目（アクセス権限等）は 0 扱いにして一覧から落とさない。
            let meta = entry.metadata().ok();
            let mtime = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let size = if is_dir {
                0
            } else {
                meta.as_ref().map(|m| m.len()).unwrap_or(0)
            };
            let te = TreeEntry {
                path: p.to_string_lossy().to_string(),
                kind: entry_kind(&name, is_dir),
                name,
                is_dir,
                mtime,
                size,
            };
            if is_dir {
                dirs.push(te);
            } else {
                files.push(te);
            }
        }
        dirs.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        files.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        dirs.extend(files);
        Ok(dirs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// path の親フォルダのパスを返す（ツリーの「上へ」ボタン用）。無ければNone。
#[tauri::command]
fn get_parent_dir(path: String) -> Option<String> {
    Path::new(&path)
        .parent()
        .filter(|p| p.as_os_str().len() > 0)
        .map(|p| p.to_string_lossy().to_string())
}

/// dir 直下にサブフォルダが存在するか（非再帰・浅い確認）。
fn has_subfolders_in(dir: &Path) -> Result<bool, String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.path().is_dir() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// フォルダ内の画像を列挙する（絶対パスの文字列で返す）。
/// recursive=true なら全階層のサブフォルダも含める。
/// 自然順ソート（呼び出し側で実施）によりパス文字列で比較されるため、
/// 同じサブフォルダの画像同士は自然にまとまる（アーカイブファイル毎の並びに近い挙動）。
fn list_folder(dir: &Path, recursive: bool) -> Result<Vec<String>, String> {
    let mut entries = Vec::new();
    if recursive {
        for entry in walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_file() {
                let s = p.to_string_lossy().to_string();
                if is_image(&s) {
                    entries.push(s);
                }
            }
        }
    } else {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let p = entry.path();
            if p.is_file() {
                let s = p.to_string_lossy().to_string();
                if is_image(&s) {
                    entries.push(s);
                }
            }
        }
    }
    Ok(entries)
}

/// 拡張子がアーカイブ形式（Zip/Rar/7z及びcbz/cbr/cb7）か判定。
fn is_archive_ext(path: &str) -> bool {
    let l = path.to_ascii_lowercase();
    [".zip", ".cbz", ".rar", ".cbr", ".7z", ".cb7"]
        .iter()
        .any(|e| l.ends_with(e))
}

/// anchor（アーカイブファイルパス or フォルダパス）の親フォルダを走査し、
/// 「巻」として開けるもの（アーカイブファイル・サブフォルダ）を自然順で列挙する。
/// 巻移動（前の巻/次の巻）はこの一覧の中を前後に辿る。
fn list_volumes_sync(anchor: &str) -> Result<Vec<String>, String> {
    let p = PathBuf::from(anchor);
    let parent = p
        .parent()
        .ok_or_else(|| "親フォルダが見つかりません".to_string())?;
    let mut volumes = Vec::new();
    for entry in std::fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ep = entry.path();
        let s = ep.to_string_lossy().to_string();
        if ep.is_dir() || is_archive_ext(&s) {
            volumes.push(s);
        }
    }
    volumes.sort_by(|a, b| natural_cmp(a, b));
    Ok(volumes)
}

#[tauri::command]
async fn list_volumes(anchor: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_volumes_sync(&anchor))
        .await
        .map_err(|e| e.to_string())?
}

// ---- 形式別：1エントリ読み出し ----

fn read_zip_entry(path: &PathBuf, name: &str) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut entry = zip.by_name(name).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(entry.size() as usize);
    entry.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn read_rar_entry(path: &PathBuf, name: &str) -> Result<Vec<u8>, String> {
    let mut cursor = unrar::Archive::new(path)
        .open_for_processing()
        .map_err(|e| e.to_string())?;
    loop {
        match cursor.read_header().map_err(|e| e.to_string())? {
            Some(header) => {
                let entry_name = header.entry().filename.to_string_lossy().to_string();
                if entry_name == name {
                    let (data, _) = header.read().map_err(|e| e.to_string())?;
                    return Ok(data);
                }
                cursor = header.skip().map_err(|e| e.to_string())?;
            }
            None => return Err("エントリが見つかりません".into()),
        }
    }
}

fn read_7z_entry(path: &PathBuf, name: &str) -> Result<Vec<u8>, String> {
    let mut sz = sevenz_rust::SevenZReader::open(path, sevenz_rust::Password::empty())
        .map_err(|e| e.to_string())?;
    let mut out: Option<Vec<u8>> = None;
    sz.for_each_entries(|entry, reader| {
        if !entry.is_directory() && entry.name() == name {
            let mut buf = Vec::new();
            reader.read_to_end(&mut buf)?;
            out = Some(buf);
            Ok(false) // 見つかったので走査終了
        } else {
            Ok(true)
        }
    })
    .map_err(|e| e.to_string())?;
    out.ok_or_else(|| "エントリが見つかりません".into())
}

/// フォルダ形式の場合、entry はそのまま絶対パスなので直接読み込む。
fn read_folder_entry(path_str: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path_str).map_err(|e| e.to_string())
}

/// 外側アーカイブから名前指定で1エントリのバイト列を取り出す（形式別ディスパッチ）。
fn read_entry_from(path: &PathBuf, format: Format, name: &str) -> Result<Vec<u8>, String> {
    match format {
        Format::Zip => read_zip_entry(path, name),
        Format::Rar => read_rar_entry(path, name),
        Format::SevenZ => read_7z_entry(path, name),
        Format::Folder => read_folder_entry(name),
    }
}

// ---- 入れ子アーカイブ（アーカイブ内のZip/Rar/7z）対応 ----

/// この起動中プロセス専用の一時フォルダ（内部Rarの展開先）。
fn nested_temp_dir() -> Result<PathBuf, String> {
    let d = std::env::temp_dir()
        .join("MameViewer_nested")
        .join(std::process::id().to_string());
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// 別のファイルを開く時に、前のファイルに紐づくキャッシュ類を破棄する。
/// 開く処理（open_archive / open_folder / テストの open_sync）から必ず呼ぶこと。
/// ここで捨て損ねると、ページ番号が同じ「前のファイルの中身」を返してしまう。
fn clear_nested_state() {
    INNER_CACHE.lock().unwrap().clear();
    RECENT_PAGES.lock().unwrap().clear();
    let d = std::env::temp_dir()
        .join("MameViewer_nested")
        .join(std::process::id().to_string());
    let _ = std::fs::remove_dir_all(d);
}

/// 内部アーカイブの展開済みバイト列を取得する（LRUキャッシュ経由）。
/// キャッシュmiss時は外側アーカイブから該当エントリを丸ごと読み出す。
/// 読み出し中はロックを保持しない（他ページの取得を塞がないため）。
fn get_inner_bytes(
    outer_path: &PathBuf,
    outer_format: Format,
    inner: &InnerRef,
) -> Result<Arc<Vec<u8>>, String> {
    {
        let mut c = INNER_CACHE.lock().unwrap();
        if let Some(pos) = c.iter().position(|(k, _)| k == &inner.outer_name) {
            let e = c.remove(pos);
            let bytes = e.1.clone();
            c.push(e); // 末尾＝最新（LRU更新）
            return Ok(bytes);
        }
    }
    let bytes = Arc::new(read_entry_from(outer_path, outer_format, &inner.outer_name)?);
    let mut c = INNER_CACHE.lock().unwrap();
    if !c.iter().any(|(k, _)| k == &inner.outer_name) {
        c.push((inner.outer_name.clone(), bytes.clone()));
        while c.len() > INNER_CACHE_CAP {
            c.remove(0);
        }
    }
    Ok(bytes)
}

/// 外側アーカイブ内の1つの内部アーカイブを展開し、その中の画像をページとして列挙する。
fn expand_inner_archive(
    outer_path: &str,
    outer_format: Format,
    inner_name: &str,
) -> Result<Vec<PageEntry>, String> {
    let inner_format = detect_format(inner_name)?;
    let bytes = read_entry_from(&PathBuf::from(outer_path), outer_format, inner_name)?;
    let (names, temp_path): (Vec<String>, Option<PathBuf>) = match inner_format {
        Format::Zip => (list_zip_bytes(&bytes)?, None),
        Format::SevenZ => (list_7z_bytes(&bytes)?, None),
        Format::Rar => {
            // unrarはメモリ上のバイト列を扱えないため一時ファイルに書き出して使う。
            // ファイル名は衝突しないようエントリ名を平坦化して付ける。
            let flat: String = inner_name
                .chars()
                .map(|c| if matches!(c, '/' | '\\' | ':') { '_' } else { c })
                .collect();
            let tmp = nested_temp_dir()?.join(flat);
            std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
            (list_rar(&tmp.to_string_lossy())?, Some(tmp))
        }
        Format::Folder => unreachable!("detect_format は Folder を返さない"),
    };
    Ok(names
        .into_iter()
        .filter(|n| is_image(n))
        .map(|n| PageEntry {
            container: Some(InnerRef {
                outer_name: inner_name.to_string(),
                format: inner_format,
                temp_path: temp_path.clone(),
            }),
            name: n,
        })
        .collect())
}

/// アーカイブを開いて全ページエントリを構築し、読書順にソートして返す。
/// 直下の画像に加え、1階層までの入れ子アーカイブの中の画像も列挙する。
/// 読めない内部アーカイブはスキップする（1つの破損で全体を開けなくしない）。
fn build_sorted_entries(path: &str, format: Format) -> Result<Vec<PageEntry>, String> {
    let names = match format {
        Format::Zip => list_zip(path)?,
        Format::Rar => list_rar(path)?,
        Format::SevenZ => list_7z(path)?,
        Format::Folder => unreachable!("detect_format は Folder を返さない"),
    };
    let mut entries: Vec<PageEntry> = Vec::new();
    for name in names {
        if is_image(&name) {
            entries.push(PageEntry::direct(name));
        } else if is_archive_ext(&name) {
            match expand_inner_archive(path, format, &name) {
                Ok(mut inner) => entries.append(&mut inner),
                Err(e) => eprintln!("内部アーカイブをスキップ: {name}: {e}"),
            }
        }
    }
    // 並び順キーを先に計算してからソート（比較のたびに文字列を組み立てない）。
    let mut keyed: Vec<(String, PageEntry)> =
        entries.into_iter().map(|e| (e.sort_key(), e)).collect();
    keyed.sort_by(|a, b| natural_cmp(&a.0, &b.0));
    Ok(keyed.into_iter().map(|(_, e)| e).collect())
}

// ---- サムネイル事前生成（開いた直後から裏で全ページ分を作っておく） ----

/// 生バイト列からサムネイルJPEGを作りキャッシュへ格納（失敗は黙って無視）。
/// `gen` は取得開始時点の世代番号。デコードに時間がかかる間に別アーカイブへ
/// 切り替わっていた場合（挿入直前に世代不一致）は、書き込まずに破棄する。
/// これを怠ると、切替後のファイルのサムネイル一覧に前のファイルの画像が
/// 混入するバグになる（デコードが完了した時点で新アーカイブのキャッシュへ
/// 誤って書き込んでしまうため）。
fn store_thumb_from_bytes(gen: u64, index: usize, raw: &[u8]) {
    if THUMBS.lock().unwrap().contains_key(&index) {
        return;
    }
    let Ok(img) = image::load_from_memory(raw) else {
        return;
    };
    let thumb = img.thumbnail(THUMB_MAX, THUMB_MAX);
    let rgb = thumb.to_rgb8();
    let mut out = Cursor::new(Vec::new());
    if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .is_err()
    {
        return;
    }
    if THUMB_GEN.load(AtomicOrd::Relaxed) != gen {
        return; // 挿入直前に別アーカイブへ切り替わっていた（世代不一致）
    }
    THUMBS
        .lock()
        .unwrap()
        .insert(index, Arc::new(out.into_inner()));
}

/// アーカイブを1パス走査し、全ページのサムネイルを並列生成する。
/// 世代番号が変わったら（別ファイルを開いたら）即座に中断する。
/// 進捗（完了数/総数）は THUMB_DONE/THUMB_TOTAL に書き込む。フロントは
/// get_thumb_progress コマンドでこれをポーリングして進捗バーを表示する
/// （Tauriのイベント通知は使わない。AppHandle をコマンド引数に含めると
/// このプロジェクトの環境では cargo test 実行バイナリが Windows 上で
/// STATUS_ENTRYPOINT_NOT_FOUND で異常終了する問題があったため、
/// プレーンな戻り値のポーリング方式に変更している）。
fn pregen_thumbnails(gen: u64) {
    // 開いた直後は、最初のページの表示・先読みにCPUとディスクを譲る。
    // ここで即座に全ページのサムネイル生成を始めると、大きなアーカイブでは
    // 数千ページ分のデコードが一斉に走り、操作を受け付けないほど重くなる。
    std::thread::sleep(std::time::Duration::from_millis(1200));
    if THUMB_GEN.load(AtomicOrd::Relaxed) != gen {
        return; // 待っている間に別のファイルへ切り替わった
    }
    let (path, format, entries) = {
        let guard = ARCHIVE.lock().unwrap();
        let Some(st) = guard.as_ref() else { return };
        (st.path.clone(), st.format, st.entries.clone())
    };
    let total = entries.len();
    let canceled = || THUMB_GEN.load(AtomicOrd::Relaxed) != gen;
    // 既にキャッシュ済み（オンデマンド生成等）の分を初期値として数える。
    let completed = Arc::new(AtomicUsize::new(THUMBS.lock().unwrap().len()));
    THUMB_TOTAL.store(total, AtomicOrd::Relaxed);
    THUMB_DONE.store(completed.load(AtomicOrd::Relaxed), AtomicOrd::Relaxed);

    // 生産者（アーカイブ走査）1本＋消費者（デコード）複数本の構成。
    let (tx, rx) = mpsc::sync_channel::<(usize, Vec<u8>)>(8);
    let rx = Arc::new(Mutex::new(rx));
    // 事前生成はあくまで裏方。読書中の表示・めくりを妨げないよう、使用コア数を控えめにする
    // （全コアを占有すると開いた直後に固まる原因になるため、最大2スレッドに抑える）。
    let workers = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).clamp(1, 2))
        .unwrap_or(1);

    std::thread::scope(|s| {
        for _ in 0..workers {
            let rx = Arc::clone(&rx);
            let completed = Arc::clone(&completed);
            s.spawn(move || loop {
                if canceled() {
                    break;
                }
                let msg = rx.lock().unwrap().recv();
                match msg {
                    Ok((idx, raw)) => {
                        let started = std::time::Instant::now();
                        store_thumb_from_bytes(gen, idx, &raw);
                        if !canceled() {
                            let done = completed.fetch_add(1, AtomicOrd::Relaxed) + 1;
                            if THUMB_GEN.load(AtomicOrd::Relaxed) == gen {
                                THUMB_DONE.store(done.min(total), AtomicOrd::Relaxed);
                            }
                        }
                        // サムネイル生成は裏方の仕事。1枚デコードするたびに同じくらい
                        // 休んで、読書中のページ送り・先読みにCPUとディスクを譲る
                        // （休まないと大きなアーカイブで数千枚を全力処理し続け、
                        //   その間ずっと操作が重くなる）。上限は付けて、極端に重い
                        //   1枚のせいで生成が止まったように見えないようにする。
                        if !canceled() {
                            let pause = started
                                .elapsed()
                                .min(std::time::Duration::from_millis(60));
                            std::thread::sleep(pause);
                        }
                    }
                    Err(_) => break, // 送信側終了
                }
            });
        }

        // 直下（container無し）のページはアーカイブを1パス走査して読み出す。
        // 入れ子アーカイブの中のページは後段でコンテナ毎にまとめて読み出す。
        match format {
            Format::Zip => {
                if let Ok(file) = File::open(&path) {
                    if let Ok(mut zip) = zip::ZipArchive::new(file) {
                        for (idx, entry) in entries.iter().enumerate() {
                            if canceled() {
                                break;
                            }
                            if entry.container.is_some() {
                                continue;
                            }
                            if THUMBS.lock().unwrap().contains_key(&idx) {
                                continue;
                            }
                            if let Ok(mut e) = zip.by_name(&entry.name) {
                                let mut buf = Vec::with_capacity(e.size() as usize);
                                if e.read_to_end(&mut buf).is_ok()
                                    && tx.send((idx, buf)).is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Format::Rar => {
                let index_of: HashMap<&str, usize> = entries
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| e.container.is_none())
                    .map(|(i, e)| (e.name.as_str(), i))
                    .collect();
                if let Ok(mut cursor) = unrar::Archive::new(&path).open_for_processing() {
                    loop {
                        if canceled() {
                            break;
                        }
                        match cursor.read_header() {
                            Ok(Some(header)) => {
                                let name =
                                    header.entry().filename.to_string_lossy().to_string();
                                let target = index_of.get(name.as_str()).copied().filter(
                                    |idx| !THUMBS.lock().unwrap().contains_key(idx),
                                );
                                if let Some(idx) = target {
                                    match header.read() {
                                        Ok((data, rest)) => {
                                            let _ = tx.send((idx, data));
                                            cursor = rest;
                                        }
                                        Err(_) => break,
                                    }
                                } else {
                                    match header.skip() {
                                        Ok(rest) => cursor = rest,
                                        Err(_) => break,
                                    }
                                }
                            }
                            _ => break,
                        }
                    }
                }
            }
            Format::SevenZ => {
                let index_of: HashMap<String, usize> = entries
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| e.container.is_none())
                    .map(|(i, e)| (e.name.clone(), i))
                    .collect();
                if let Ok(mut sz) =
                    sevenz_rust::SevenZReader::open(&path, sevenz_rust::Password::empty())
                {
                    let _ = sz.for_each_entries(|entry, reader| {
                        if canceled() {
                            return Ok(false);
                        }
                        if let Some(&idx) = index_of.get(entry.name()) {
                            if !THUMBS.lock().unwrap().contains_key(&idx) {
                                let mut buf = Vec::new();
                                reader.read_to_end(&mut buf)?;
                                let _ = tx.send((idx, buf));
                            }
                        }
                        Ok(true)
                    });
                }
            }
            Format::Folder => {
                for (idx, entry) in entries.iter().enumerate() {
                    if canceled() {
                        break;
                    }
                    if THUMBS.lock().unwrap().contains_key(&idx) {
                        continue;
                    }
                    if let Ok(buf) = std::fs::read(&entry.name) {
                        if tx.send((idx, buf)).is_err() {
                            break;
                        }
                    }
                }
            }
        }

        // 入れ子アーカイブの中のページ：エントリはコンテナ毎に連続して並んでいるので、
        // コンテナ単位でまとめて展開・走査する。読書用のLRUキャッシュ(INNER_CACHE)は
        // 使わない（裏方の走査が読書中の巻を追い出してしまわないように、直接読む）。
        let mut i = 0;
        while i < entries.len() && !canceled() {
            let Some(cref) = entries[i].container.clone() else {
                i += 1;
                continue;
            };
            let mut targets: Vec<(usize, String)> = Vec::new();
            while i < entries.len()
                && entries[i]
                    .container
                    .as_ref()
                    .map(|c| c.outer_name == cref.outer_name)
                    .unwrap_or(false)
            {
                if !THUMBS.lock().unwrap().contains_key(&i) {
                    targets.push((i, entries[i].name.clone()));
                }
                i += 1;
            }
            if targets.is_empty() {
                continue;
            }
            if let Some(tp) = &cref.temp_path {
                // 内部Rar：一時ファイルを1パス走査
                let index_of: HashMap<&str, usize> =
                    targets.iter().map(|(i, n)| (n.as_str(), *i)).collect();
                if let Ok(mut cursor) = unrar::Archive::new(tp).open_for_processing() {
                    loop {
                        if canceled() {
                            break;
                        }
                        match cursor.read_header() {
                            Ok(Some(header)) => {
                                let name =
                                    header.entry().filename.to_string_lossy().to_string();
                                if let Some(&idx) = index_of.get(name.as_str()) {
                                    match header.read() {
                                        Ok((data, rest)) => {
                                            let _ = tx.send((idx, data));
                                            cursor = rest;
                                        }
                                        Err(_) => break,
                                    }
                                } else {
                                    match header.skip() {
                                        Ok(rest) => cursor = rest,
                                        Err(_) => break,
                                    }
                                }
                            }
                            _ => break,
                        }
                    }
                }
            } else if let Ok(bytes) = read_entry_from(&path, format, &cref.outer_name) {
                match cref.format {
                    Format::Zip => {
                        if let Ok(mut zip) = zip::ZipArchive::new(Cursor::new(&bytes[..])) {
                            for (idx, name) in &targets {
                                if canceled() {
                                    break;
                                }
                                if let Ok(mut e) = zip.by_name(name) {
                                    let mut buf = Vec::with_capacity(e.size() as usize);
                                    if e.read_to_end(&mut buf).is_ok()
                                        && tx.send((*idx, buf)).is_err()
                                    {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    Format::SevenZ => {
                        let index_of: HashMap<&str, usize> =
                            targets.iter().map(|(i, n)| (n.as_str(), *i)).collect();
                        if let Ok(mut sz) = sevenz_rust::SevenZReader::new(
                            Cursor::new(&bytes[..]),
                            bytes.len() as u64,
                            sevenz_rust::Password::empty(),
                        ) {
                            let _ = sz.for_each_entries(|entry, reader| {
                                if canceled() {
                                    return Ok(false);
                                }
                                if let Some(&idx) = index_of.get(entry.name()) {
                                    let mut buf = Vec::new();
                                    reader.read_to_end(&mut buf)?;
                                    let _ = tx.send((idx, buf));
                                }
                                Ok(true)
                            });
                        }
                    }
                    _ => {}
                }
            }
        }
        drop(tx); // 供給終了 → 消費者が順次終了し、scopeが合流を待つ
    });

    // スキップされた（既にキャッシュ済みだった）分の数え漏れがあっても、
    // 完了時には必ず100%として記録し、進捗バーが中途半端な数字で止まらないようにする。
    if !canceled() {
        THUMB_DONE.store(total, AtomicOrd::Relaxed);
    }
}

#[derive(serde::Serialize)]
struct ThumbProgress {
    completed: usize,
    total: usize,
}

/// サムネイル事前生成の進捗を返す（フロントがポーリングする）。
#[tauri::command]
fn get_thumb_progress() -> ThumbProgress {
    ThumbProgress {
        completed: THUMB_DONE.load(AtomicOrd::Relaxed),
        total: THUMB_TOTAL.load(AtomicOrd::Relaxed),
    }
}

#[derive(serde::Serialize)]
struct OpenResult {
    count: usize,
    #[serde(rename = "initialIndex")]
    initial_index: usize,
}

/// アーカイブ（Zip/Rar/7z）を開き、画像を自然順に並べて状態に保持する。
/// reset=false かつ記憶されている最終閲覧ページがあれば、そこから再開する。
/// reset=true の場合は常に先頭ページから開く（「最初から読む」用）。
#[tauri::command]
async fn open_archive(path: String, reset: bool) -> Result<OpenResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let format = detect_format(&path)?;
        clear_nested_state(); // 前のファイルの入れ子キャッシュ・一時ファイルを破棄
        let entries = build_sorted_entries(&path, format)?;
        if entries.is_empty() {
            return Err("画像が見つかりませんでした".into());
        }
        let count = entries.len();
        let initial_index = if reset {
            0
        } else {
            HISTORY
                .lock()
                .unwrap()
                .positions
                .get(&path)
                .copied()
                .unwrap_or(0)
                .min(count - 1)
        };
        try_relink_bookmarks(&path); // 移動してきた同名・同サイズファイルへブックマークを再リンク
        *ARCHIVE.lock().unwrap() = Some(ArchiveState {
            path: PathBuf::from(path),
            format,
            entries,
        });
        // 別アーカイブに切り替わるのでサムネイル・リサイズ済みキャッシュを破棄。
        THUMBS.lock().unwrap().clear();
        RESIZED_CACHE.lock().unwrap().clear();
        // 世代を進めて旧生成を中断し、新アーカイブの事前生成を裏で開始。
        let gen = THUMB_GEN.fetch_add(1, AtomicOrd::Relaxed) + 1;
        tauri::async_runtime::spawn_blocking(move || pregen_thumbnails(gen));
        Ok(OpenResult { count, initial_index })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指定ページの画像バイト列を読み出す（内部処理）。
/// 直近に読み出したページの生バイト列（世代番号, ページ番号, 中身）。
/// 見開き表示では1ページにつき get_page_dims（寸法）と get_page（表示）の
/// 2回読み出しが走り、アーカイブから同じエントリを二重に展開していた。
/// ごく少数だけ保持して、この直後の重複展開を省く。
static RECENT_PAGES: LazyLock<Mutex<Vec<(u64, usize, Arc<Vec<u8>>)>>> =
    LazyLock::new(|| Mutex::new(Vec::new()));
const RECENT_PAGES_CAP: usize = 4;

/// 生バイト列を共有参照のまま返す。呼び出し側の多く（寸法取得・サムネ生成）は
/// 中身を読むだけなので、ここでコピーせずに済ませる。
fn read_page_bytes(index: usize) -> Result<Arc<Vec<u8>>, String> {
    let gen = THUMB_GEN.load(AtomicOrd::Relaxed);
    {
        let cache = RECENT_PAGES.lock().unwrap();
        if let Some((_, _, bytes)) = cache.iter().find(|(g, i, _)| *g == gen && *i == index) {
            return Ok(Arc::clone(bytes));
        }
    }
    let bytes = Arc::new(read_page_bytes_uncached(index)?);
    {
        let mut cache = RECENT_PAGES.lock().unwrap();
        // 別のファイルへ切り替わっていたら、古い世代の分はまとめて捨てる。
        cache.retain(|(g, _, _)| *g == gen);
        if !cache.iter().any(|(g, i, _)| *g == gen && *i == index) {
            cache.push((gen, index, Arc::clone(&bytes)));
            while cache.len() > RECENT_PAGES_CAP {
                cache.remove(0);
            }
        }
    }
    Ok(bytes)
}

fn read_page_bytes_uncached(index: usize) -> Result<Vec<u8>, String> {
    let (path, format, entry) = {
        let guard = ARCHIVE.lock().unwrap();
        let st = guard.as_ref().ok_or("アーカイブが開かれていません")?;
        let entry = st.entries.get(index).ok_or("ページ番号が範囲外です")?.clone();
        (st.path.clone(), st.format, entry)
    };
    match &entry.container {
        None => read_entry_from(&path, format, &entry.name),
        Some(inner) => {
            // 内部Rarは一時ファイルから直接読む（unrarはメモリを扱えないため）。
            if let Some(tp) = &inner.temp_path {
                return read_rar_entry(tp, &entry.name);
            }
            let bytes = get_inner_bytes(&path, format, inner)?;
            match inner.format {
                Format::Zip => read_zip_entry_bytes(&bytes, &entry.name),
                Format::SevenZ => read_7z_entry_bytes(&bytes, &entry.name),
                _ => Err("対応していない内部アーカイブ形式です".into()),
            }
        }
    }
}

/// 指定パス（画像ファイル or フォルダ）の基点フォルダに、サブフォルダが
/// 存在するかを調べる。フロント側で「下層フォルダも読み込みますか？」の
/// 確認ダイアログを出すべきかどうかの判定に使う。
#[tauri::command]
async fn has_subfolders(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = resolve_base_dir(Path::new(&path))?;
        has_subfolders_in(&dir)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct FolderOpenResult {
    count: usize,
    #[serde(rename = "initialIndex")]
    initial_index: usize,
    /// この巻を識別するパス（＝フォルダの基点パス）。history/巻移動で使う。
    dir: String,
}

/// 画像ファイル、またはフォルダそのものを開く。
/// path が画像ファイルなら、その親フォルダの画像を一覧化し、クリックした
/// 画像の位置から表示する。path がフォルダなら、その中の画像を先頭から表示する。
/// recursive=true の場合、全階層のサブフォルダの画像も含める。
/// クリックした画像の指定が無い場合は、記憶されている最終閲覧ページから再開する。
#[tauri::command]
async fn open_folder(path: String, recursive: bool, reset: bool) -> Result<FolderOpenResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        let focus = if p.is_dir() { None } else { Some(p.clone()) };
        let dir = resolve_base_dir(&p)?;
        let anchor = dir.to_string_lossy().to_string();

        let mut entries = list_folder(&dir, recursive)?;
        if entries.is_empty() {
            return Err("画像が見つかりませんでした".into());
        }
        entries.sort_by(|a, b| natural_cmp(a, b));
        let count = entries.len();

        let initial_index = if reset {
            0
        } else {
            match focus {
                Some(f) => {
                    let target = f.to_string_lossy().to_string();
                    entries.iter().position(|e| *e == target).unwrap_or(0)
                }
                None => HISTORY
                    .lock()
                    .unwrap()
                    .positions
                    .get(&anchor)
                    .copied()
                    .unwrap_or(0)
                    .min(count - 1),
            }
        };

        clear_nested_state(); // 前のファイルの入れ子キャッシュ・一時ファイルを破棄
        *ARCHIVE.lock().unwrap() = Some(ArchiveState {
            path: dir,
            format: Format::Folder,
            entries: entries.into_iter().map(PageEntry::direct).collect(),
        });
        THUMBS.lock().unwrap().clear();
        RESIZED_CACHE.lock().unwrap().clear();
        let gen = THUMB_GEN.fetch_add(1, AtomicOrd::Relaxed) + 1;
        tauri::async_runtime::spawn_blocking(move || pregen_thumbnails(gen));

        Ok(FolderOpenResult {
            count,
            initial_index,
            dir: anchor,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 指定ページの画像バイト列を返す（別スレッドで実行しUIを塞がない）。
#[tauri::command]
async fn get_page(index: usize) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || read_page_bytes(index))
        .await
        .map_err(|e| e.to_string())??;
    // IPCへ渡す時だけ所有権のあるVecが要る。他の呼び出し側は共有参照のまま扱う。
    Ok(tauri::ipc::Response::new(
        Arc::try_unwrap(bytes).unwrap_or_else(|arc| (*arc).clone()),
    ))
}

/// サムネイルJPEGを生成（生成済みならキャッシュから返す）。
fn make_thumbnail(index: usize) -> Result<Arc<Vec<u8>>, String> {
    if let Some(b) = THUMBS.lock().unwrap().get(&index).cloned() {
        return Ok(b);
    }
    // 読み出し開始時点の世代を記録。デコードの間に別アーカイブへ切り替わって
    // いた場合（挿入直前に世代不一致）はキャッシュへ書き込まない。
    let gen = THUMB_GEN.load(AtomicOrd::Relaxed);
    let raw = read_page_bytes(index)?;
    let img = image::load_from_memory(&raw[..]).map_err(|e| format!("画像デコード失敗: {e}"))?;
    let thumb = img.thumbnail(THUMB_MAX, THUMB_MAX);
    let rgb = thumb.to_rgb8();
    let mut out = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("JPEGエンコード失敗: {e}"))?;
    let bytes = Arc::new(out.into_inner());
    if THUMB_GEN.load(AtomicOrd::Relaxed) == gen {
        THUMBS.lock().unwrap().insert(index, bytes.clone());
    }
    Ok(bytes)
}

/// 指定ページのサムネイル（JPEG）を返す（別スレッドで実行しUIを塞がない）。
#[tauri::command]
async fn get_thumbnail(index: usize) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || make_thumbnail(index))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new((*bytes).clone()))
}

/// ファイル関連付け（拡張子ダブルクリック）から起動された場合、そのファイルパスを返す
/// （exe自身のパスを除く最初のコマンドライン引数）。
#[tauri::command]
fn get_launch_path() -> Option<String> {
    std::env::args().nth(1)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            open_archive,
            has_subfolders,
            open_folder,
            get_page,
            get_thumbnail,
            get_thumb_progress,
            get_history,
            save_position,
            set_end_behavior,
            list_volumes,
            add_bookmark,
            remove_bookmark,
            list_bookmarks,
            find_bookmark,
            get_settings,
            set_settings,
            get_page_resized,
            get_page_dims,
            get_launch_path,
            list_tree_dir,
            get_parent_dir,
            add_to_shelf,
            remove_from_shelf,
            list_shelf,
            is_in_shelf
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    /// アーカイブ状態はグローバル共有のため、開閉を伴うテストを直列化するロック。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// テスト用にアーカイブを同期で開くヘルパ（本体の open_archive と同じ構築処理）。
    fn open_sync(path: &str) -> Result<usize, String> {
        let format = detect_format(path)?;
        clear_nested_state();
        let entries = build_sorted_entries(path, format)?;
        if entries.is_empty() {
            return Err("画像が見つかりませんでした".into());
        }
        let count = entries.len();
        *ARCHIVE.lock().unwrap() = Some(ArchiveState {
            path: PathBuf::from(path),
            format,
            entries,
        });
        THUMBS.lock().unwrap().clear();
        Ok(count)
    }

    #[test]
    fn natural_order_sorts_numerically() {
        let mut v = vec![
            "page10.png",
            "page2.png",
            "page1.png",
            "page9.png",
            "cover.png",
        ];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            vec![
                "cover.png",
                "page1.png",
                "page2.png",
                "page9.png",
                "page10.png"
            ]
        );
    }

    #[test]
    fn image_filter_detects_extensions() {
        assert!(is_image("a/b/c.JPG"));
        assert!(is_image("x.webp"));
        assert!(!is_image("readme.txt"));
        assert!(!is_image("folder/"));
    }

    #[test]
    fn format_detection() {
        assert!(matches!(detect_format("a.zip"), Ok(Format::Zip)));
        assert!(matches!(detect_format("A.CBZ"), Ok(Format::Zip)));
        assert!(matches!(detect_format("b.rar"), Ok(Format::Rar)));
        assert!(matches!(detect_format("b.CBR"), Ok(Format::Rar)));
        assert!(matches!(detect_format("c.7z"), Ok(Format::SevenZ)));
        assert!(detect_format("d.txt").is_err());
    }

    /// 巻移動：同フォルダ内のアーカイブファイル・サブフォルダが自然順で列挙されること。
    #[test]
    fn list_volumes_finds_archives_and_folders() {
        let base = std::env::temp_dir().join("mviewer_volumes_test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("Chapter2_unpacked")).unwrap();
        std::fs::write(base.join("Chapter1.zip"), b"fake").unwrap();
        std::fs::write(base.join("Chapter3.cbz"), b"fake").unwrap();
        std::fs::write(base.join("readme.txt"), b"not a volume").unwrap();

        let anchor = base.join("Chapter1.zip");
        let volumes = list_volumes_sync(anchor.to_str().unwrap()).expect("巻一覧の取得");
        assert_eq!(volumes.len(), 3, "readme.txtは巻として数えない");
        assert!(volumes[0].ends_with("Chapter1.zip"));
        assert!(volumes[1].ends_with("Chapter2_unpacked"));
        assert!(volumes[2].ends_with("Chapter3.cbz"));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// リサイズフィルター：おまかせ判定（縮小/拡大でフィルター名が変わること）と、
    /// 実際にリサイズした画像が指定サイズちょうどになること。
    #[test]
    fn resize_filter_resolves_and_resizes() {
        let _guard = TEST_LOCK.lock().unwrap();
        let auto = ResizeSettings::default();
        assert_eq!(resolve_filter(&auto, 1000, 1000, 500, 500), "lanczos3", "縮小はLanczos3");
        assert_eq!(resolve_filter(&auto, 500, 500, 1000, 1000), "bicubic", "拡大はバイキュービック");

        let manual = ResizeSettings {
            auto: false,
            shrink_filter: "mitchell".to_string(),
            enlarge_filter: "nearest".to_string(),
            unsharp: 0.0,
        };
        assert_eq!(resolve_filter(&manual, 1000, 1000, 500, 500), "mitchell");
        assert_eq!(resolve_filter(&manual, 500, 500, 1000, 1000), "nearest");

        let zip = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/test.zip");
        open_sync(zip).expect("Zipを開けること");
        let bytes = render_page_resized(0, 123, 456).expect("リサイズ実行");
        let dims = image::load_from_memory(&bytes).expect("デコード").dimensions();
        assert_eq!(dims, (123, 456), "指定サイズちょうどにリサイズされること");
    }

    /// ブックマーク：登録・一覧（全ファイル横断／このファイル絞り込み）・削除・
    /// ファイル移動後の自動再リンクが正しく動くこと。
    #[test]
    fn bookmark_add_list_remove_and_relink() {
        let _guard = TEST_LOCK.lock().unwrap();
        // 他のテストや既存データの影響を避けるため、一時的に退避してから空にする。
        let saved = std::mem::take(&mut *BOOKMARKS.lock().unwrap());

        let zip = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/test.zip");
        open_sync(zip).expect("Zipを開けること");

        let bm = add_bookmark_sync(zip.to_string(), 2).expect("しおり登録");
        assert!(!bm.thumb_base64.is_empty(), "サムネイルが埋め込まれていること");
        assert_eq!(bm.page, 2);
        assert!(bm.exists);

        // 全ファイル横断・このファイル絞り込みの両方で見つかること。
        assert_eq!(list_bookmarks(None).len(), 1);
        assert_eq!(list_bookmarks(Some(zip.to_string())).len(), 1);
        assert_eq!(list_bookmarks(Some("other.zip".to_string())).len(), 0);
        assert_eq!(find_bookmark(zip.to_string(), 2), Some(bm.id));

        // ファイルが「移動」したことを模擬（コピー後に元を消す）→ 自動再リンクされること。
        let moved = std::env::temp_dir().join("mviewer_test_moved.zip");
        std::fs::copy(zip, &moved).unwrap();
        // 元ファイルが「存在しない」状況を作れないため（testディレクトリの資産のため）、
        // 一時的にブックマークのanchorだけ「存在しない旧パス」に差し替えて再現する。
        {
            let mut list = BOOKMARKS.lock().unwrap();
            for b in list.iter_mut() {
                b.anchor = "C:\\存在しない\\旧パス\\test.zip".to_string();
            }
        }
        assert!(!list_bookmarks(None)[0].exists, "旧パスは存在しないこと");
        try_relink_bookmarks(moved.to_str().unwrap());
        // ファイル名が違う（test.zip → mviewer_test_moved.zip）ため再リンクされないことを確認。
        assert!(!list_bookmarks(None)[0].exists, "ファイル名が異なるため再リンクされない");

        // 削除。
        remove_bookmark(bm.id).unwrap();
        assert_eq!(list_bookmarks(None).len(), 0);

        let _ = std::fs::remove_file(&moved);
        *BOOKMARKS.lock().unwrap() = saved; // 復元
    }

    #[test]
    fn open_read_and_thumbnail_zip() {
        let _guard = TEST_LOCK.lock().unwrap();
        let zip = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/test.zip");
        let count = open_sync(zip).expect("Zipを開けること");
        assert_eq!(count, 10, "画像10枚が認識されること");

        // 1ページ目・最終ページとも有効なPNG（先頭シグネチャ）であること。
        let first = read_page_bytes(0).expect("先頭ページ読み出し");
        let last = read_page_bytes(9).expect("最終ページ読み出し");
        const PNG: [u8; 4] = [0x89, 0x50, 0x4E, 0x47];
        assert_eq!(&first[0..4], &PNG, "先頭ページがPNG");
        assert_eq!(&last[0..4], &PNG, "最終ページがPNG");

        // サムネイルがJPEG(SOIマーカー)として生成されること。
        let thumb = make_thumbnail(0).expect("サムネ生成");
        assert_eq!(&thumb[0..2], &[0xFF, 0xD8], "サムネがJPEG");

        // 事前生成：1パス走査で全ページ分のサムネイルが揃うこと。
        THUMBS.lock().unwrap().clear();
        let gen = THUMB_GEN.load(AtomicOrd::Relaxed);
        pregen_thumbnails(gen);
        assert_eq!(
            THUMBS.lock().unwrap().len(),
            10,
            "事前生成で全ページ分のサムネイル"
        );

        // 範囲外はエラー。
        assert!(read_page_bytes(10).is_err());
    }

    /// 回帰テスト：直近ページのバイト列キャッシュ（RECENT_PAGES）が、
    /// 同じページの再読み出しでは同じ内容を返し、かつ別ファイルを開いたら
    /// 破棄されること。破棄漏れがあると「ページ番号が同じ前のファイルの中身」
    /// を表示してしまう。
    #[test]
    fn recent_page_cache_reuses_and_invalidates() {
        let _guard = TEST_LOCK.lock().unwrap();
        let zip = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/test.zip");
        open_sync(zip).expect("Zipを開けること");

        // 1回目の読み出しでキャッシュに載り、2回目も同じ内容が返ること
        // （見開き表示では寸法取得と表示で同じページを2回読むため、ここが効く）。
        let first = read_page_bytes(0).expect("先頭ページ読み出し");
        assert!(
            RECENT_PAGES.lock().unwrap().iter().any(|(_, i, _)| *i == 0),
            "読み出したページがキャッシュに載ること"
        );
        let second = read_page_bytes(0).expect("同じページの再読み出し");
        assert_eq!(first, second, "キャッシュ経由でも同じ内容が返ること");

        // 別ファイル（ここではフォルダ）を開いたらキャッシュが空になること。
        let base = std::env::temp_dir().join("mameviewer_recent_cache_test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("a.png"), b"other-file").unwrap();
        clear_nested_state(); // 開く処理が必ず通る破棄フック
        assert!(
            RECENT_PAGES.lock().unwrap().is_empty(),
            "ファイル切替時にキャッシュが破棄されること"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 回帰テスト：ファイル切替時に、旧アーカイブから遅れて届いたサムネイル
    /// 生成結果が新アーカイブのキャッシュへ混入しないこと（世代チェック）。
    #[test]
    fn stale_generation_thumbnail_is_not_cached() {
        let _guard = TEST_LOCK.lock().unwrap();
        let zip = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/test.zip");
        open_sync(zip).expect("Zipを開けること");
        let raw = read_page_bytes(0).expect("ページ読み出し");

        // 「古いファイルを開いていた時点の世代」を借用し、その後アーカイブが
        // 切り替わった（世代が進んだ）状況を再現する。
        let old_gen = THUMB_GEN.load(AtomicOrd::Relaxed);
        THUMB_GEN.fetch_add(1, AtomicOrd::Relaxed); // 別ファイルへの切替を模擬

        THUMBS.lock().unwrap().clear(); // 新アーカイブを開いた際のクリア相当
        store_thumb_from_bytes(old_gen, 0, &raw); // 遅れて届いた旧世代の生成結果
        assert!(
            !THUMBS.lock().unwrap().contains_key(&0),
            "世代不一致の生成結果はキャッシュへ混入してはならない"
        );

        // 現在の世代であれば正しく格納されること。
        let cur_gen = THUMB_GEN.load(AtomicOrd::Relaxed);
        store_thumb_from_bytes(cur_gen, 0, &raw);
        assert!(
            THUMBS.lock().unwrap().contains_key(&0),
            "現世代の生成結果は正しくキャッシュされること"
        );
    }

    #[test]
    fn open_read_7z() {
        let _guard = TEST_LOCK.lock().unwrap();
        // sevenz-rust の圧縮機能でテスト用 .7z を作成し、読み出しを検証する。
        let imgs = concat!(env!("CARGO_MANIFEST_DIR"), "/../test/imgs");
        let out = std::env::temp_dir().join("mviewer_test.7z");
        let _ = std::fs::remove_file(&out);
        sevenz_rust::compress_to_path(imgs, &out).expect("7z圧縮");

        let count = open_sync(out.to_str().unwrap()).expect("7zを開けること");
        assert_eq!(count, 10, "画像10枚が認識されること");

        let first = read_page_bytes(0).expect("先頭ページ読み出し");
        const PNG: [u8; 4] = [0x89, 0x50, 0x4E, 0x47];
        assert_eq!(&first[0..4], &PNG, "先頭ページがPNG");

        let _ = std::fs::remove_file(&out);
    }

    /// フォルダ直読み：非再帰ではサブフォルダを含めず、再帰では全階層を含める。
    /// また、自然順ソートによりサブフォルダの画像同士がまとまること（アーカイブ毎の並びに近い挙動）。
    #[test]
    fn open_folder_recursive_and_grouped_order() {
        let _guard = TEST_LOCK.lock().unwrap();
        let base = std::env::temp_dir().join("mviewer_folder_test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("a.png"), b"fake-a").unwrap();
        std::fs::write(base.join("b.png"), b"fake-b").unwrap();
        std::fs::write(base.join("sub").join("c.png"), b"fake-c").unwrap();
        std::fs::write(base.join("sub").join("d.png"), b"fake-d").unwrap();

        assert!(
            has_subfolders_in(&base).expect("サブフォルダ確認"),
            "sub フォルダがあるので true"
        );

        // 非再帰：トップレベルの2枚のみ。
        let mut nonrec = list_folder(&base, false).expect("非再帰一覧");
        nonrec.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(nonrec.len(), 2, "非再帰ではサブフォルダを含めない");

        // 再帰：4枚すべて含む。
        let mut rec = list_folder(&base, true).expect("再帰一覧");
        rec.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(rec.len(), 4, "再帰では全階層の画像を含める");

        // フォルダ単位でまとまること：トップレベル(a,b)とsub(c,d)がそれぞれ連続する。
        let is_sub = |p: &str| p.contains("sub");
        let sub_flags: Vec<bool> = rec.iter().map(|p| is_sub(p)).collect();
        let mut prev = sub_flags[0];
        let mut switches = 0;
        for &f in &sub_flags[1..] {
            if f != prev {
                switches += 1;
                prev = f;
            }
        }
        assert_eq!(
            switches, 1,
            "トップレベルとsubフォルダの画像が入り混じらず、それぞれまとまっていること"
        );

        // open_folder 相当：特定ファイルを起点にした時の初期表示位置。
        let focus = base.join("sub").join("d.png");
        let idx = rec
            .iter()
            .position(|e| *e == focus.to_string_lossy().to_string())
            .expect("フォーカスファイルが一覧にあること");
        assert_eq!(rec[idx], focus.to_string_lossy().to_string());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 入れ子アーカイブ：Zipの中の複数Zipを検出し、内部アーカイブ毎に
    /// まとまった読書順（巻順→巻内のページ順）で列挙・読み出しできること。
    #[test]
    fn nested_zip_entries_grouped_per_inner_archive() {
        use std::io::Write;
        let _guard = TEST_LOCK.lock().unwrap();
        let base = std::env::temp_dir().join("mviewer_nested_test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        fn make_inner(names: &[&str]) -> Vec<u8> {
            let mut cur = Cursor::new(Vec::new());
            {
                let mut w = zip::ZipWriter::new(&mut cur);
                let opts = zip::write::SimpleFileOptions::default();
                for n in names {
                    w.start_file(*n, opts).unwrap();
                    use std::io::Write;
                    w.write_all(format!("data-{n}").as_bytes()).unwrap();
                }
                w.finish().unwrap();
            }
            cur.into_inner()
        }

        let outer = base.join("outer.zip");
        {
            let mut w = zip::ZipWriter::new(File::create(&outer).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            // わざと b → a の順で格納し、ソートで a が先にまとまることを確認する。
            w.start_file("b.zip", opts).unwrap();
            w.write_all(&make_inner(&["1.png", "10.png", "2.png"])).unwrap();
            w.start_file("a.zip", opts).unwrap();
            w.write_all(&make_inner(&["1.png", "2.png"])).unwrap();
            w.start_file("0_cover.png", opts).unwrap();
            w.write_all(b"cover").unwrap();
            w.finish().unwrap();
        }

        let count = open_sync(outer.to_str().unwrap()).expect("入れ子Zipを開けること");
        assert_eq!(count, 6, "直下1枚＋内部(2+3)枚");

        let keys: Vec<String> = ARCHIVE
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .entries
            .iter()
            .map(|e| e.sort_key())
            .collect();
        assert_eq!(
            keys,
            vec![
                "0_cover.png",
                "a.zip/1.png",
                "a.zip/2.png",
                "b.zip/1.png",
                "b.zip/2.png",
                "b.zip/10.png"
            ],
            "内部アーカイブ毎にまとまり、その中は自然順であること"
        );

        // 直下ページ・入れ子ページの読み出し（入れ子はINNER_CACHE経由）。
        assert_eq!(&read_page_bytes(0).expect("0_cover.png")[..], b"cover");
        assert_eq!(&read_page_bytes(1).expect("a.zip/1.png")[..], b"data-1.png");
        assert_eq!(&read_page_bytes(5).expect("b.zip/10.png")[..], b"data-10.png");

        // 事前生成が入れ子ページでも完了扱いになること（画像は偽データのため
        // デコードは失敗するが、走査自体がエラーで止まらないこと）。
        let gen = THUMB_GEN.load(AtomicOrd::Relaxed);
        pregen_thumbnails(gen);

        let _ = std::fs::remove_dir_all(&base);
        clear_nested_state();
    }
}
