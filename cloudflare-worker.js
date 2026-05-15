const ALLOWED_PATHS = new Set([
  '/api/customer/Home/GetGoods',
  '/api/customer/Home/Buy',
  '/api/customer/Home/BuyIn',
  '/api/local/Login',
  '/api/local/CheckLogin',
  '/api/local/LastResult',
  '/api/local/Logout',
  '/api/instagram/latest'
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

      if (url.pathname === '/api/instagram/latest') {
        const input = safeJsonParse(body);
        const username = normalizeInstagramUsername(input.profile || input.profileUrl || input.username || input.url || '');

        if (!username) {
          return sendJson({ code: 1, message: '请输入正确的INS主页链接或账号名' }, 400);
        }

        const result = await fetchInstagramLatestVideo(username);
        if (result.ok) {
          return sendJson({
            code: 0,
            message: result.message || '已提取最新INS视频链接',
            data: {
              username,
              url: result.url,
              shortcode: result.shortcode,
              source: result.source,
              candidates: result.candidates || []
            }
          });
        }

        return sendJson({
          code: 1,
          message: result.message || '没有提取到最新视频链接',
          data: {
            username,
            candidates: result.candidates || []
          }
        }, 502);
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
  const response = await fetch(url, { headers: getInstagramHeaders('json') });
  const text = await response.text();
  const data = safeJsonParse(text);

  if (!response.ok || !data || data.status === 'fail') {
    return {
      ok: false,
      message: (data && (data.message || data.error)) || `Instagram feed HTTP ${response.status}`,
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
  const response = await fetch(url, { headers: getInstagramHeaders('html') });
  const text = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      message: `Instagram 主页 HTTP ${response.status}`,
      candidates: []
    };
  }

  return {
    ok: true,
    message: 'ok',
    candidates: extractInstagramCandidatesFromHtml(text)
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
  return {
    url: `https://www.instagram.com/${type}/${shortcode}/`,
    shortcode,
    type,
    caption: item.caption && item.caption.text ? String(item.caption.text).slice(0, 120) : ''
  };
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
