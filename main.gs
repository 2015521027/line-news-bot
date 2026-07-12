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

// 興味のない話題のNGワード（タイトルか本文に1つでも含まれたら配信しない）
const NG_KEYWORDS = [
	'ビットコイン', '仮想通貨', '暗号資産', '暗号通貨',
	'スマホ', 'スマートフォン', 'iPhone'
];

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

// --- LINEにメッセージを送る（push API、1リクエスト最大5メッセージ） ---
function pushMessages(messages) {
	if (!CHANNEL_ACCESS_TOKEN || !USER_ID) {
		throw new Error('config.gs に CHANNEL_ACCESS_TOKEN / USER_ID を設定してください');
	}

	const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
		method: 'post',
		contentType: 'application/json',
		headers: {
			Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN
		},
		payload: JSON.stringify({ to: USER_ID, messages: messages.slice(0, 5) }),
		muteHttpExceptions: true
	});
	if (res.getResponseCode() !== 200) {
		Logger.log('LINE送信失敗: ' + res.getContentText());
		throw new Error('LINE送信失敗(HTTP ' + res.getResponseCode() + ')');
	}
}

// --- テキスト1通を送る（5000文字超は分割、最大5通） ---
function sendLine(text) {
	const chunks = [];
	let rest = text;
	while (rest.length > 0 && chunks.length < 5) {
		chunks.push(rest.slice(0, LINE_TEXT_LIMIT));
		rest = rest.slice(LINE_TEXT_LIMIT);
	}
	pushMessages(chunks.map(t => ({ type: 'text', text: t })));
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

// --- Google News のリダイレクトURLを実記事URLに解決 ---
// LINEボタンのURI上限(1000文字)対策 + 実記事からOGP画像を取るため。
// Google Newsの内部API(batchexecute)を使うので、仕様変更で動かなくなったら元のURLを返す
function resolveArticleUrl(url) {
	if (url.indexOf('news.google.com') === -1) return url;
	try {
		const idMatch = url.match(/articles\/([^?]+)/);
		if (!idMatch) return url;

		// 記事ページから署名(data-n-a-sg)とタイムスタンプ(data-n-a-ts)を取得
		const page = UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText();
		const sg = page.match(/data-n-a-sg="([^"]+)"/);
		const ts = page.match(/data-n-a-ts="([^"]+)"/);
		if (!sg || !ts) return url;

		const inner = JSON.stringify([
			'garturlreq',
			[['ja-JP', 'JP', ['FINANCE_TOP_INDICES', 'WEB_TEST_1_0_0'], null, null, 1, 1, 'JP:ja', null, null, null, null, null, null, null, 2, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null], 'ja-JP', 'JP', 1, [2, 4, 8], 1, 1, null, 0, 0, null, 0],
			idMatch[1],
			Number(ts[1]),
			sg[1]
		]);
		const fReq = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);

		const res = UrlFetchApp.fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
			method: 'post',
			contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
			payload: 'f.req=' + encodeURIComponent(fReq),
			muteHttpExceptions: true
		});
		const m = res.getContentText().match(/garturlres\\",\\"(https?:\/\/[^\\"]+)/);
		if (m) return m[1];
	} catch (e) {
		Logger.log('URL解決失敗: ' + url.slice(0, 80) + ' / ' + e);
	}
	return url;
}

// --- 記事ページのOGP画像URLを取得（見つからなければ null → カードは画像なしになる） ---
function fetchOgImage(articleUrl) {
	try {
		const res = UrlFetchApp.fetch(articleUrl, { muteHttpExceptions: true, followRedirects: true });
		if (res.getResponseCode() !== 200) return null;
		const html = res.getContentText().slice(0, 200000);
		const m = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
			|| html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
		if (m && /^https:\/\//.test(m[1]) && m[1].length <= 2000) {
			return m[1].replace(/&amp;/g, '&');
		}
	} catch (e) {
		Logger.log('OGP画像取得失敗: ' + articleUrl + ' / ' + e);
	}
	return null;
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

// --- NGワード判定（英語キーワードは大文字小文字を区別しない） ---
function isBlocked(article) {
	const text = (article.title + ' ' + article.description).toLowerCase();
	return NG_KEYWORDS.some(k => text.includes(k.toLowerCase()));
}

// --- 記事の選定: 期間内 かつ 未送信 かつ NGワードなし の記事を新しい順に各フィードから取得 ---
function pickArticles(urls, perFeed, sentKeys, maxAgeDays) {
	const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
	const picked = [];
	urls.forEach(url => {
		const fresh = fetchRssArticles(url)
			.filter(a => a.pubDate > cutoff)
			.filter(a => !isBlocked(a))
			.filter(a => !sentKeys.has(articleKey(a)))
			.filter(a => !picked.some(p => articleKey(p) === articleKey(a)))
			.sort((a, b) => b.pubDate - a.pubDate);
		picked.push(...fresh.slice(0, perFeed));
	});
	return picked;
}

// --- Flex Message（カルーセル）: 記事を1枚ずつのカードにして横スワイプでめくれる形式 ---
const CATEGORY_STYLES = {
	ai: { label: 'AI・技術', color: '#1E6FD9' },
	parenting: { label: '子育て・育児', color: '#E8871E' }
};

function articleBubble(article, style, withSummary) {
	const body = [
		{ type: 'text', text: style.label, size: 'xxs', color: style.color, weight: 'bold' },
		{ type: 'text', text: article.title, size: 'sm', weight: 'bold', wrap: true, maxLines: 5 }
	];
	if (withSummary && article.summary) {
		body.push({ type: 'text', text: article.summary, size: 'xs', color: '#888888', wrap: true, maxLines: 4 });
	}
	const bubble = {
		type: 'bubble',
		size: 'kilo',
		body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
		footer: {
			type: 'box',
			layout: 'vertical',
			contents: [{
				type: 'button',
				style: 'primary',
				height: 'sm',
				color: style.color,
				action: { type: 'uri', label: '記事を読む', uri: article.link }
			}]
		}
	};
	if (article.image) {
		bubble.hero = { type: 'image', url: article.image, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' };
	}
	return bubble;
}

// カルーセル1通に入るカードは最大12枚（LINEの仕様）
function carouselMessage(altText, articles, style, withSummary) {
	return {
		type: 'flex',
		altText: altText,
		contents: {
			type: 'carousel',
			contents: articles.slice(0, 12).map(a => articleBubble(a, style, withSummary))
		}
	};
}

function formatDate(d) {
	return Utilities.formatDate(d, 'Asia/Tokyo', 'M/d(E)');
}

// =======================================
// 配信本体（シンプル版・Gemini要約版 共通）
// =======================================
// 「日付ヘッダー(テキスト) + AIカルーセル + 子育てカルーセル」の最大3通を1回のpushで送る

function deliverNews(withSummary) {
	const sentKeys = getSentKeys();

	let aiArticles = pickArticles(getAiRssUrls(), MAX_ARTICLES_PER_RSS, sentKeys, AI_MAX_AGE_DAYS);
	let parentingArticles = pickArticles(getParentingRssUrls(), MAX_ARTICLES_PER_RSS, sentKeys, PARENTING_MAX_AGE_DAYS);

	if (withSummary) {
		const summarize = a => ({ ...a, summary: summarizeArticle(a) });
		aiArticles = aiArticles.map(summarize);
		parentingArticles = parentingArticles.map(summarize);
	}

	// Google Newsのリダイレクトを実記事URLに解決してから、カード用のサムネイル画像を取得
	// （解決できずLINEのURI上限1000文字を超えた記事は、送信全体が失敗しないよう除外する）
	const enrich = a => {
		const link = resolveArticleUrl(a.link);
		return { ...a, link: link, image: fetchOgImage(link) };
	};
	const fitsUriLimit = a => {
		if (a.link.length <= 1000) return true;
		Logger.log('URI上限超過のため除外: ' + a.title);
		return false;
	};
	aiArticles = aiArticles.map(enrich).filter(fitsUriLimit);
	parentingArticles = parentingArticles.map(enrich).filter(fitsUriLimit);

	const messages = [{ type: 'text', text: '📰 ' + formatDate(new Date()) + ' のニュース' }];
	if (aiArticles.length > 0) {
		messages.push(carouselMessage('AI・技術ニュース ' + aiArticles.length + '件', aiArticles, CATEGORY_STYLES.ai, withSummary));
	}
	if (parentingArticles.length > 0) {
		messages.push(carouselMessage('子育て・育児ニュース ' + parentingArticles.length + '件', parentingArticles, CATEGORY_STYLES.parenting, withSummary));
	}
	if (messages.length === 1) {
		messages[0].text += '\n(今日は新着なし)';
	}

	pushMessages(messages);
	markSent(sentKeys, aiArticles.concat(parentingArticles));
	Logger.log('送信完了: AI ' + aiArticles.length + '件 / 子育て ' + parentingArticles.length + '件');
}

// シンプル版（タイトルのみのカード）
function sendNewsSimple() {
	deliverNews(false);
}

// Gemini要約版（要約付きカード）
// フィード自体がカテゴリ別なので、Geminiにはカテゴリ判定させず要約だけ行う。
// 要約は「送信する記事だけ」に実行するので、API呼び出しは1日あたり10件程度で済む。
function sendNewsWithSummary() {
	deliverNews(true);
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
// 配信が失敗したときはLINEに⚠️通知を送る（静かに止まるのを防ぐ）

function runWithErrorNotify(fn) {
	try {
		fn();
	} catch (e) {
		Logger.log('配信エラー: ' + e + (e && e.stack ? '\n' + e.stack : ''));
		try {
			sendLine('⚠️ 今日のニュース配信でエラーが発生しました。\n' + e + '\n\nGASの実行ログを確認してください。');
		} catch (e2) {
			Logger.log('エラー通知の送信も失敗: ' + e2);
		}
		throw e; // GASの実行失敗履歴にも残す
	}
}

function dailyJobSimple() {
	runWithErrorNotify(sendNewsSimple);
}

function dailyJobWithSummary() {
	runWithErrorNotify(sendNewsWithSummary);
}
