const http = require('http');
const https = require('https');

const HOST = '127.0.0.1';
const PORT = 8787;
const ALLOWED_PATHS = new Set([
    '/api/customer/Home/GetGoods',
    '/api/customer/Home/Buy',
    '/api/customer/Home/BuyIn',
    '/api/customer/Order/Paging',
    '/api/local/Login',
    '/api/local/CheckLogin',
    '/api/local/LastResult',
    '/api/local/Logout',
    '/api/instagram/latest',
    '/api/tiktok/latest'
]);

let authToken = '';
let lastResult = null;

function send(res, status, body, contentType = 'application/json;charset=utf-8') {
    res.writeHead(status, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Password, X-Fensi-Auth',
        'Content-Type': contentType
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 2 * 1024 * 1024) {
                req.destroy();
                reject(new Error('请求内容过大'));
            }
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function extractAuthTokenFromSetCookie(setCookie) {
    if (!Array.isArray(setCookie)) return '';
    for (const cookie of setCookie) {
        const match = String(cookie).match(/(?:^|;\s*)auth_token=([^;]+)/);
        if (match && match[1]) return decodeURIComponent(match[1]);
    }
    return '';
}

function extractAuthTokenFromBody(body) {
    try {
        const data = JSON.parse(body || '{}');
        return (data && data.data && data.data.token) || data.token || '';
    } catch (e) {
        return '';
    }
}

function stripOpenApiFields(body) {
    try {
        const data = JSON.parse(body || '{}');
        delete data.app_id;
        delete data.app_secret;
        return JSON.stringify(data);
    } catch (e) {
        return body || '';
    }
}

function safeJsonParse(body) {
    try {
        return JSON.parse(body || '{}');
    } catch (e) {
        return body || '';
    }
}

function rememberResult(type, path, requestBody, upstream) {
    lastResult = {
        time: new Date().toISOString(),
        type,
        path,
        request: type === 'login' ? { account: safeJsonParse(requestBody).account || '' } : safeJsonParse(requestBody),
        statusCode: upstream.statusCode,
        response: safeJsonParse(upstream.body),
        responseText: upstream.body
    };
    console.log(`[${lastResult.time}] ${type} ${path} -> HTTP ${upstream.statusCode}: ${String(upstream.body).slice(0, 300)}`);
}

function forwardToFensi(path, method, body, useLogin = false) {
    return new Promise((resolve, reject) => {
        const headers = {
            'Content-Type': 'application/json;charset=utf-8',
            'Content-Length': Buffer.byteLength(body || ''),
            'User-Agent': 'Mozilla/5.0 fensi-local-proxy',
            'Accept': 'application/json, text/plain, */*',
            'Origin': 'https://fensi.icu',
            'Referer': 'https://fensi.icu/'
        };

        if (useLogin && authToken) {
            headers.Cookie = `auth_token=${encodeURIComponent(authToken)}`;
        }

        const req = https.request({
            hostname: 'fensi.icu',
            path,
            method,
            headers,
            timeout: 30000
        }, upstream => {
            let data = '';
            upstream.setEncoding('utf8');
            upstream.on('data', chunk => data += chunk);
            upstream.on('end', () => {
                resolve({
                    statusCode: upstream.statusCode || 502,
                    contentType: upstream.headers['content-type'] || 'application/json;charset=utf-8',
                    setCookie: upstream.headers['set-cookie'] || [],
                    body: data
                });
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('请求 fensi 接口超时'));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function fetchInstagramUrl(url, acceptType) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = https.request({
            hostname: target.hostname,
            path: target.pathname + target.search,
            method: 'GET',
            headers: getInstagramHeaders(acceptType),
            timeout: 30000
        }, upstream => {
            let data = '';
            upstream.setEncoding('utf8');
            upstream.on('data', chunk => data += chunk);
            upstream.on('end', () => {
                resolve({
                    statusCode: upstream.statusCode || 502,
                    body: data
                });
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('请求 Instagram 超时'));
        });
        req.on('error', reject);
        req.end();
    });
}

function fetchTikTokUrl(url, username) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = https.request({
            hostname: target.hostname,
            path: target.pathname + target.search,
            method: 'GET',
            headers: getTikTokHeaders(username),
            timeout: 30000
        }, upstream => {
            let data = '';
            upstream.setEncoding('utf8');
            upstream.on('data', chunk => data += chunk);
            upstream.on('end', () => {
                resolve({
                    statusCode: upstream.statusCode || 502,
                    body: data
                });
            });
        });

        req.on('timeout', () => {
            req.destroy(new Error('请求 TikTok 超时'));
        });
        req.on('error', reject);
        req.end();
    });
}

function normalizeInstagramUsername(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';

    value = value.replace(/^@+/, '').trim();

    try {
        if (/^https?:\/\//i.test(value)) {
            const parsed = new URL(value);
            const parts = parsed.pathname.split('/').filter(Boolean);
            value = parts[0] || '';
        }
    } catch (e) {
        return '';
    }

    value = value.replace(/^@+/, '').replace(/\/+$/, '').trim();
    if (['p', 'reel', 'tv', 'stories', 'explore'].includes(value.toLowerCase())) return '';
    return /^[A-Za-z0-9._]{1,30}$/.test(value) ? value : '';
}

function normalizeTikTokUsername(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';

    try {
        if (/^https?:\/\//i.test(value)) {
            const parsed = new URL(value);
            const parts = parsed.pathname.split('/').filter(Boolean);
            value = (parts.find(part => part.startsWith('@')) || parts[0] || '').replace(/^@+/, '');
        }
    } catch (e) {
        return '';
    }

    value = value.replace(/^@+/, '').replace(/\/+$/, '').trim();
    return /^[A-Za-z0-9._]{1,30}$/.test(value) ? value : '';
}

async function fetchTikTokLatestVideo(username) {
    const upstream = await fetchTikTokUrl(`https://www.tiktok.com/@${encodeURIComponent(username)}`, username);

    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        return {
            ok: false,
            message: `TikTok 主页 HTTP ${upstream.statusCode}`,
            candidates: []
        };
    }

    const candidates = extractTikTokCandidatesFromHtml(upstream.body, username);
    if (candidates.length) {
        return {
            ok: true,
            message: '已提取最新TK视频链接',
            source: 'profile',
            candidates,
            ...candidates[0]
        };
    }

    return {
        ok: false,
        message: 'TikTok 当前没有向转发服务返回作品列表，需要手动复制视频链接',
        candidates
    };
}

function getTikTokHeaders(username) {
    return {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': `https://www.tiktok.com/@${encodeURIComponent(username)}`
    };
}

function extractTikTokCandidatesFromHtml(html, username) {
    const text = decodeEscapedHtml(html);
    const wanted = String(username || '').toLowerCase();
    const seen = new Set();
    const candidates = [];
    const re = /\/@([A-Za-z0-9._]{1,30})\/video\/(\d{5,})/g;
    let match;

    while ((match = re.exec(text))) {
        const foundUser = String(match[1] || '').toLowerCase();
        const videoId = match[2];
        if (wanted && foundUser !== wanted) continue;
        if (seen.has(videoId)) continue;
        seen.add(videoId);

        const context = text.slice(Math.max(0, match.index - 2500), match.index + 3500);
        candidates.push({
            url: `https://www.tiktok.com/@${match[1]}/video/${videoId}`,
            coverUrl: pickTikTokCoverUrl(context),
            videoId,
            type: 'video'
        });
    }

    return candidates;
}

function decodeEscapedHtml(value) {
    return String(value || '')
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/\\u0026/g, '&')
        .replace(/&amp;/g, '&');
}

function pickTikTokCoverUrl(context) {
    const text = decodeEscapedHtml(context);
    const keys = ['cover', 'originCover', 'dynamicCover'];

    for (const key of keys) {
        const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i');
        const match = text.match(re);
        if (match && match[1]) return cleanMediaUrl(match[1]);
    }

    const fallback = text.match(/https:\/\/[^"\s]+?\.(?:jpg|jpeg|png|webp)[^"\s]*/i);
    return fallback ? cleanMediaUrl(fallback[0]) : '';
}

function cleanMediaUrl(value) {
    return decodeEscapedHtml(value)
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\(.)/g, '$1');
}

async function fetchInstagramLatestVideo(username) {
    const candidates = [];
    const feedResult = await fetchInstagramFeed(username);

    if (feedResult.ok) {
        candidates.push(...feedResult.candidates);
        if (feedResult.candidates.length) {
            return {
                ok: true,
                message: '已提取INS最新视频链接',
                source: 'feed',
                candidates,
                ...feedResult.candidates[0]
            };
        }
    }

    const htmlResult = await fetchInstagramProfileHtml(username);
    candidates.push(...htmlResult.candidates);
    if (htmlResult.candidates.length) {
        return {
            ok: true,
            message: '已从主页提取到INS视频链接',
            source: 'profile',
            candidates,
            ...htmlResult.candidates[0]
        };
    }

    const reason = feedResult.message || htmlResult.message || 'Instagram 没有返回可用视频链接';
    return {
        ok: false,
        message: reason.includes('login') || reason.includes('Please wait')
            ? 'Instagram 临时要求登录或限流，请稍后再试，或手动复制视频链接'
            : reason,
        candidates
    };
}

async function fetchInstagramFeed(username) {
    const url = `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=12`;
    const upstream = await fetchInstagramUrl(url, 'json');
    const data = safeJsonParse(upstream.body);

    if (upstream.statusCode < 200 || upstream.statusCode >= 300 || !data || data.status === 'fail') {
        return {
            ok: false,
            message: (data && (data.message || data.error)) || `Instagram feed HTTP ${upstream.statusCode}`,
            candidates: []
        };
    }

    const items = Array.isArray(data.items) ? data.items : [];
    return {
        ok: true,
        message: 'ok',
        candidates: items
            .filter(itemHasVideo)
            .map(itemToInstagramCandidate)
            .filter(Boolean)
    };
}

async function fetchInstagramProfileHtml(username) {
    const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    const upstream = await fetchInstagramUrl(url, 'html');

    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        return {
            ok: false,
            message: `Instagram 主页 HTTP ${upstream.statusCode}`,
            candidates: []
        };
    }

    return {
        ok: true,
        message: 'ok',
        candidates: extractInstagramCandidatesFromHtml(upstream.body)
    };
}

function getInstagramHeaders(type) {
    return {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': type === 'json' ? 'application/json,text/plain,*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'X-IG-App-ID': '936619743392459',
        'Referer': 'https://www.instagram.com/'
    };
}

function itemHasVideo(item) {
    if (!item || typeof item !== 'object') return false;
    if (Number(item.media_type) === 2 || Array.isArray(item.video_versions)) return true;
    if (Array.isArray(item.carousel_media)) return item.carousel_media.some(itemHasVideo);
    return false;
}

function itemToInstagramCandidate(item) {
    const shortcode = item && (item.code || item.shortcode);
    if (!shortcode) return null;

    const type = item.product_type === 'clips' ? 'reel' : 'p';
    const coverUrl = getSmallCoverUrl(item);
    return {
        url: `https://www.instagram.com/${type}/${shortcode}/`,
        coverUrl,
        shortcode,
        type,
        caption: item.caption && item.caption.text ? String(item.caption.text).slice(0, 120) : ''
    };
}

function getSmallCoverUrl(item) {
    if (!item || typeof item !== 'object') return '';

    const direct = pickSmallImageCandidate(item.image_versions2);
    if (direct) return direct;

    if (Array.isArray(item.carousel_media)) {
        const videoChild = item.carousel_media.find(child => Number(child.media_type) === 2 || Array.isArray(child.video_versions));
        const childCover = pickSmallImageCandidate(videoChild && videoChild.image_versions2);
        if (childCover) return childCover;

        const anyChild = item.carousel_media.find(child => child && child.image_versions2);
        const anyCover = pickSmallImageCandidate(anyChild && anyChild.image_versions2);
        if (anyCover) return anyCover;
    }

    return '';
}

function pickSmallImageCandidate(imageVersions) {
    if (!imageVersions || typeof imageVersions !== 'object') return '';

    const candidates = [];
    if (Array.isArray(imageVersions.candidates)) candidates.push(...imageVersions.candidates);

    const additional = imageVersions.additional_candidates || {};
    Object.keys(additional).forEach(key => {
        if (additional[key] && additional[key].url) candidates.push(additional[key]);
    });

    const withUrl = candidates
        .filter(candidate => candidate && candidate.url)
        .sort((a, b) => {
            const aw = Number(a.width || 9999);
            const bw = Number(b.width || 9999);
            return aw - bw;
        });

    const smallEnough = withUrl.find(candidate => Number(candidate.width || 0) >= 140) || withUrl[0];
    return smallEnough ? smallEnough.url : '';
}

function extractInstagramCandidatesFromHtml(html) {
    const text = String(html || '')
        .replace(/\\u002F/g, '/')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&');
    const seen = new Set();
    const candidates = [];
    const re = /\/(reel|p|tv)\/([A-Za-z0-9_-]{5,})/g;
    let match;

    while ((match = re.exec(text))) {
        const type = match[1] === 'tv' ? 'p' : match[1];
        const shortcode = match[2];
        if (seen.has(shortcode)) continue;
        seen.add(shortcode);

        const context = text.slice(Math.max(0, match.index - 1500), match.index + 1500);
        const looksVideo = type === 'reel' ||
            /"is_video"\s*:\s*true/.test(context) ||
            /"media_type"\s*:\s*2/.test(context) ||
            /video_versions|video_url|clips_metadata|GraphVideo/.test(context);

        if (!looksVideo) continue;

        candidates.push({
            url: `https://www.instagram.com/${type}/${shortcode}/`,
            shortcode,
            type,
            caption: ''
        });
    }

    return candidates;
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'OPTIONS') {
            send(res, 204, '');
            return;
        }

        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        if (!ALLOWED_PATHS.has(url.pathname)) {
            send(res, 404, JSON.stringify({ code: 1, message: '不支持的接口路径' }));
            return;
        }

        const method = req.method === 'GET' ? 'GET' : 'POST';
        let body = '';

        if (method === 'GET') {
            body = JSON.stringify(Object.fromEntries(url.searchParams.entries()));
        } else {
            body = await readBody(req);
        }

        if (url.pathname === '/api/local/Logout') {
            authToken = '';
            lastResult = null;
            send(res, 200, JSON.stringify({ code: 0, message: '已清除本地登录状态' }));
            return;
        }

        if (url.pathname === '/api/local/LastResult') {
            send(res, 200, JSON.stringify({
                code: 0,
                message: 'ok',
                data: lastResult || null
            }));
            return;
        }

        if (url.pathname === '/api/instagram/latest') {
            const input = JSON.parse(body || '{}');
            const username = normalizeInstagramUsername(input.profile || input.profileUrl || input.username || input.url || '');

            if (!username) {
                send(res, 400, JSON.stringify({ code: 1, message: '请输入正确的INS主页链接或账号名' }));
                return;
            }

            const result = await fetchInstagramLatestVideo(username);
            if (result.ok) {
                send(res, 200, JSON.stringify({
                    code: 0,
                    message: result.message || '已提取最新INS视频链接',
                    data: {
                        username,
                        url: result.url,
                        coverUrl: result.coverUrl || '',
                        shortcode: result.shortcode,
                        source: result.source,
                        candidates: result.candidates || []
                    }
                }));
                return;
            }

            send(res, 502, JSON.stringify({
                code: 1,
                message: result.message || '没有提取到最新视频链接',
                data: {
                    username,
                    candidates: result.candidates || []
                }
            }));
            return;
        }

        if (url.pathname === '/api/tiktok/latest') {
            const input = JSON.parse(body || '{}');
            const username = normalizeTikTokUsername(input.profile || input.profileUrl || input.username || input.url || '');

            if (!username) {
                send(res, 400, JSON.stringify({ code: 1, message: '请输入正确的TK主页链接或账号名' }));
                return;
            }

            const result = await fetchTikTokLatestVideo(username);
            if (result.ok) {
                send(res, 200, JSON.stringify({
                    code: 0,
                    message: result.message || '已提取最新TK视频链接',
                    data: {
                        username,
                        url: result.url,
                        coverUrl: result.coverUrl || '',
                        videoId: result.videoId,
                        source: result.source,
                        candidates: result.candidates || []
                    }
                }));
                return;
            }

            send(res, 502, JSON.stringify({
                code: 1,
                message: result.message || '没有提取到最新TK视频链接',
                data: {
                    username,
                    candidates: result.candidates || []
                }
            }));
            return;
        }

        if (url.pathname === '/api/local/Login') {
            const input = JSON.parse(body || '{}');
            const account = String(input.account || '').trim();
            const password = String(input.password || '');

            if (!account || !password) {
                send(res, 400, JSON.stringify({ code: 1, message: '请输入账号和密码' }));
                return;
            }

            const loginBody = JSON.stringify({ account, password, accept: '1' });
            const upstream = await forwardToFensi('/api/customer/Login/Verify', 'POST', loginBody, false);
            const cookieToken = extractAuthTokenFromSetCookie(upstream.setCookie);
            const bodyToken = extractAuthTokenFromBody(upstream.body);
            authToken = cookieToken || bodyToken || authToken;
            rememberResult('login', '/api/customer/Login/Verify', loginBody, upstream);

            send(res, upstream.statusCode, upstream.body, upstream.contentType);
            return;
        }

        if (url.pathname === '/api/local/CheckLogin') {
            if (!authToken) {
                send(res, 200, JSON.stringify({ code: 100, message: '本地转发服务还没有登录状态' }));
                return;
            }

            const upstream = await forwardToFensi('/api/customer/Profile/Show', 'POST', '{}', true);
            rememberResult('checkLogin', '/api/customer/Profile/Show', '{}', upstream);
            send(res, upstream.statusCode, upstream.body, upstream.contentType);
            return;
        }

        if ((
            url.pathname === '/api/customer/Home/Buy' ||
            url.pathname === '/api/customer/Home/BuyIn' ||
            url.pathname === '/api/customer/Order/Paging'
        ) && !authToken) {
            send(res, 200, JSON.stringify({ code: 100, message: '请先在本页面登录网站，再提交购买' }));
            return;
        }

        if (url.pathname === '/api/customer/Home/Buy' || url.pathname === '/api/customer/Home/BuyIn') {
            body = stripOpenApiFields(body);
        }

        const upstream = await forwardToFensi(url.pathname, 'POST', body, true);
        rememberResult('forward', url.pathname, body, upstream);
        send(res, upstream.statusCode, upstream.body, upstream.contentType);
    } catch (err) {
        send(res, 500, JSON.stringify({
            code: 1,
            message: err && err.message ? err.message : String(err)
        }));
    }
});

server.listen(PORT, HOST, () => {
    console.log(`fensi local proxy listening: http://${HOST}:${PORT}`);
});
