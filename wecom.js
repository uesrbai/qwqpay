// wecom.js
// 企业微信对接：
// 1) 群机器人 webhook 通知（收款成功后推送到群）
// 2) 自建应用消息（给指定员工/部门推送通知或链接）
// 3) 客服消息（微信客户联系-客服，给客户发收款链接）

const axios = require('axios');

const CORP_ID = process.env.WECOM_CORP_ID;
const APP_SECRET = process.env.WECOM_APP_SECRET;   // 自建应用 secret（用于应用消息 + 客服消息共用同一套 access_token 体系，但通常客服用专属secret，见下方说明）
const AGENT_ID = process.env.WECOM_AGENT_ID;        // 自建应用 AgentId
const BOT_WEBHOOK_URL = process.env.WECOM_BOT_WEBHOOK_URL; // 群机器人 webhook 完整地址

// access_token 简单内存缓存（生产环境建议换成 redis 等持久化缓存）
let tokenCache = { token: null, expireAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expireAt) {
    return tokenCache.token;
  }
  if (!CORP_ID || !APP_SECRET) {
    throw new Error('未配置 WECOM_CORP_ID / WECOM_APP_SECRET');
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${APP_SECRET}`;
  const { data } = await axios.get(url);
  if (data.errcode !== 0) {
    throw new Error(`获取企业微信 access_token 失败: ${data.errmsg}`);
  }
  tokenCache = {
    token: data.access_token,
    expireAt: Date.now() + (data.expires_in - 200) * 1000, // 提前200秒过期，留余量
  };
  return tokenCache.token;
}

// ---------- 员工身份识别（网页授权 OAuth，用于识别"是谁在企业微信里发起收款"） ----------

// 构造企业微信网页授权跳转链接（静默授权，scope=snsapi_base，不弹确认框）
function buildOauthUrl(redirectUri, state) {
  const encodedRedirect = encodeURIComponent(redirectUri);
  return (
    `https://open.weixin.qq.com/connect/oauth2/authorize` +
    `?appid=${CORP_ID}` +
    `&redirect_uri=${encodedRedirect}` +
    `&response_type=code` +
    `&scope=snsapi_base` +
    `&state=${encodeURIComponent(state || '')}` +
    `&agentid=${AGENT_ID}` +
    `#wechat_redirect`
  );
}

// 用 code 换取发起请求的员工 userid
async function getUserIdByCode(code) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/getuserinfo?access_token=${token}&code=${code}`;
  const { data } = await axios.get(url);
  if (data.errcode !== 0) {
    throw new Error(`OAuth 获取 userid 失败: ${data.errmsg}`);
  }
  // 企业内部成员会直接返回 UserId；非企业成员（外部联系人）只会有 OpenId，这里只处理内部员工场景
  if (!data.UserId) {
    throw new Error('未识别到企业成员身份（可能是企业外部访问）');
  }
  return data.UserId;
}

// 根据 userid 查询员工姓名等信息，用于展示"发起人"
async function getUserDetail(userid) {
  const token = await getAccessToken();
  const url = `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${encodeURIComponent(userid)}`;
  const { data } = await axios.get(url);
  if (data.errcode !== 0) {
    throw new Error(`获取员工信息失败: ${data.errmsg}`);
  }
  return { userid: data.userid, name: data.name, department: data.department };
}


// 收款成功后，推送一条 markdown 消息到企业微信群
async function notifyGroupRobot(order) {
  if (!BOT_WEBHOOK_URL) {
    console.warn('未配置 WECOM_BOT_WEBHOOK_URL，跳过群机器人通知');
    return;
  }
  const content =
    `### 💰 收到一笔新付款\n` +
    `> 商品：${order.productName || '-'}\n` +
    `> 金额：<font color="info">${order.amount} ${order.currency}</font>\n` +
    `> 邮箱：${order.email || '-'}\n` +
    (order.operatorName ? `> 发起人：${order.operatorName}\n` : '') +
    `> 订单号：${order.id}\n` +
    `> 时间：${order.created}`;

  await axios.post(BOT_WEBHOOK_URL, {
    msgtype: 'markdown',
    markdown: { content },
  });
}

// ---------- 2) 自建应用消息 ----------
// 给指定员工（userid，多个用 | 分隔）推送应用内文本/链接卡片消息
async function sendAppMessage({ touser, title, description, url }) {
  const token = await getAccessToken();
  const api = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

  const payload = {
    touser: touser || '@all',
    msgtype: 'textcard',
    agentid: AGENT_ID,
    textcard: {
      title: title || '收款通知',
      description: description || '点击查看详情',
      url: url,
      btntxt: '查看',
    },
  };

  const { data } = await axios.post(api, payload);
  if (data.errcode !== 0) {
    throw new Error(`发送应用消息失败: ${data.errmsg}`);
  }
  return data;
}

// ---------- 3) 客服消息（微信客户联系） ----------
// 给客户（external_userid）通过指定客服账号（open_kfid）发送一条链接卡片，附带支付链接
// 注意：这个接口走的是「微信客服」体系，需要在 客户联系 -> 微信客服 中创建客服账号，
// 并使用对应的 secret 获取 access_token（与自建应用的 secret 可能不同，请在 .env 配置 WECOM_KF_SECRET）
async function getKfAccessToken() {
  const secret = process.env.WECOM_KF_SECRET || APP_SECRET;
  if (!CORP_ID || !secret) {
    throw new Error('未配置 WECOM_CORP_ID / WECOM_KF_SECRET');
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${secret}`;
  const { data } = await axios.get(url);
  if (data.errcode !== 0) {
    throw new Error(`获取客服 access_token 失败: ${data.errmsg}`);
  }
  return data.access_token;
}

async function sendKfPaymentLink({ open_kfid, external_userid, url, title, description }) {
  const token = await getKfAccessToken();
  const api = `https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=${token}`;

  const payload = {
    touser: external_userid,
    open_kfid,
    msgtype: 'link',
    link: {
      title: title || '请完成支付',
      desc: description || '点击链接完成支付',
      url,
    },
  };

  const { data } = await axios.post(api, payload);
  if (data.errcode !== 0) {
    throw new Error(`客服消息发送失败: ${data.errmsg}`);
  }
  return data;
}

module.exports = {
  notifyGroupRobot,
  sendAppMessage,
  sendKfPaymentLink,
  buildOauthUrl,
  getUserIdByCode,
  getUserDetail,
};
