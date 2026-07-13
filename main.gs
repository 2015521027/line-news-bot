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

// AI・技術系: Google News検索をやめ、テックブログ・専門メディアのRSSに絞る
function getAiRssUrls() {
	return [
		'https://zenn.dev/topics/ai/feed',                    // Zenn AIトピック
		'https://zenn.dev/topics/%E7%94%9F%E6%88%90ai/feed',  // Zenn 生成AIトピック
		'https://qiita.com/tags/ai/feed',                     // Qiita AIタグ
		'https://b.hatena.ne.jp/hotentry/it.rss',             // はてなブックマーク IT人気エントリ
		'https://rss.itmedia.co.jp/rss/2.0/aiplus.xml',       // ITmedia AI+
		'https://www.publickey1.jp/atom.xml'                  // Publickey(エンタープライズIT)
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
		'https://192abc.com/feed',                                                          // こそだてハック(直RSS、画像が安定)
		'https://b.hatena.ne.jp/search/tag?q=%E5%AD%90%E8%82%B2%E3%81%A6&users=5&mode=rss', // はてブ「子育て」タグ(5users以上の人気記事)
		googleNewsRss(todayTheme, '7d')                                                     // 日替わりテーマ(Google News、画像は取れたら)
	];
}

// =======================================
// 共通関数
// =======================================

// --- デバッグ用トレース（直近50件をプロパティに保存、doGetで外から読める） ---
function trace(msg) {
	try {
		const arr = JSON.parse(PROPS.getProperty('TRACE') || '[]');
		arr.push(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm:ss') + ' ' + msg);
		PROPS.setProperty('TRACE', JSON.stringify(arr.slice(-50)));
	} catch (e) {}
}

function doGet() {
	const arr = JSON.parse(PROPS.getProperty('TRACE') || '[]');
	return ContentService.createTextOutput(arr.length ? arr.join('\n') : '(trace無し)');
}

// --- LINEにメッセージを送る（push API、1リクエスト最大5メッセージ） ---
function pushMessages(messages) {
	if (!CHANNEL_ACCESS_TOKEN || !USER_ID) {
		throw new Error('config.gs に CHANNEL_ACCESS_TOKEN / USER_ID を設定してください');
	}

	trace('push実行: ' + messages.length + '通');
	const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
		method: 'post',
		contentType: 'application/json',
		headers: {
			Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN
		},
		payload: JSON.stringify({ to: USER_ID, messages: messages.slice(0, 5) }),
		muteHttpExceptions: true
	});
	trace('push応答: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 150));
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

// --- フィード取得（RSS 2.0 / RSS 1.0(RDF) / Atom の3形式に対応） ---
function parseFeedResponse(res, rssUrl) {
	try {
		if (res.getResponseCode() !== 200) {
			Logger.log('RSS取得失敗(HTTP ' + res.getResponseCode() + '): ' + rssUrl);
			return [];
		}
		const root = XmlService.parse(res.getContentText()).getRootElement();
		switch (root.getName()) {
			case 'rss': return parseRss2(root);   // Zenn, ITmedia, Google News など
			case 'RDF': return parseRss1(root);   // はてなブックマーク など
			case 'feed': return parseAtom(root);  // Qiita, Publickey など
			default:
				Logger.log('未対応のフィード形式(' + root.getName() + '): ' + rssUrl);
				return [];
		}
	} catch (e) {
		Logger.log('RSS取得失敗: ' + rssUrl + ' / ' + e);
		return [];
	}
}

function fetchRssArticles(rssUrl) {
	try {
		const res = UrlFetchApp.fetch(rssUrl, { muteHttpExceptions: true });
		return parseFeedResponse(res, rssUrl);
	} catch (e) {
		Logger.log('RSS取得失敗: ' + rssUrl + ' / ' + e);
		return [];
	}
}

// 全フィードを並列で一括取得（1本ずつだと合計20秒以上かかるため）
function fetchAllFeeds(urls) {
	try {
		const responses = UrlFetchApp.fetchAll(urls.map(u => ({ url: u, muteHttpExceptions: true })));
		return responses.map((res, i) => parseFeedResponse(res, urls[i]));
	} catch (e) {
		Logger.log('フィード一括取得に失敗、順次取得に切替: ' + e);
		return urls.map(u => fetchRssArticles(u));
	}
}

function makeArticle(title, link, description, dateStr) {
	return {
		title: (title || '').trim(),
		link: link || '',
		description: stripHtml(description || ''),
		pubDate: new Date(dateStr || 0)
	};
}

function parseRss2(root) {
	return root.getChild('channel').getChildren('item').map(item => makeArticle(
		item.getChildText('title'),
		item.getChildText('link'),
		item.getChildText('description'),
		item.getChildText('pubDate')
	));
}

function parseRss1(root) {
	const RSS1 = XmlService.getNamespace('http://purl.org/rss/1.0/');
	const DC = XmlService.getNamespace('http://purl.org/dc/elements/1.1/');
	return root.getChildren('item', RSS1).map(item => makeArticle(
		item.getChildText('title', RSS1),
		item.getChildText('link', RSS1),
		item.getChildText('description', RSS1),
		item.getChildText('date', DC)
	));
}

function parseAtom(root) {
	const ATOM = XmlService.getNamespace('http://www.w3.org/2005/Atom');
	return root.getChildren('entry', ATOM).map(entry => {
		const links = entry.getChildren('link', ATOM);
		const alt = links.filter(l => !l.getAttribute('rel') || l.getAttribute('rel').getValue() === 'alternate')[0] || links[0];
		return makeArticle(
			entry.getChildText('title', ATOM),
			alt ? alt.getAttribute('href').getValue() : '',
			entry.getChildText('summary', ATOM) || entry.getChildText('content', ATOM),
			entry.getChildText('published', ATOM) || entry.getChildText('updated', ATOM)
		);
	});
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
		if (!sg || !ts) {
			Logger.log('URL解決失敗(署名が取れず): ' + url.slice(0, 80));
			return url;
		}

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
function extractOgImage(res, articleUrl) {
	try {
		if (res.getResponseCode() !== 200) {
			Logger.log('OGP取得 HTTP ' + res.getResponseCode() + ': ' + articleUrl.slice(0, 80));
			return null;
		}
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

function fetchOgImage(articleUrl) {
	try {
		const res = UrlFetchApp.fetch(articleUrl, { muteHttpExceptions: true, followRedirects: true });
		return extractOgImage(res, articleUrl);
	} catch (e) {
		Logger.log('OGP画像取得失敗: ' + articleUrl + ' / ' + e);
		return null;
	}
}

// 配信対象全記事の画像を並列で一括取得
function fetchOgImagesAll(urls) {
	try {
		const responses = UrlFetchApp.fetchAll(urls.map(u => ({ url: u, muteHttpExceptions: true, followRedirects: true })));
		return responses.map((res, i) => extractOgImage(res, urls[i]));
	} catch (e) {
		Logger.log('画像一括取得に失敗、順次取得に切替: ' + e);
		return urls.map(u => fetchOgImage(u));
	}
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
// コード内の固定リスト(NG_KEYWORDS)と、LINEの「NG 〇〇」コマンドで追加した動的リストを合わせて使う
let ngWordsCache = null;

function getExtraNgWords() {
	const raw = PROPS.getProperty('NG_EXTRA');
	return raw ? JSON.parse(raw) : [];
}

function getAllNgWords() {
	if (!ngWordsCache) {
		ngWordsCache = NG_KEYWORDS.concat(getExtraNgWords());
	}
	return ngWordsCache;
}

function addNgWord(word) {
	const extra = getExtraNgWords();
	if (word && extra.indexOf(word) === -1 && NG_KEYWORDS.indexOf(word) === -1) {
		extra.push(word);
		PROPS.setProperty('NG_EXTRA', JSON.stringify(extra));
		ngWordsCache = null;
	}
}

// 動的リストからの削除のみ可能。固定リストにあるワードなら false を返す
function removeNgWord(word) {
	PROPS.setProperty('NG_EXTRA', JSON.stringify(getExtraNgWords().filter(w => w !== word)));
	ngWordsCache = null;
	return NG_KEYWORDS.indexOf(word) === -1;
}

function isBlocked(article) {
	const text = (article.title + ' ' + article.description).toLowerCase();
	return getAllNgWords().some(k => text.includes(k.toLowerCase()));
}

// --- 記事の選定: 期間内 かつ 未送信 かつ NGワードなし の記事を新しい順に各フィードから取得 ---
function pickArticles(urls, perFeed, sentKeys, maxAgeDays) {
	const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
	const picked = [];
	fetchAllFeeds(urls).forEach(articles => {
		const fresh = articles
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
			spacing: 'sm',
			contents: [{
				type: 'button',
				style: 'primary',
				height: 'sm',
				color: style.color,
				action: { type: 'uri', label: '記事を読む', uri: article.link }
			}, {
				type: 'button',
				style: 'secondary',
				height: 'sm',
				action: {
					type: 'postback',
					label: '興味ない',
					data: 'dislike|' + article.title.slice(0, 250),
					displayText: '興味ない👎'
				}
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
	trace('deliverNews開始');
	const sentKeys = getSentKeys();

	let aiArticles = pickArticles(getAiRssUrls(), MAX_ARTICLES_PER_RSS, sentKeys, AI_MAX_AGE_DAYS);
	let parentingArticles = pickArticles(getParentingRssUrls(), MAX_ARTICLES_PER_RSS, sentKeys, PARENTING_MAX_AGE_DAYS);
	trace('記事選定: AI ' + aiArticles.length + '件 / 子育て ' + parentingArticles.length + '件');

	if (withSummary) {
		const summarize = a => ({ ...a, summary: summarizeArticle(a) });
		aiArticles = aiArticles.map(summarize);
		parentingArticles = parentingArticles.map(summarize);
	}

	// Google Newsのリダイレクトを実記事URLに解決（対象は少数）
	// （解決できずLINEのURI上限1000文字を超えた記事は、送信全体が失敗しないよう除外する）
	const fitsUriLimit = a => {
		if (a.link.length <= 1000) return true;
		Logger.log('URI上限超過のため除外: ' + a.title);
		return false;
	};
	aiArticles = aiArticles.map(a => ({ ...a, link: resolveArticleUrl(a.link) })).filter(fitsUriLimit);
	parentingArticles = parentingArticles.map(a => ({ ...a, link: resolveArticleUrl(a.link) })).filter(fitsUriLimit);

	// カード用のサムネイル画像を並列で一括取得
	const allArticles = aiArticles.concat(parentingArticles);
	const images = fetchOgImagesAll(allArticles.map(a => a.link));
	allArticles.forEach((a, i) => { a.image = images[i]; });

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
// Webhook（LINEからのメッセージで操作する双方向機能）
// =======================================
// 使い方: GASを「ウェブアプリ」としてデプロイし、そのURLを
// LINE Developers コンソールの Webhook URL に設定する（README参照）

function doPost(e) {
	try {
		const body = JSON.parse(e.postData.contents);
		const events = body.events || [];
		Logger.log('Webhook受信: ' + events.length + '件 / ' + events.map(ev =>
			ev.type + ':' + (ev.message && ev.message.text ? ev.message.text.slice(0, 20) : '-') +
			' from ' + (ev.source && ev.source.userId ? ev.source.userId.slice(0, 8) + '…' : '不明')
		).join(', '));
		events.forEach(ev => handleLineEvent(ev));
	} catch (err) {
		Logger.log('Webhook処理エラー: ' + err);
	}
	return ContentService.createTextOutput('ok');
}

function handleLineEvent(ev) {
	// 本人以外からのメッセージは無視（URLを知られても第三者に操作されないように）
	if (!ev.source || ev.source.userId !== USER_ID) return;

	// カードのボタン(postback)への応答
	if (ev.type === 'postback') {
		handlePostback(ev);
		return;
	}

	if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;

	const text = ev.message.text.trim();

	if (text === 'ニュース' || text === 'もっと') {
		replyText(ev.replyToken, '📰 ニュースを取得しています。30秒ほど待ってね');
		runWithErrorNotify(sendNewsSimple); // 返信済みなのでこのまま同期実行してよい
	} else if (/^(NG解除|ng解除)[ 　]/.test(text)) {
		const word = text.replace(/^(NG解除|ng解除)[ 　]+/, '').trim();
		const removed = removeNgWord(word);
		replyText(ev.replyToken, removed
			? '✅「' + word + '」を除外ワードから外しました。\n現在: ' + getAllNgWords().join('、')
			: '「' + word + '」はコード内の固定リストにあるため、LINEからは外せません');
	} else if (/^(NG|ng)[ 　]/.test(text)) {
		const word = text.slice(2).trim();
		addNgWord(word);
		replyText(ev.replyToken, '🚫「' + word + '」を除外ワードに追加しました。\n現在: ' + getAllNgWords().join('、'));
	} else if (text === 'NG一覧' || text === 'ng一覧') {
		replyText(ev.replyToken, '🚫 現在の除外ワード:\n' + getAllNgWords().join('、'));
	} else if (text === 'ヘルプ') {
		replyText(ev.replyToken, [
			'使えるコマンド:',
			'・ニュース → 未配信の最新ニュースをすぐ配信',
			'・もっと → 同上（前回配信の続き）',
			'・NG 〇〇 → 除外ワードを追加',
			'・NG解除 〇〇 → 除外ワードを削除',
			'・NG一覧 → 除外ワードを表示',
			'・ヘルプ → この一覧',
			'',
			'カードの「興味ない」ボタンを押すと、除外ワードの候補から選んで登録できます'
		].join('\n'));
	}
	// コマンド以外のメッセージには反応しない
}

// --- 「興味ない」ボタンなどのpostback処理 ---
function handlePostback(ev) {
	const data = (ev.postback && ev.postback.data) || '';

	if (data.indexOf('dislike|') === 0) {
		// タイトルから除外ワード候補を出して、クイックリプライで選んでもらう
		const words = extractKeywords(data.slice(8));
		if (words.length === 0) {
			replyText(ev.replyToken, 'この記事から除外候補になるワードが見つかりませんでした。「NG 〇〇」で直接指定してください');
			return;
		}
		replyMessages(ev.replyToken, [{
			type: 'text',
			text: '👎 どの話題を今後除外しますか？（下から選択）',
			quickReply: {
				items: words.map(w => ({
					type: 'action',
					action: { type: 'postback', label: w.slice(0, 20), data: 'ng|' + w, displayText: 'NG ' + w }
				}))
			}
		}]);
	} else if (data.indexOf('ng|') === 0) {
		const word = data.slice(3);
		addNgWord(word);
		replyText(ev.replyToken, '🚫「' + word + '」を除外ワードに追加しました。今後この話題は配信されません。\n（戻すときは「NG解除 ' + word + '」）');
	}
}

// --- タイトルから除外ワード候補を抽出（カタカナ3文字以上・漢字2文字以上・英単語3文字以上） ---
function extractKeywords(title) {
	const tokens = title.match(/[ァ-ヶー]{3,}|[一-龠々]{2,}|[A-Za-z][A-Za-z0-9.+#-]{2,}/g) || [];
	return [...new Set(tokens)].slice(0, 6);
}

// --- replyTokenでの返信（即時・無料） ---
function replyMessages(replyToken, messages) {
	const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
		method: 'post',
		contentType: 'application/json',
		headers: { Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN },
		payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
		muteHttpExceptions: true
	});
	if (res.getResponseCode() !== 200) {
		Logger.log('返信失敗(HTTP ' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
	}
}

function replyText(replyToken, text) {
	replyMessages(replyToken, [{ type: 'text', text: text }]);
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

// 子育て記事の画像取得がどの段階で失敗しているかを調べる診断用（LINE送信はしない）
function debugParentingImages() {
	const articles = pickArticles(getParentingRssUrls(), MAX_ARTICLES_PER_RSS, new Set(), PARENTING_MAX_AGE_DAYS);
	Logger.log('対象記事: ' + articles.length + '件');
	articles.forEach((a, i) => {
		const resolved = resolveArticleUrl(a.link);
		const ok = resolved !== a.link;
		const img = ok ? fetchOgImage(resolved) : fetchOgImage(a.link);
		Logger.log('[' + (i + 1) + '] ' + a.title.slice(0, 25) +
			' / 解決: ' + (ok ? 'OK(' + resolved.slice(0, 50) + ')' : '失敗') +
			' / 画像: ' + (img ? 'あり' : 'なし'));
	});
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
		trace('配信エラー: ' + e + ' @ ' + (e && e.stack ? e.stack.split('\n')[1] : '?'));
		try {
			sendLine('⚠️ 今日のニュース配信でエラーが発生しました。\n' + e + '\n\nGASの実行ログを確認してください。');
		} catch (e2) {
			Logger.log('エラー通知の送信も失敗: ' + e2);
			trace('エラー通知の送信も失敗: ' + e2);
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
