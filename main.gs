// =======================================
// ニュース取得＋LINE配信（改善版）
// シンプル版とGemini要約版の両方を実装
//
// 【事前設定】トークン等の設定は config.gs に記載する
// （GASエディタにも main.gs と config.gs の2ファイルを置く。
//   config.gs は git 管理外なので、コードを共有してもトークンは漏れない）
// =======================================

// --- 設定 ---
// CHANNEL_ACCESS_TOKEN / USER_ID / GEMINI_API_KEY は config.gs で定義
const PROPS = PropertiesService.getScriptProperties(); // 送信済み履歴の保存に使用

const GEMINI_MODEL = 'gemini-2.0-flash';

const MAX_ARTICLES_PER_RSS = 2;   // 各RSSから取得する記事数
const AI_MAX_AGE_DAYS = 2;        // AI系: 過去2日以内の記事のみ
const PARENTING_MAX_AGE_DAYS = 7; // 子育て系: 過去7日以内の記事のみ
const SENT_KEYS_LIMIT = 300;      // 送信済み履歴の保持件数
const LINE_TEXT_LIMIT = 4900;     // LINEの1通あたり5000文字制限に対する余裕値

// --- Google News RSS 検索URLを組み立てる ---
// when:1d / when:7d を付けると検索対象期間を絞れる（鮮度対策の要）
function googleNewsRss(query, when) {
	const q = when ? `${query} when:${when}` : query;
	return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=ja&gl=JP&ceid=JP:ja';
}

// AI関連のRSS（ニュースが多いので過去1日に限定）
function getAiRssUrls() {
	return [
		googleNewsRss('Gemini', '1d'),
		googleNewsRss('ChatGPT', '1d'),
		googleNewsRss('生成AI 活用', '1d'),
		'https://feeds.bbci.co.uk/news/technology/rss.xml'
	];
}

// 子育て系は新着が少ないジャンルなので、日替わりテーマ＋汎用クエリの組み合わせにする
const PARENTING_THEMES = [
	'子育て支援 制度',   // 日
	'離乳食',            // 月
	'赤ちゃん 睡眠',     // 火
	'子供 発達',         // 水
	'育児グッズ',        // 木
	'知育 遊び',         // 金
	'予防接種 子供'      // 土
];

function getParentingRssUrls() {
	const todayTheme = PARENTING_THEMES[new Date().getDay()];
	return [
		googleNewsRss(todayTheme, '7d'),
		googleNewsRss('子育て', '1d'),
		googleNewsRss('育児', '1d')
	];
}

// =======================================
// 共通関数
// =======================================

// --- LINEにメッセージを送る（5000文字超は分割、最大5通） ---
function sendLine(text) {
	if (!CHANNEL_ACCESS_TOKEN || !USER_ID) {
		throw new Error('config.gs に CHANNEL_ACCESS_TOKEN / USER_ID を設定してください');
	}

	const chunks = [];
	let rest = text;
	while (rest.length > 0 && chunks.length < 5) {
		chunks.push(rest.slice(0, LINE_TEXT_LIMIT));
		rest = rest.slice(LINE_TEXT_LIMIT);
	}

	const payload = {
		to: USER_ID,
		messages: chunks.map(t => ({ type: 'text', text: t }))
	};

	UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
		method: 'post',
		contentType: 'application/json',
		headers: {
			Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN
		},
		payload: JSON.stringify(payload)
	});
}

// --- RSS取得（pubDate付き） ---
function fetchRssArticles(rssUrl) {
	try {
		const res = UrlFetchApp.fetch(rssUrl, { muteHttpExceptions: true });
		if (res.getResponseCode() !== 200) {
			Logger.log('RSS取得失敗(HTTP ' + res.getResponseCode() + '): ' + rssUrl);
			return [];
		}
		const xml = XmlService.parse(res.getContentText());
		const items = xml.getRootElement().getChild('channel').getChildren('item');
		return items.map(item => ({
			title: (item.getChildText('title') || '').trim(),
			link: item.getChildText('link') || '',
			description: stripHtml(item.getChildText('description') || ''),
			pubDate: new Date(item.getChildText('pubDate') || 0)
		}));
	} catch (e) {
		Logger.log('RSS取得失敗: ' + rssUrl + ' / ' + e);
		return [];
	}
}

function stripHtml(html) {
	return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

// --- 送信済み記事の記録（毎日同じ記事が届く問題への対策） ---
function getSentKeys() {
	const raw = PROPS.getProperty('SENT_ARTICLES');
	return new Set(raw ? JSON.parse(raw) : []);
}

function saveSentKeys(sentSet) {
	const arr = [...sentSet].slice(-SENT_KEYS_LIMIT);
	PROPS.setProperty('SENT_ARTICLES', JSON.stringify(arr));
}

// タイトルから記号・空白を除いた先頭40文字をキーにする
// （URLでなくタイトルにすることで、配信元違いの同一記事もはじける）
function articleKey(article) {
	return article.title.replace(/[\s　「」【】\[\]().,、。・：:\-]/g, '').slice(0, 40);
}

function markSent(sentKeys, articles) {
	articles.forEach(a => sentKeys.add(articleKey(a)));
	saveSentKeys(sentKeys);
}

// --- 記事の選定: 期間内 かつ 未送信 の記事を新しい順に各フィードから取得 ---
function pickArticles(urls, perFeed, sentKeys, maxAgeDays) {
	const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
	const picked = [];
	urls.forEach(url => {
		const fresh = fetchRssArticles(url)
			.filter(a => a.pubDate > cutoff)
			.filter(a => !sentKeys.has(articleKey(a)))
			.filter(a => !picked.some(p => articleKey(p) === articleKey(a)))
			.sort((a, b) => b.pubDate - a.pubDate);
		picked.push(...fresh.slice(0, perFeed));
	});
	return picked;
}

// --- メッセージのセクション組み立て ---
function buildSection(title, articles, withSummary) {
	let s = `【${title}】\n`;
	if (articles.length === 0) {
		return s + '(今日は新着なし)\n\n';
	}
	articles.forEach(a => {
		s += `・${a.title}\n`;
		if (withSummary && a.summary) {
			s += `  要約: ${a.summary}\n`;
		}
		s += `  ${a.link}\n\n`;
	});
	return s;
}

function formatDate(d) {
	return Utilities.formatDate(d, 'Asia/Tokyo', 'M/d(E)');
}

// =======================================
// シンプル版（タイトルとリンクのみ）
// =======================================

function sendNewsSimple() {
	const sentKeys = getSentKeys();

	const aiArticles = pickArticles(getAiRssUrls(), MAX_ARTICLES_PER_RSS, sentKeys, AI_MAX_AGE_DAYS);
	const parentingArticles = pickArticles(getParentingRssUrls(), MAX_ARTICLES_PER_RSS, sentKeys, PARENTING_MAX_AGE_DAYS);

	let message = '📰 ' + formatDate(new Date()) + ' のニュース\n\n';
	message += buildSection('AI・技術ニュース', aiArticles, false);
	message += buildSection('子育て・育児', parentingArticles, false);

	sendLine(message.trim());
	markSent(sentKeys, aiArticles.concat(parentingArticles));
	Logger.log('シンプル版送信完了: AI ' + aiArticles.length + '件 / 子育て ' + parentingArticles.length + '件');
}

// =======================================
// Gemini要約版（要約付き）
// =======================================
// フィード自体がカテゴリ別なので、Geminiにはカテゴリ判定させず要約だけ行う。
// 要約は「送信する記事だけ」に実行するので、API呼び出しは1日あたり10件程度で済む。

function sendNewsWithSummary() {
	const sentKeys = getSentKeys();

	const withSummary = a => ({ ...a, summary: summarizeArticle(a) });
	const aiArticles = pickArticles(getAiRssUrls(), MAX_ARTICLES_PER_RSS, sentKeys, AI_MAX_AGE_DAYS).map(withSummary);
	const parentingArticles = pickArticles(getParentingRssUrls(), MAX_ARTICLES_PER_RSS, sentKeys, PARENTING_MAX_AGE_DAYS).map(withSummary);

	let message = '📰 ' + formatDate(new Date()) + ' のニュース\n\n';
	message += buildSection('AI・技術ニュース', aiArticles, true);
	message += buildSection('子育て・育児', parentingArticles, true);

	sendLine(message.trim());
	markSent(sentKeys, aiArticles.concat(parentingArticles));
	Logger.log('Gemini要約版送信完了: AI ' + aiArticles.length + '件 / 子育て ' + parentingArticles.length + '件');
}

// --- Geminiで要約 ---
function summarizeArticle(article) {
	if (!GEMINI_API_KEY) {
		return article.description.slice(0, 50);
	}
	try {
		const prompt = `以下のニュース記事を日本語50文字程度で要約してください。要約文のみを返してください。

タイトル: ${article.title}
内容: ${article.description}`;

		const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

		const response = UrlFetchApp.fetch(url, {
			method: 'post',
			contentType: 'application/json',
			payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
			muteHttpExceptions: true
		});

		const data = JSON.parse(response.getContentText());
		const text = data.candidates && data.candidates[0] &&
			data.candidates[0].content.parts[0].text;
		if (text) {
			return text.trim();
		}
		Logger.log('Gemini応答が空: ' + response.getContentText().slice(0, 200));
	} catch (e) {
		Logger.log('Gemini API エラー: ' + e);
	}
	return article.description.slice(0, 50);
}

// =======================================
// テスト・メンテナンス用関数
// =======================================

// 設定が揃っているか確認（初回セットアップ時に実行）
function checkConfig() {
	Logger.log('CHANNEL_ACCESS_TOKEN: ' + (CHANNEL_ACCESS_TOKEN ? '設定済み' : '未設定(config.gs を確認)'));
	Logger.log('USER_ID: ' + (USER_ID ? '設定済み' : '未設定(config.gs を確認)'));
	Logger.log('GEMINI_API_KEY: ' + (GEMINI_API_KEY ? '設定済み' : '未設定(要約版を使う場合のみ必要)'));
	Logger.log('送信済み履歴: ' + getSentKeys().size + '件');
}

// 送信済み履歴をリセット（テストで同じ記事を再送したいときに実行）
function resetSentHistory() {
	PROPS.deleteProperty('SENT_ARTICLES');
	Logger.log('送信済み履歴をリセットしました');
}

// シンプル版のテスト
function testSimple() {
	sendNewsSimple();
}

// Gemini要約版のテスト
function testWithSummary() {
	sendNewsWithSummary();
}

// =======================================
// 毎日実行される関数（時間主導型トリガーに登録する）
// =======================================

function dailyJobSimple() {
	sendNewsSimple();
}

function dailyJobWithSummary() {
	sendNewsWithSummary();
}
