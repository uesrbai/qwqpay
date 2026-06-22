# 部署指南

## 前提条件

1. **一个公网可访问的 HTTPS 域名**（必须，不能是 IP 或 http）。
   - Stripe Webhook 要求 HTTPS。
   - 企业微信 OAuth 授权、可信域名校验也要求 HTTPS。
2. Node.js 18+（如果用 Docker 部署可以跳过这条）。

部署完成后别忘了回头改两处配置：
- `.env` 里的 `DOMAIN` 改成你的正式域名（`https://你的域名`）。
- Stripe Dashboard 的 Webhook 端点改成 `https://你的域名/webhook/stripe`。
- 企业微信自建应用的「可信域名」改成你的正式域名。

---

## 方式一：云平台一键部署（最省事，适合不想自己管服务器）

以 [Railway](https://railway.app) 为例（Render、Fly.io 类似）：

1. 把这个项目推到一个 GitHub 仓库。
2. Railway 新建项目 -> Deploy from GitHub repo -> 选这个仓库。
3. 平台会自动识别 `package.json` 并执行 `npm install && npm start`。
4. 在 Railway 项目的 Variables 里，把 `.env.example` 里的变量逐一填进去（不要上传 `.env` 文件本身）。
5. 部署成功后，Railway 会给一个 `https://xxx.up.railway.app` 的域名，可以直接用，也可以绑定自己的域名。
6. 把这个域名填回 `.env` 的 `DOMAIN`，并同步更新 Stripe Webhook 和企业微信可信域名配置。

> 优点：免运维、自动 HTTPS、推送代码自动重新部署。免费额度通常够小流量使用，超出后按量付费。

---

## 方式二：自己的服务器（VPS）+ Docker（推荐，适合长期稳定使用）

适用于阿里云/腾讯云/AWS 等任意一台有公网 IP 的 Linux 服务器。

### 1. 服务器上安装 Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. 上传代码到服务器

```bash
# 本地打包上传，或者直接 git clone 你的仓库
scp -r stripe-payment/ user@your-server-ip:/opt/stripe-payment
```

### 3. 配置环境变量

```bash
cd /opt/stripe-payment
cp .env.example .env
vim .env   # 填入所有需要的 key（参考之前整理的清单）
```

### 4. 启动

```bash
docker compose up -d --build
```

服务会跑在服务器的 3000 端口。

### 5. 配置 Nginx 反向代理 + HTTPS

安装 Nginx 和 Certbot：

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```

新建站点配置 `/etc/nginx/sites-available/stripe-payment`：

```nginx
server {
    listen 80;
    server_name 你的域名;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用并申请证书：

```bash
sudo ln -s /etc/nginx/sites-available/stripe-payment /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名   # 自动申请并配置 HTTPS，会自动改写上面的nginx配置加80转443
```

完成后用 `https://你的域名` 即可访问。

### 6. 更新代码后重新部署

```bash
cd /opt/stripe-payment
git pull   # 或重新上传文件
docker compose up -d --build
```

---

## 方式三：不用 Docker，直接用 PM2 跑（适合已经很熟悉的服务器环境）

```bash
# 安装 Node.js（如果还没装）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 PM2（进程守护，崩溃自动重启）
sudo npm install -g pm2

cd /opt/stripe-payment
cp .env.example .env
vim .env
npm install
pm2 start server.js --name stripe-payment
pm2 save
pm2 startup   # 按提示执行输出的命令，设置开机自启
```

Nginx + HTTPS 配置同方式二的第5步。

---

## 部署后自检清单

- [ ] 浏览器打开 `https://你的域名`，能看到收款首页
- [ ] 测试一笔支付（用 Stripe 测试卡 `4242 4242 4242 4242`），确认能跳转、能支付成功
- [ ] `/orders.html` 能查到刚才那笔订单
- [ ] Stripe Dashboard -> Webhooks，确认事件有成功送达（绿色✓），如果配了企业微信群机器人，群里应该收到通知
- [ ] 如果用了员工身份识别（场景D），在企业微信客户端里打开链接，确认首页能显示"当前发起人"
