# Stripe 收款系统

最简单的收款系统：输入金额发起支付，或生成可分享的支付链接。

## 功能

1. **立即支付**：在页面选择币种、输入金额，点击按钮，跳转到 Stripe 官方结账页完成支付。支持 HKD / CNY / USD / EUR / GBP。
2. **支付链接**：选择币种、输入金额生成一个固定的 Stripe Payment Link，可以分享给别人，对方点开就能付款（可重复使用）。
3. **查单**：
   - 按订单 ID（Checkout Session ID）精确查询某笔订单的状态、金额、邮箱等信息。
   - 浏览最近的收款记录列表，可按邮箱关键词、支付状态（已支付/未支付）筛选。
   - 访问 `/orders.html` 即可使用。
4. **企业微信集成**（三种场景）：
   - **A. 群机器人通知**：收款成功后（Stripe Webhook 触发），自动推一条消息到企业微信群。
   - **B. 自建应用推送**：在首页生成支付链接后，点「推送到企业微信」，把链接以应用消息形式发给指定员工。
   - **C. 客服发送链接**：客户在企业微信客服会话中，后台调用接口直接把支付链接当消息发给客户。
5. **员工身份识别**：当员工在企业微信客户端内打开收款页时，自动静默识别出是哪个员工发起的收款，所有订单和群通知都会带上"发起人"信息，便于对账和追责。

---

## 企业微信对接配置

### A. 群机器人通知（收款成功自动通知群）

1. 在目标企业微信群里：群设置 -> 群机器人 -> 添加机器人，复制 Webhook 地址。
2. 填入 `.env` 的 `WECOM_BOT_WEBHOOK_URL`。
3. 在 [Stripe Dashboard -> Developers -> Webhooks](https://dashboard.stripe.com/webhooks) 添加端点：
   - URL：`https://你的域名/webhook/stripe`
   - 监听事件：`checkout.session.completed`
   - 创建后复制 **Signing secret**，填入 `.env` 的 `STRIPE_WEBHOOK_SECRET`。
4. 本地调试可以用 Stripe CLI 转发：
   ```
   stripe listen --forward-to localhost:3000/webhook/stripe
   ```
5. 配置完成后，每笔支付成功都会自动推送一条消息到群里。

> 注意：群机器人**没有**金额上限提醒等审核机制，仅用于通知，不能主动拉人发消息，足够覆盖"收款提醒"场景。

### B. 自建应用推送（内部员工查看/操作）

1. 企业微信管理后台（work.weixin.qq.com） -> 应用管理 -> 自建 -> 创建应用。
2. 记录三项信息填入 `.env`：
   - `WECOM_CORP_ID`：「我的企业」页面底部的企业ID
   - `WECOM_APP_SECRET`：刚创建的自建应用详情页里的 Secret
   - `WECOM_AGENT_ID`：自建应用详情页里的 AgentId
3. 在应用详情页「可见范围」里，把需要接收消息的员工加进去。
4. 首页生成支付链接后点击「推送到企业微信」，默认推给全员（`@all`），如需推给指定人，调用接口时传 `touser`（企业微信 userid，多个用 `|` 分隔）。
5. 如果要把收款页面直接**嵌入企业微信工作台**（自建应用主页打开网页）：
   - 自建应用详情页里设置「应用主页」为 `https://你的域名/`
   - 企业微信对网页有域名可信校验，需要在「网页授权及JS-SDK」里添加可信域名，并按提示上传校验文件到网站根目录（放进 `public/` 目录下即可被访问到）。

### C. 客服发送收款链接（微信客户联系）

1. 企业微信管理后台 -> 客户联系 -> 微信客服 -> 创建客服账号，获取 `open_kfid`。
2. 在「API」页面获取客服专属 Secret，填入 `.env` 的 `WECOM_KF_SECRET`（如果你的客服和自建应用共用同一个 Secret，也可以不填，会自动 fallback 到 `WECOM_APP_SECRET`）。
3. 客户发起咨询后，企业微信会通过回调事件告知客服系统该客户的 `external_userid`（需要你自己另外搭建客服消息接收回调，这部分官方文档：https://developer.work.weixin.qq.com/document/path/94670 ）。
4. 拿到 `open_kfid` 和 `external_userid` 后，调用本系统接口即可把支付链接发给客户：
   ```
   POST /api/wecom/send-kf-link
   {
     "open_kfid": "wkXXXXXX",
     "external_userid": "wmXXXXXX",
     "amount": 99.00,
     "productName": "服务费"
   }
   ```
   会自动生成一个新的 Stripe 支付链接，并以「链接卡片」消息发给客户。

### D. 员工身份识别（识别"是谁发起的收款"）

原理：复用场景B的自建应用做 OAuth 网页授权（`snsapi_base`，静默授权，员工无感知，不会弹出确认框）。

1. 前提：已经按场景B配置好 `WECOM_CORP_ID` / `WECOM_APP_SECRET` / `WECOM_AGENT_ID`。
2. 在自建应用详情页 -> 「网页授权及JS-SDK」-> 设置可信域名，添加你的网站域名（去掉 `https://` 前缀，例如 `pay.yourcompany.com`），并按提示下载校验文件放进 `public/` 目录。
3. 把 `.env` 里的 `COOKIE_SECRET` 改成一串随机字符串（用于给身份 cookie 签名，防篡改）。
4. 工作原理：
   - 员工在企业微信里打开收款首页 -> 系统通过 `User-Agent` 判断是企业微信客户端 -> 自动跳转去做静默授权 -> 换回该员工的 `userid` 和姓名 -> 写入 cookie（有效期12小时）-> 跳回收款页。
   - 之后该员工在页面上发起的收款（不管是"立即支付"还是"生成支付链接"）都会自动带上他的身份，记录在 Stripe 订单的 `metadata.operatorName` 里。
   - 查单页面、企业微信群通知里都会显示"发起人"。
5. 如果是从浏览器（非企业微信客户端）打开，不会触发身份识别，"发起人"字段为空，不影响正常收款功能。

> 这套身份识别只能识别**企业内部成员**（即登录了企业微信的本企业员工），无法识别外部客户身份——外部客户的身份识别走的是场景C的客服消息体系（`external_userid`）。

## 使用步骤

1. 注册 Stripe 账号：https://dashboard.stripe.com/register
2. 在 Dashboard -> Developers -> API keys 中获取 **Secret key**（测试环境用 `sk_test_` 开头的）
3. 安装依赖：
   ```
   npm install
   ```
4. 复制 `.env.example` 为 `.env`，填入你的 `STRIPE_SECRET_KEY`：
   ```
   cp .env.example .env
   ```
5. 启动服务：
   ```
   npm start
   ```
6. 浏览器打开 http://localhost:3000

## 测试支付

测试模式下，用 Stripe 提供的测试卡号：
- 卡号：4242 4242 4242 4242
- 任意未来的有效期、任意 CVC、任意邮编

## 上线注意

- 把 `.env` 中的 key 换成正式环境的 `sk_live_` key。
- `DOMAIN` 改成你的真实域名（用于支付完成后跳转）。
- 建议加上 Stripe Webhook 来在服务端可靠地确认订单状态（目前 success 页面是前端查询，适合简单场景；如果要做对账/发货等业务逻辑，推荐用 webhook：https://stripe.com/docs/webhooks ）。

## 文件结构

```
stripe-payment/
├── server.js          # 后端，调用 Stripe API + 企业微信路由
├── wecom.js           # 企业微信对接模块（群机器人/应用消息/客服消息）
├── public/
│   ├── index.html     # 收款首页
│   ├── orders.html    # 查单页面
│   ├── success.html   # 支付成功页
│   └── cancel.html    # 支付取消页
├── package.json
└── .env.example
```
