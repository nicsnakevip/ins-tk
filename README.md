# Fensi Order Tool

本工具包含一个静态页面和一个本机转发服务：

- `index.html`：录入 INS/TK 链接，选择 INS 播放或点赞项目，批量提交购买。
- `fensi_proxy_server.js`：只在本机运行，用来登录 fensi.icu 并转发购买接口。

## 使用方式

1. 启动本机转发服务：

```bash
npm start
```

2. 打开 `index.html`，先登录网站，再添加链接并批量购买。

## 注意

GitHub Pages 只能托管静态页面，不能运行 Node.js 转发服务。真实下单前仍需要在自己的电脑上启动 `fensi_proxy_server.js`。

不要把网站账号、密码、AppID、秘钥提交到仓库；页面会把你填写的配置保存在浏览器本地。
