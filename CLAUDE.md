# line-news-bot

## 目的
Google Apps Script で AI・子育て系ニュースを RSS から取得し、LINE Messaging API で毎日配信するボット。

## 使用言語・実行方法
- Google Apps Script (JavaScript)
- ローカルが正。GAS への反映は `clasp push`、GAS側を直接編集した場合は `clasp pull` で取り込む(手動コピペ禁止)
- 実行エントリ: `dailyJobSimple`(シンプル版) / `dailyJobWithSummary`(Gemini要約版)。時間主導型トリガーで毎日実行

## このプロジェクト固有のルール
- トークン・APIキーは `config.gs` にのみ書く。`config.gs` は .gitignore 済みで**絶対にコミットしない**(本体 `main.gs` にも直書きしない)
- `config.example.gs` は `.claspignore` で push 対象外(GASに送ると定数が二重定義になるため、除外設定を消さない)
- ユーザーの判断で旧トークンを継続使用中(個人利用のため再発行しない方針、2026-07-12)
