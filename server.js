// server.js
// 简单的 Stripe 收款系统后端
// 功能1：输入金额 -> 创建 Checkout Session -> 跳转支付
// 功能2：输入金额 -> 创建 Payment Link -> 返回可分享的支付链接

require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const Stripe = require('stripe');
const wecom = require('./wecom');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.DOMAIN || `http://localhost:${PORT}`;
const CURRENCY = process.env.CURRENCY || 'cny'; // 默认币种（前端未传时使用）
const ALLOWED_CURRENCIES = ['hkd', 'cny', 'usd', 'eur', 'gbp'];

function resolveCurrency(input) {
  const c = (input || CURRENCY).toLowerCase();
  if (!ALLOWED_CURRENCIES.includes(c)) {
    throw new Error(`不支持的币种: ${input}`);
  }
  return c;
}

// ---------- Stripe Webhook（必须放在 express.json() 之前，需要原始 body 做签名校验） ----------
// 在 Stripe Dashboard -> Developers -> Webhooks 添加端点：{DOMAIN}/webhook/stripe
// 监听事件：checkout.session.completed
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook 签名校验失败:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const order = {
        id: session.id,
        productName: session.metadata && session.metadata.productName,
        operatorName: session.metadata && session.metadata.operatorName,
        amount: session.amount_total != null ? (session.amount_total / 100).toFixed(2) : '-',
        currency: session.currency ? session.currency.toUpperCase() : '',
        email: session.customer_details ? session.customer_details.email : '',
        created: new Date().toLocaleString('zh-CN'),
      };
      // 收款成功 -> 推送到企业微信群机器人
      try {
        await wecom.notifyGroupRobot(order);
      } catch (e) {
        console.error('企业微信群通知失败:', e.message);
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'change-this-secret'));

// ---------- 企业微信员工身份识别 ----------
// 1) 自动检测：如果是从企业微信客户端打开收款页，且还没识别出身份，自动跳去做静默授权
app.use((req, res, next) => {
  const ua = req.headers['user-agent'] || '';
  const isWecomClient = /wxwork/i.test(ua);
  const isPageRequest = req.method === 'GET' && (req.path === '/' || req.path === '/index.html');
  const alreadyIdentified = req.signedCookies && req.signedCookies.wecom_uid;

  if (isWecomClient && isPageRequest && !alreadyIdentified && process.env.WECOM_CORP_ID) {
    const redirectUri = `${DOMAIN}/wecom/oauth/callback`;
    const oauthUrl = wecom.buildOauthUrl(redirectUri, req.path);
    return res.redirect(oauthUrl);
  }
  next();
});

app.use(express.static('public'));

// 2) OAuth 回调：用 code 换 userid，写入 cookie，再跳回原页面
app.get('/wecom/oauth/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const userid = await wecom.getUserIdByCode(code);
    const detail = await wecom.getUserDetail(userid).catch(() => ({ userid, name: userid }));

    res.cookie('wecom_uid', userid, { signed: true, httpOnly: true, maxAge: 12 * 60 * 60 * 1000 });
    res.cookie('wecom_name', detail.name || userid, { httpOnly: true, maxAge: 12 * 60 * 60 * 1000 });

    res.redirect(state && state.startsWith('/') ? state : '/');
  } catch (err) {
    console.error('企业微信授权失败:', err.message);
    res.status(400).send('企业微信身份识别失败: ' + err.message);
  }
});

// 3) 前端查询"当前识别出的操作人"
app.get('/api/whoami', (req, res) => {
  const userid = req.signedCookies && req.signedCookies.wecom_uid;
  const name = req.cookies && req.cookies.wecom_name;
  if (!userid) return res.json({ identified: false });
  res.json({ identified: true, userid, name: name || userid });
});

// ---------- 工具函数 ----------
// 校验并转换金额为最小货币单位（如分）
function toMinorUnit(amount) {
  const num = Number(amount);
  if (!num || num <= 0) throw new Error('金额无效');
  // 大多数货币（含 cny/usd）最小单位是 1/100
  return Math.round(num * 100);
}

// ---------- 接口1：输入金额，发起一次性 Checkout 支付 ----------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { amount, currency, productName } = req.body;
    const unitAmount = toMinorUnit(amount);
    const curr = resolveCurrency(currency);
    const operatorUserId = req.signedCookies && req.signedCookies.wecom_uid;
    const operatorName = req.cookies && req.cookies.wecom_name;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: curr,
            product_data: {
              name: productName || '收款',
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      metadata: {
        productName: productName || '收款',
        operatorUserId: operatorUserId || '',
        operatorName: operatorName || '',
      },
      success_url: `${DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/cancel.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ---------- 接口2：输入金额，生成可重复使用/分享的支付链接 ----------
app.post('/api/create-payment-link', async (req, res) => {
  try {
    const { amount, currency, productName } = req.body;
    const unitAmount = toMinorUnit(amount);
    const curr = resolveCurrency(currency);
    const operatorUserId = req.signedCookies && req.signedCookies.wecom_uid;
    const operatorName = req.cookies && req.cookies.wecom_name;

    // Payment Link 需要先创建一个 Price
    const price = await stripe.prices.create({
      currency: curr,
      unit_amount: unitAmount,
      product_data: {
        name: productName || '收款',
      },
    });

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          price: price.id,
          quantity: 1,
        },
      ],
      metadata: {
        productName: productName || '收款',
        operatorUserId: operatorUserId || '',
        operatorName: operatorName || '',
      },
    });

    res.json({ url: paymentLink.url });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ---------- 查询支付结果（success 页面用） ----------
app.get('/api/session/:id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id);
    res.json(session);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- 查单功能 ----------

// 格式化单条 Checkout Session 为前端友好的字段
function formatOrder(session) {
  const metadata = session.metadata || {};
  return {
    id: session.id,
    status: session.status,                 // open / complete / expired
    payment_status: session.payment_status,  // paid / unpaid / no_payment_required
    amount: session.amount_total != null ? (session.amount_total / 100).toFixed(2) : null,
    currency: session.currency ? session.currency.toUpperCase() : '',
    email: session.customer_details ? session.customer_details.email : (session.customer_email || ''),
    productName:
      metadata.productName ||
      (session.line_items && session.line_items.data && session.line_items.data[0]
        ? session.line_items.data[0].description
        : ''),
    operatorName: metadata.operatorName || '',
    created: session.created ? new Date(session.created * 1000).toLocaleString('zh-CN') : '',
    url: session.url,
  };
}

// 1) 按 Session ID 精确查单
app.get('/api/orders/:id', async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.id, {
      expand: ['line_items', 'customer_details'],
    });
    res.json(formatOrder(session));
  } catch (err) {
    res.status(404).json({ error: '未找到该订单，请检查 ID 是否正确' });
  }
});

// 2) 列表查单：最近的收款记录，可选按邮箱/状态筛选
app.get('/api/orders', async (req, res) => {
  try {
    const { email, status, limit } = req.query;

    const listParams = { limit: Number(limit) || 20 };
    const list = await stripe.checkout.sessions.list(listParams);

    let orders = list.data.map(formatOrder);

    if (email) {
      const kw = email.toLowerCase();
      orders = orders.filter((o) => (o.email || '').toLowerCase().includes(kw));
    }
    if (status) {
      orders = orders.filter((o) => o.payment_status === status || o.status === status);
    }

    res.json({ orders });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ---------- 企业微信集成 ----------

// 场景B：把生成的支付链接，通过自建应用推给指定员工（比如财务/销售自己内部使用）
// touser 是企业微信里的 userid，多个用 | 分隔，不传则默认推给 @all
app.post('/api/wecom/send-app-message', async (req, res) => {
  try {
    const { touser, title, description, url } = req.body;
    if (!url) throw new Error('缺少 url');
    const result = await wecom.sendAppMessage({ touser, title, description, url });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 场景C：客服在与客户的会话中，直接把支付链接当作消息发出去
// 需要先在「客户联系-微信客服」创建客服账号，拿到 open_kfid
// external_userid 是发起会话的客户在企业微信里的标识，由企业微信客服消息回调事件中获得
app.post('/api/wecom/send-kf-link', async (req, res) => {
  try {
    const { open_kfid, external_userid, amount, currency, productName } = req.body;
    if (!open_kfid || !external_userid) throw new Error('缺少 open_kfid 或 external_userid');

    // 直接复用"生成支付链接"逻辑
    const unitAmount = toMinorUnit(amount);
    const curr = resolveCurrency(currency);
    const price = await stripe.prices.create({
      currency: curr,
      unit_amount: unitAmount,
      product_data: { name: productName || '收款' },
    });
    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
    });

    const result = await wecom.sendKfPaymentLink({
      open_kfid,
      external_userid,
      url: paymentLink.url,
      title: productName || '请完成支付',
      description: `金额：${amount} ${curr.toUpperCase()}`,
    });

    res.json({ ok: true, url: paymentLink.url, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`服务已启动: ${DOMAIN}`);
});
