import crypto from 'crypto';
import loggerModule from '../utils/logger.js';
import { verifyParams } from '../utils/alipay.js';
const { logger } = loggerModule;

/**
 * Webhook 签名验证中间件
 * 
 * 支持多种支付渠道的签名验证：
 * 1. 微信支付（APIv3 - RSA SHA256）
 * 2. 支付宝（RSA2-SHA256）
 * 3. Stripe（HMAC-SHA256）
 */

// Stripe SDK（延迟导入）
let stripeModule = null;

/**
 * 安全导入Stripe SDK
 */
async function loadStripeSDK() {
  if (stripeModule !== null) {
    return stripeModule;
  }
  
  try {
    const Stripe = (await import('stripe')).default;
    stripeModule = Stripe;
    return Stripe;
  } catch (err) {
    logger.info('Stripe SDK not available, will use manual verification');
    stripeModule = false;
    return null;
  }
}

/**
 * 创建微信支付 Webhook 签名验证中间件
 */
export function createWeChatSignatureVerifier(apiV3Key, mchId) {
  return async (req, res, next) => {
    try {
      const authHeader = req.headers['authorization'];
      
      if (!authHeader) {
        logger.warn('WeChat Pay webhook: Missing Authorization header');
        return res.status(401).json({ code: 'FAIL', message: 'Missing Authorization header' });
      }
      
      // 解析Authorization头
      const authParts = {};
      const authValue = authHeader.replace('WECHATPAY2-SHA256-RSA2048 ', '');
      authValue.split(',').forEach(part => {
        const eqIndex = part.indexOf('=');
        if (eqIndex > -1) {
          const key = part.substring(0, eqIndex).trim();
          const value = part.substring(eqIndex + 1).replace(/"/g, '').trim();
          authParts[key] = value;
        }
      });
      
      const { mchid, nonce_str, timestamp, serial_no, signature } = authParts;
      
      if (mchid !== mchId) {
        logger.warn('WeChat Pay webhook: Invalid mchid');
        return res.status(401).json({ code: 'FAIL', message: 'Invalid mchid' });
      }
      
      // 微信支付 APIv3 签名验证
      // 文档：https://pay.weixin.qq.com/doc/v3/merchant/4012791858
      // 验证步骤：
      // 1. 使用 serial_no 获取平台证书（从微信API或本地缓存）
      // 2. 用证书公钥 RSA-SHA256 验证 signature
      // 3. 验证 timestamp 防止重放攻击（允许误差 ±5分钟）
      
      const WECHAT_PAY_PLATFORM_CERT = process.env.WECHAT_PAY_PLATFORM_CERT || '';
      
      if (!WECHAT_PAY_PLATFORM_CERT) {
        logger.error('WeChat Pay: WECHAT_PAY_PLATFORM_CERT not configured');
        return res.status(500).json({ code: 'FAIL', message: 'Platform certificate not configured' });
      }
      
      // 验证时间戳（防重放攻击）
      const now = Math.floor(Date.now() / 1000);
      const timeDiff = now - parseInt(timestamp, 10);
      if (timeDiff > 300 || timeDiff < -300) {
        logger.warn('WeChat Pay webhook: Timestamp out of range', { timeDiff });
        return res.status(401).json({ code: 'FAIL', message: 'Timestamp out of range' });
      }
      
      // 构造验签名串：HTTP请求方法 + \n + URL + \n + 时间戳 + \n + 随机字符串 + \n + 请求正文 + \n
      const url = `/api/webhooks/wechat-pay`;
      const nonce = nonce_str;
      const body = JSON.stringify(req.body) || '';
      const signMessage = `POST\n${url}\n${timestamp}\n${nonce}\n${body}\n`;
      
      // 使用平台证书公钥验证签名
      try {
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(signMessage, 'utf8');
        
        const isValid = verifier.verify(WECHAT_PAY_PLATFORM_CERT, signature, 'base64');
        
        if (!isValid) {
          logger.warn('WeChat Pay webhook: Invalid signature');
          return res.status(401).json({ code: 'FAIL', message: 'Invalid signature' });
        }
        
        logger.info('WeChat Pay webhook: Signature verified');
        next();
      } catch (err) {
        logger.error('WeChat Pay signature verification error:', err);
        return res.status(500).json({ code: 'FAIL', message: 'Verification error' });
      }
    } catch (err) {
      logger.error('WeChat Pay signature verification error:', err);
      res.status(500).json({ code: 'FAIL', message: 'Verification failed' });
    }
  };
}

/**
 * 校验支付宝异步通知/响应签名（纯函数，返回 boolean）。
 *
 * 为什么委托给 utils/alipay.js：
 * 这里曾自己拼签名串，规则大体对（排 sign + sign_type、滤空值），但有三个坑：
 *   1. **不补 PEM 头** —— 支付宝后台复制的公钥是单行 base64，直接丢给
 *      `verifier.verify()` 会抛 `no start line`，被 catch 成 500 而不是验签失败；
 *   2. 与下单侧（签名）各写一份规则，两边容易漂移；
 *   3. `req.body` 曾因 rawBody 中间件被吃空（见 index.js 同名修复），
 *      此处拿到的是 `{}`，会静默走到「缺 sign」分支。
 * 现在统一走一处实现，并由 tests/alipay.test.js 锁定规则。
 *
 * @param {object} params 回调参数（已解码；勿再手动 decode）
 * @returns {boolean}
 */
export function verifyAlipayNotify(params) {
  if (!params || typeof params !== 'object') return false;

  const { sign, sign_type: signType } = params;
  if (!sign) {
    logger.warn('Alipay notify: missing sign parameter');
    return false;
  }

  const ok = verifyParams(params, sign, signType || 'RSA2');
  if (ok) {
    logger.info('Alipay notify: signature verified');
  } else {
    logger.warn('Alipay notify: invalid signature');
  }
  return ok;
}

/**
 * 创建支付宝 Webhook 签名验证中间件（保留旧签名，供既有调用方使用）。
 *
 * @param {string} [alipayPublicKey] 显式公钥；省略时由 utils/alipay.js 从 env 读取
 */
export function createAlipaySignatureVerifier(alipayPublicKey) {
  return (req, res, next) => {
    try {
      // 显式传入的公钥优先（测试用），否则回落 env
      if (alipayPublicKey) process.env.ALIPAY_PUBLIC_KEY = alipayPublicKey;

      const params = { ...(req.body || {}) };
      if (!params.sign) {
        logger.warn('Alipay webhook: Missing sign parameter');
        return res.status(401).send('failure');
      }

      if (!verifyParams(params, params.sign, params.sign_type || 'RSA2')) {
        logger.warn('Alipay webhook: Invalid signature');
        return res.status(401).send('failure');
      }

      logger.info('Alipay webhook: Signature verified');
      return next();
    } catch (err) {
      logger.error('Alipay signature verification error:', err);
      return res.status(500).send('failure');
    }
  };
}

/**
 * 创建 Stripe Webhook 签名验证中间件
 */
export function createStripeSignatureVerifier(endpointSecret) {
  return async (req, res, next) => {
    try {
      const signature = req.headers['stripe-signature'];
      
      if (!signature) {
        logger.warn('Stripe webhook: Missing stripe-signature header');
        return res.status(401).send('Webhook signature missing');
      }
      
      const rawBody = req.rawBody;
      
      if (!rawBody) {
        logger.error('Stripe webhook: Raw body not available');
        return res.status(500).send('Raw body not available');
      }
      
      // 尝试使用Stripe SDK
      const Stripe = await loadStripeSDK();
      
      if (Stripe && process.env.STRIPE_SECRET_KEY) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
            apiVersion: '2023-10-16',
          });
          const event = stripe.webhooks.constructEvent(rawBody, signature, endpointSecret);
          req.stripeEvent = event;
          logger.info('Stripe webhook: Verified using SDK');
          next();
        } catch (err) {
          logger.warn('Stripe webhook: SDK verification failed', { error: err.message });
          return res.status(401).send(`Verification failed: ${err.message}`);
        }
      } else {
        // 手动验证
        logger.info('Stripe webhook: Using manual verification');
        
        const elements = signature.split(',');
        const timestamp = elements.find(el => el.startsWith('t='))?.split('=')[1];
        const signatures = elements
          .filter(el => el.startsWith('v1='))
          .map(el => el.split('=')[1]);
        
        if (!timestamp || signatures.length === 0) {
          logger.warn('Stripe webhook: Invalid signature format');
          return res.status(401).send('Invalid signature format');
        }
        
        const signedPayload = `${timestamp}.${rawBody}`;
        const expectedSignature = crypto
          .createHmac('sha256', endpointSecret)
          .update(signedPayload)
          .digest('hex');
        
        const isValid = signatures.some(sig => {
          try {
            return crypto.timingSafeEqual(
              Buffer.from(sig, 'hex'),
              Buffer.from(expectedSignature, 'hex')
            );
          } catch (e) {
            return false;
          }
        });
        
        if (!isValid) {
          logger.warn('Stripe webhook: Invalid signature (manual)');
          return res.status(401).send('Signature verification failed');
        }
        
        logger.info('Stripe webhook: Verified manually');
        req.stripeEvent = JSON.parse(rawBody);
        next();
      }
    } catch (err) {
      logger.error('Stripe signature verification error:', err);
      res.status(500).send('Verification error');
    }
  };
}

/**
 * 通用 Webhook 签名验证中间件
 */
export function webhookSignatureVerifier(req, res, next) {
  const path = req.path.toLowerCase();
  
  if (path.includes('wechat')) {
    const apiV3Key = process.env.WECHAT_PAY_APIV3_KEY;
    const mchId = process.env.WECHAT_PAY_MCH_ID;
    
    if (!apiV3Key || !mchId) {
      logger.error('WeChat Pay config missing');
      return res.status(500).json({ code: 'FAIL', message: 'Not configured' });
    }
    
    return createWeChatSignatureVerifier(apiV3Key, mchId)(req, res, next);
  }
  
  if (path.includes('alipay')) {
    const publicKey = process.env.ALIPAY_PUBLIC_KEY;
    
    if (!publicKey) {
      logger.error('Alipay config missing');
      return res.status(500).send('Not configured');
    }
    
    return createAlipaySignatureVerifier(publicKey)(req, res, next);
  }
  
  if (path.includes('stripe')) {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    
    if (!endpointSecret) {
      logger.error('Stripe config missing');
      return res.status(500).send('Not configured');
    }
    
    return createStripeSignatureVerifier(endpointSecret)(req, res, next);
  }
  
  logger.warn('Unknown webhook path', { path });
  res.status(400).json({ error: 'Unknown webhook path' });
}

export default webhookSignatureVerifier;
