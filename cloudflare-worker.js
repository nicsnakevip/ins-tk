const ALLOWED_PATHS = new Set([
  '/api/customer/Home/GetGoods',
  '/api/customer/Home/Buy',
  '/api/customer/Home/BuyIn',
  '/api/local/Login',
  '/api/local/CheckLogin',
  '/api/local/LastResult',
  '/api/local/Logout'
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Proxy-Password, X-Fensi-Auth',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      if (!ALLOWED_PATHS.has(url.pathname)) {
        return sendJson({ code: 1, message: '不支持的接口路径' }, 404);
      }

      const passwordCheck = checkProxyPassword(request, env);
      if (!passwordCheck.ok) return sendJson(passwordCheck.body, passwordCheck.status);

      const method = request.method === 'GET' ? 'GET' : 'POST';
      let body = method === 'GET'
        ? JSON.stringify(Object.fromEntries(url.searchParams.entries()))
        : await request.text();

      if (url.pathname === '/api/local/Logout') {
        return sendJson({ code: 0, message: '已清除当前浏览器登录状态' });
      }

      if (url.pathname === '/api/local/LastResult') {
        return sendJson({ code: 0, message: 'Cloudflare Worker 不保存最近请求记录', data: null });
      }

      if (url.pathname === '/api/local/Login') {
        const input = safeJsonParse(body);
        const account = String(input.account || '').trim();
        const password = String(input.password || '');

        if (!account || !password) {
          return sendJson({ code: 1, message: '请输入账号和密码' }, 400);
        }

        const loginBody = JSON.stringify({ account, password, accept: '1' });
        const upstream = await forwardToFensi('/api/customer/Login/Verify', loginBody, '');
        const token = extractAuthTokenFromSetCookie(upstream.headers) || extractAuthTokenFromBody(upstream.body);
        return sendUpstreamWithToken(upstream, token);
      }

      const authToken = getAuthTokenFromRequest(request);
      if (url.pathname === '/api/local/CheckLogin') {
        if (!authToken) {
          return sendJson({ code: 100, message: '当前浏览器还没有登录状态，请先登录网站' });
        }

        const upstream = await forwardToFensi('/api/customer/Profile/Show', '{}', authToken);
        return sendUpstream(upstream);
      }

      if ((url.pathname === '/api/customer/Home/Buy' || url.pathname === '/api/customer/Home/BuyIn') && !authToken) {
        return sendJson({ code: 100, message: '请先在本页面登录网站，再提交购买' });
      }

      if (url.pathname === '/api/customer/Home/Buy' || url.pathname === '/api/customer/Home/BuyIn') {
        body = stripOpenApiFields(body);
      }

      const upstream = await forwardToFensi(url.pathname, body, authToken);
      return sendUpstream(upstream);
    } catch (err) {
      return sendJson({ code: 1, message: err && err.message ? err.message : String(err) }, 500);
    }
  }
};

function checkProxyPassword(request, env) {
  const expected = String(env.PROXY_PASSWORD || '').trim();
  if (!expected) {
    return {
      ok: false,
      status: 500,
      body: { code: 1, message: 'Cloudflare Worker 还没有设置 PROXY_PASSWORD 访问密码' }
    };
  }

  const got = String(request.headers.get('X-Proxy-Password') || '').trim();
  if (got !== expected) {
    return {
      ok: false,
      status: 401,
      body: { code: 1, message: '转发访问密码不正确' }
    };
  }

  return { ok: true };
}

async function forwardToFensi(path, body, authToken) {
  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    'User-Agent': 'Mozilla/5.0 fensi-cloudflare-worker',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://fensi.icu',
    'Referer': 'https://fensi.icu/'
  };

  if (authToken) {
    headers.Cookie = `auth_token=${encodeURIComponent(authToken)}`;
  }

  const response = await fetch('https://fensi.icu' + path, {
    method: 'POST',
    headers,
    body: body || '{}'
  });

  return {
    status: response.status,
    contentType: response.headers.get('content-type') || 'application/json;charset=utf-8',
    headers: response.headers,
    body: await response.text()
  };
}

function sendUpstream(upstream) {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: Object.assign({}, CORS_HEADERS, {
      'Content-Type': upstream.contentType
    })
  });
}

function sendUpstreamWithToken(upstream, token) {
  if (!token) return sendUpstream(upstream);

  const data = safeJsonParse(upstream.body);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return sendUpstream(upstream);

  data.local_auth_token = token;
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) {
    data.data.local_auth_token = token;
  }

  return new Response(JSON.stringify(data), {
    status: upstream.status,
    headers: Object.assign({}, CORS_HEADERS, {
      'Content-Type': 'application/json;charset=utf-8'
    })
  });
}

function sendJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({}, CORS_HEADERS, {
      'Content-Type': 'application/json;charset=utf-8'
    })
  });
}

function safeJsonParse(body) {
  try {
    return JSON.parse(body || '{}');
  } catch (e) {
    return {};
  }
}

function getAuthTokenFromRequest(request) {
  const raw = request.headers.get('X-Fensi-Auth') || request.headers.get('Authorization') || '';
  return String(raw).replace(/^Bearer\s+/i, '').trim();
}

function extractAuthTokenFromSetCookie(headers) {
  const getSetCookie = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  const values = getSetCookie.length ? getSetCookie : [headers.get('set-cookie') || ''];

  for (const value of values) {
    const match = String(value).match(/(?:^|[,;]\s*)auth_token=([^;,\s]+)/);
    if (match && match[1]) return decodeURIComponent(match[1]);
  }

  return '';
}

function extractAuthTokenFromBody(body) {
  const data = safeJsonParse(body);
  return (data && data.data && (data.data.token || data.data.auth_token)) || data.token || data.auth_token || '';
}

function stripOpenApiFields(body) {
  const data = safeJsonParse(body);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return body || '{}';
  delete data.app_id;
  delete data.app_secret;
  return JSON.stringify(data);
}
