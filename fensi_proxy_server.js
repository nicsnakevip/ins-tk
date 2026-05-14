const http = require('http');
const https = require('https');

const HOST = '127.0.0.1';
const PORT = 8787;
const ALLOWED_PATHS = new Set([
    '/api/customer/Home/GetGoods',
    '/api/customer/Home/Buy',
    '/api/customer/Home/BuyIn',
    '/api/local/Login',
    '/api/local/CheckLogin',
    '/api/local/LastResult',
    '/api/local/Logout'
]);

let authToken = '';
let lastResult = null;

function send(res, status, body, contentType = 'application/json;charset=utf-8') {
    res.writeHead(status, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

        if ((url.pathname === '/api/customer/Home/Buy' || url.pathname === '/api/customer/Home/BuyIn') && !authToken) {
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
