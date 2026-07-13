# line-news-bot

Google Apps Script で AI・子育て系ニュースを RSS から取得し、LINE に毎日配信するボット。

## 旧版からの主な改善点

| 問題 | 対策 |
|---|---|
| 毎日ほぼ同じ記事が届く(特に子育て系) | ① 送信済み記事をスクリプト プロパティに記録して除外<br>② Google News 検索に `when:1d` / `when:7d` を付けて期間を限定<br>③ pubDate で新しい順にソート＆古い記事を除外 |
| 子育て系クエリがハウツー固定で新着が出ない | 曜日ごとのテーマローテーション＋汎用クエリの組み合わせに変更 |
| トークンが本体コードに直書き | 設定を `config.gs` に分離(git管理外なのでコード共有時に漏れない) |
| `MAX_ARTICLES_PER_CATEGORY` 未定義で要約版が落ちる | カテゴリ判定自体を廃止(フィードがカテゴリ別のため不要) |
| 全記事を Gemini に投げていた(1回200件超) | 送信する記事だけ要約(1日10件程度) |
| モデル名 `gemini-pro` が廃止済み | `gemini-2.0-flash` に変更 |
| LINE の5000文字制限 | 超過時は自動分割(最大5通) |
| 長文テキストで読みにくい | Flex Message カルーセルに変更(記事1件=カード1枚、横スワイプでめくる) |

## ファイル構成

- `main.gs` — 本体ロジック(git管理・共有OK)
- `config.gs` — トークン等の設定(**git管理外**。`config.example.gs` をコピーして作成)
- `config.example.gs` — 設定ファイルの雛形
- `appsscript.json` — GASマニフェスト(タイムゾーン等)
- `.clasp.json` — clasp のプロジェクト紐付け(git管理外)
- `.claspignore` — GASにpushしないファイルの指定

## GASとの同期(clasp)

ローカルと GAS は [clasp](https://github.com/google/clasp) で同期する(手動コピペはしない)。

- ローカルを編集したら: `clasp push`
- GASエディタ側で直接編集してしまったら: `clasp pull` → 差分を確認してコミット
- 前提: `npm install -g @google/clasp`、`clasp login`、
  [Apps Script API の有効化](https://script.google.com/home/usersettings)(設定済み、2026-07-13)

## セットアップ

### 1. 設定ファイルの用意

`config.example.gs` を `config.gs` にコピーし、トークンと User ID を記入する。
(トークン再発行は任意。個人利用でリスク許容済みなら旧トークンのままでも動作する)

### 2. コードの同期と動作確認

1. `clasp push` でローカルのコードを GAS に反映する
2. GAS エディタで `checkConfig` を実行して「設定済み」と出るか確認
3. `testSimple`(または `testWithSummary`)を実行して LINE に届くか確認

### 3. トリガー設定

GAS エディタ →「トリガー」→「トリガーを追加」:

- 実行する関数: `dailyJobSimple` または `dailyJobWithSummary`
- イベントのソース: 時間主導型 → 日付ベースのタイマー → 好きな時間帯

## LINEからの操作(Webhook)

トークにメッセージを送るとボットを操作できる:

| コマンド | 動作 |
|---|---|
| `ニュース` / `もっと` | 未配信の最新ニュースをすぐ配信 |
| `NG 〇〇` | 除外ワードを追加 |
| `NG解除 〇〇` | 除外ワードを削除(コマンドで追加した分のみ) |
| `NG一覧` | 除外ワードの一覧を表示 |
| `ヘルプ` | コマンド一覧を表示 |

また、各カードの「興味ない」ボタンを押すと、タイトルから抽出した除外ワード候補が
クイックリプライで提示され、タップした語が NG リストに追加される。

### Webhookのセットアップ

1. `clasp deploy` でウェブアプリとしてデプロイし、URL(`https://script.google.com/macros/s/<デプロイID>/exec`)を得る
2. [LINE Developers コンソール](https://developers.line.biz/console/) → チャネル → Messaging API設定 → Webhook URL に貼り付けて「検証」→「Webhookの利用」をON
3. [LINE Official Account Manager](https://manager.line.biz/) → 応答設定 → 「応答メッセージ」をOFF(既定の自動返信を止める)
4. トークに `ヘルプ` と送って返信が来れば完了

### Webhookコードを変更したとき

ウェブアプリはデプロイ時点のバージョンが動くため、`doPost` 周りを変更したら再デプロイが必要:

```
clasp deploy -i <デプロイID>   # 同じURLのまま新バージョンに更新
```

(デプロイIDは `clasp deployments` で確認。定期配信の関数はHEADが動くので再デプロイ不要)

## メンテナンス

- `resetSentHistory`: 送信済み履歴をリセット(テストで同じ記事を再送したいとき)
- 子育て系の日替わりテーマは `main.gs` の `PARENTING_THEMES` で変更可能
- 各フィードからの取得件数は `MAX_ARTICLES_PER_RSS` で調整
- 興味のない話題は `NG_KEYWORDS` への追記、またはLINEで `NG 〇〇` と送ると除外される(タイトル・本文で部分一致)
