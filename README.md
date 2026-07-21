# MameViewer

ローカル専用の漫画・画像ビューアです。「軽快さ」を最優先に設計しています。

Mangameeya以来、満足のゆくビューアが見当たらず、自作してみました。ゆっくりと機能を充実させてゆきます。

## 主な機能

- Zip / Rar / 7z（cbz/cbr/cb7）・画像・フォルダに対応（アーカイブ内アーカイブも自動展開）
- 5ボタンマウスでの片手操作を軸に、キーボード割り当てもカスタマイズ可能
- 見開き表示・綴じ方向・フィット・回転・拡大縮小・ナビゲーターミニマップ
- 読書位置の自動記憶・しおり・サムネイル一覧

## 技術構成

- [Tauri 2.x](https://tauri.app/)（Rustバックエンド＋HTML/CSS/TypeScriptフロントエンド）

## 開発

```bash
npm install
npm run tauri dev
```

## 寄付について

本アプリは**寄付制（ドネーションウェア）**です。機能制限はありません。気に入っていただけましたら、[GitHub Sponsors](https://github.com/sponsors/ichiyukin) から開発の支援をいただけると励みになります。

## ライセンス

[MIT License](LICENSE)
