# line-news-bot

## 目的
Google Apps Script で AI・子育て系ニュースを RSS から取得し、LINE Messaging API で毎日配信するボット。

## 使用言語・実行方法
- Google Apps Script (JavaScript)
- `main.gs` を script.google.com のエディタに貼り付けて使用(ローカルはコード管理用)
- 実行エントリ: `dailyJobSimple`(シンプル版) / `dailyJobWithSummary`(Gemini要約版)。時間主導型トリガーで毎日実行

## このプロジェクト固有のルール
- トークン・APIキーは絶対にコードへ直書きしない。GAS の「スクリプト プロパティ」(`LINE_TOKEN` / `LINE_USER_ID` / `GEMINI_API_KEY`)で管理する
- GAS エディタ側を直接編集した場合は、必ずローカルの `main.gs` にも反映してコミットする
