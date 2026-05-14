# Fensi Order Tool

本工具包含一个静态页面、一个本机转发服务，以及一个 Cloudflare Worker 转发服务：

- `index.html`：录入 INS/TK 链接，选择 INS 播放或点赞项目，批量提交购买。
- `fensi_proxy_server.js`：只在本机运行，用来登录 fensi.icu 并转发购买接口。
- `cloudflare-worker.js`：部署到 Cloudflare Workers 后，手机也可以通过公开页面下单。

## 使用方式

1. 启动本机转发服务：

```bash
npm start
```

2. 打开 `index.html`，转发服务地址使用 `http://127.0.0.1:8787`，先登录网站，再添加链接并批量购买。

## 手机免费使用方式

1. 部署 Cloudflare Worker：

```bash
wrangler secret put PROXY_PASSWORD
wrangler deploy
```

2. 打开 GitHub Pages 页面。
3. 在页面里填写：
   - 转发服务地址：`https://ins-tk-proxy.nicsnake-vip.workers.dev`
   - 转发访问密码：部署 Worker 时设置的 `PROXY_PASSWORD`
4. 在页面里登录网站，再添加链接并批量购买。

## 注意

GitHub Pages 只能托管静态页面，不能运行 Node.js 转发服务。手机使用时需要 Cloudflare Worker 这类云端转发服务。

不要把网站账号、密码、AppID、秘钥提交到仓库；页面会把你填写的配置保存在浏览器本地。
也不要把 `PROXY_PASSWORD` 写进仓库，请用 Cloudflare 的 Secret 保存。
