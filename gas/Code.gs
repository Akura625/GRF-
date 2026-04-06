/**
 * note.com 自動投稿スクリプト
 *
 * 毎日Googleトレンド（JP）の急上昇キーワードを取得し、
 * Claude APIで記事を生成してUnsplash画像付きでnote.comに投稿します。
 *
 * ■ セットアップ手順
 * 1. Google Apps Script エディタを開く
 *    https://script.google.com/
 *
 * 2. スクリプトプロパティに以下を設定（歯車アイコン > スクリプトプロパティ）:
 *    CLAUDE_API_KEY      : Anthropic APIキー
 *                          https://console.anthropic.com/
 *    UNSPLASH_ACCESS_KEY : Unsplash APIキー
 *                          https://unsplash.com/developers
 *    NOTE_EMAIL          : note.com登録メールアドレス
 *    NOTE_PASSWORD       : note.com パスワード
 *
 * 3. 時間ベースのトリガーを設定
 *    「トリガーを追加」> 関数: autoPostToNote > 時間ベース > 毎日（例: 午前9時）
 */

// ─────────────────────────────────────────
// メイン関数（トリガーで毎日実行）
// ─────────────────────────────────────────
function autoPostToNote() {
  const config = getConfig();

  Logger.log('=== note.com 自動投稿 開始 ===');

  // 1. Googleトレンドからキーワード取得
  const keyword = getTrendingKeyword();
  Logger.log('キーワード: ' + keyword);

  // 2. Claude APIで記事生成
  const article = generateArticle(config.claudeApiKey, keyword);
  Logger.log('タイトル: ' + article.title);

  // 3. Unsplashで関連画像を取得
  const imageUrl = getUnsplashImage(config.unsplashAccessKey, keyword);
  Logger.log('画像URL: ' + imageUrl);

  // 4. note.comにログインして投稿
  const noteSession = loginToNote(config.noteEmail, config.notePassword);
  const noteUrl = createAndPublishNote(noteSession, article.title, article.body, imageUrl);

  Logger.log('投稿完了: ' + noteUrl);
  Logger.log('=== 完了 ===');

  return noteUrl;
}

// ─────────────────────────────────────────
// 設定取得
// ─────────────────────────────────────────
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const config = {
    claudeApiKey: props.getProperty('CLAUDE_API_KEY'),
    unsplashAccessKey: props.getProperty('UNSPLASH_ACCESS_KEY'),
    noteEmail: props.getProperty('NOTE_EMAIL'),
    notePassword: props.getProperty('NOTE_PASSWORD'),
  };

  const missing = Object.entries(config)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error('スクリプトプロパティが未設定です: ' + missing.join(', '));
  }

  return config;
}

// ─────────────────────────────────────────
// Googleトレンド（JP）からキーワード取得
// ─────────────────────────────────────────
function getTrendingKeyword() {
  const url = 'https://trends.google.com/trends/trendingsearches/daily/rss?geo=JP';
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    throw new Error('Googleトレンドの取得に失敗しました: HTTP ' + response.getResponseCode());
  }

  const xml = XmlService.parse(response.getContentText());
  const root = xml.getRootElement();
  const channel = root.getChild('channel');
  const items = channel.getChildren('item');

  if (!items || items.length === 0) {
    throw new Error('トレンドアイテムが見つかりません');
  }

  // 上位5件からランダムに1件選択
  const topItems = items.slice(0, Math.min(5, items.length));
  const picked = topItems[Math.floor(Math.random() * topItems.length)];
  return picked.getChildText('title');
}

// ─────────────────────────────────────────
// Claude APIで記事生成
// ─────────────────────────────────────────
function generateArticle(apiKey, keyword) {
  const url = 'https://api.anthropic.com/v1/messages';

  const prompt = `あなたはnote.comで人気のブロガーです。
今日の急上昇キーワード「${keyword}」に関連した、読者の興味を引く記事を書いてください。

【要件】
- タイトル：魅力的でクリックしたくなる（〜30文字）
- 本文：1000〜1500文字
- 構成：導入 → 本題（2〜3セクション） → まとめ
- 読みやすい日本語。noteらしい親しみやすいトーン
- 見出しは ## / ### を使用したマークダウン形式

【出力形式】
必ず以下のJSON形式のみで返してください。他のテキストは不要です。
{
  "title": "記事タイトル",
  "body": "記事本文（マークダウン）"
}`;

  const payload = JSON.stringify({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: payload,
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);

  if (response.getResponseCode() !== 200) {
    throw new Error('Claude API エラー: ' + response.getContentText());
  }

  const data = JSON.parse(response.getContentText());
  const text = data.content[0].text.trim();

  // レスポンスからJSONを抽出（コードブロックに包まれている場合も対応）
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Claude APIのレスポンスからJSONを抽出できませんでした: ' + text);
  }

  const article = JSON.parse(jsonMatch[0]);
  if (!article.title || !article.body) {
    throw new Error('記事データが不完全です: ' + JSON.stringify(article));
  }

  return article;
}

// ─────────────────────────────────────────
// Unsplashでキーワード関連の画像を取得
// ─────────────────────────────────────────
function getUnsplashImage(accessKey, keyword) {
  // 英語キーワードに変換するためシンプルなフォールバック付き
  const query = encodeURIComponent(keyword);
  const url = `https://api.unsplash.com/photos/random?query=${query}&orientation=landscape&client_id=${accessKey}`;

  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (response.getResponseCode() !== 200) {
    // 取得失敗時は汎用画像を返す
    Logger.log('Unsplash画像取得失敗。フォールバック画像を使用します。');
    const fallback = UrlFetchApp.fetch(
      `https://api.unsplash.com/photos/random?query=japan&orientation=landscape&client_id=${accessKey}`,
      { muteHttpExceptions: true }
    );
    if (fallback.getResponseCode() !== 200) return null;
    return JSON.parse(fallback.getContentText()).urls.regular;
  }

  const data = JSON.parse(response.getContentText());
  return data.urls.regular;
}

// ─────────────────────────────────────────
// note.com ログイン
// ─────────────────────────────────────────
function loginToNote(email, password) {
  // Step 1: ログインページからCSRFトークンを取得
  const loginPageRes = UrlFetchApp.fetch('https://note.com/login', {
    muteHttpExceptions: true,
    followRedirects: true,
  });

  const loginPageHtml = loginPageRes.getContentText();
  const csrfMatch = loginPageHtml.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';

  // ログインページのCookieを保持
  const loginPageCookies = extractCookies(loginPageRes.getAllHeaders());

  // Step 2: APIでログイン
  const loginRes = UrlFetchApp.fetch('https://note.com/api/v1/sessions/sign_in', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Cookie': loginPageCookies,
      'X-CSRF-Token': csrfToken,
      'Referer': 'https://note.com/login',
    },
    payload: JSON.stringify({ login: email, password: password }),
    muteHttpExceptions: true,
    followRedirects: false,
  });

  const loginCode = loginRes.getResponseCode();
  if (loginCode !== 200 && loginCode !== 201) {
    throw new Error('note.comログイン失敗: HTTP ' + loginCode + ' / ' + loginRes.getContentText());
  }

  const sessionCookies = extractCookies(loginRes.getAllHeaders());
  const mergedCookies = mergeCookies(loginPageCookies, sessionCookies);

  const loginData = JSON.parse(loginRes.getContentText());
  const userKey = loginData.data && loginData.data.userSession ? loginData.data.userSession : '';

  return {
    cookies: mergedCookies,
    csrfToken: csrfToken,
    userKey: userKey,
  };
}

// ─────────────────────────────────────────
// note.com 記事作成 & 公開
// ─────────────────────────────────────────
function createAndPublishNote(session, title, body, imageUrl) {
  // 画像をnoteのbodyの先頭に埋め込む（eyecatch画像の代替）
  const fullBody = imageUrl
    ? `![header](${imageUrl})\n\n${body}`
    : body;

  // Step 1: 下書き作成
  const createRes = UrlFetchApp.fetch('https://note.com/api/v2/text_notes', {
    method: 'post',
    contentType: 'application/json',
    headers: buildNoteHeaders(session),
    payload: JSON.stringify({
      name: title,
      body: fullBody,
      status: 'draft',
    }),
    muteHttpExceptions: true,
  });

  if (createRes.getResponseCode() !== 200 && createRes.getResponseCode() !== 201) {
    throw new Error('下書き作成失敗: HTTP ' + createRes.getResponseCode() + ' / ' + createRes.getContentText());
  }

  const createData = JSON.parse(createRes.getContentText());
  const noteId = createData.data && createData.data.id;
  const noteKey = createData.data && createData.data.key;

  if (!noteId) {
    throw new Error('note IDが取得できませんでした: ' + createRes.getContentText());
  }

  Logger.log('下書き作成完了 ID: ' + noteId);

  // Step 2: 公開
  const publishRes = UrlFetchApp.fetch(`https://note.com/api/v2/text_notes/${noteId}/publish`, {
    method: 'put',
    contentType: 'application/json',
    headers: buildNoteHeaders(session),
    payload: JSON.stringify({ publish_at: null }),
    muteHttpExceptions: true,
  });

  if (publishRes.getResponseCode() !== 200 && publishRes.getResponseCode() !== 201) {
    throw new Error('公開失敗: HTTP ' + publishRes.getResponseCode() + ' / ' + publishRes.getContentText());
  }

  const publishData = JSON.parse(publishRes.getContentText());
  const publishedKey = (publishData.data && publishData.data.key) || noteKey;

  // note URLを返す（例: https://note.com/{username}/n/{key}）
  const username = publishData.data && publishData.data.user && publishData.data.user.urlname
    ? publishData.data.user.urlname
    : 'me';

  return `https://note.com/${username}/n/${publishedKey}`;
}

// ─────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────

/** note.com API リクエスト用ヘッダーを生成 */
function buildNoteHeaders(session) {
  return {
    'Cookie': session.cookies,
    'X-CSRF-Token': session.csrfToken,
    'Referer': 'https://note.com/',
  };
}

/** レスポンスヘッダーからSet-Cookieを抽出してまとめる */
function extractCookies(headers) {
  const setCookie = headers['Set-Cookie'];
  if (!setCookie) return '';

  const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookieList
    .map(c => c.split(';')[0].trim())
    .join('; ');
}

/** 既存CookieとSet-Cookieをマージ（上書き優先） */
function mergeCookies(existing, incoming) {
  const map = {};

  [existing, incoming].forEach(str => {
    if (!str) return;
    str.split('; ').forEach(pair => {
      const [key, ...rest] = pair.split('=');
      if (key) map[key.trim()] = rest.join('=');
    });
  });

  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ─────────────────────────────────────────
// デバッグ用：各機能を単独でテスト
// ─────────────────────────────────────────

/** トレンドキーワードの取得テスト */
function testGetTrending() {
  Logger.log(getTrendingKeyword());
}

/** Claude API 記事生成テスト */
function testGenerateArticle() {
  const config = getConfig();
  const article = generateArticle(config.claudeApiKey, '桜');
  Logger.log('タイトル: ' + article.title);
  Logger.log('本文:\n' + article.body);
}

/** Unsplash 画像取得テスト */
function testGetImage() {
  const config = getConfig();
  Logger.log(getUnsplashImage(config.unsplashAccessKey, '桜'));
}

/** note.com ログインテスト */
function testLogin() {
  const config = getConfig();
  const session = loginToNote(config.noteEmail, config.notePassword);
  Logger.log('ログイン成功。Cookies: ' + session.cookies.substring(0, 80) + '...');
}
