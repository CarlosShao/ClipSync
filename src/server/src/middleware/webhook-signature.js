import crypto from 'crypto';
import loggerModule from '../utils/logger.js';
const { logger } = loggerModule;

/**
 * Webhook 签名验证中间件
 * 
 * 支持多种支付渠道的签名验证：
 * 1. 微信支付（HMAC-SHA256）
 * 2. 支付宝（RSA2-SHA256）
 * 3. Stripe（HMAC-SHA256）
 * 
 * 为每个支付渠道创建独立的中间件实例。
 */

/**
 * 创建微信支付 Webhook 签名验证中间件
 * @param {string} apiSecret - 微信支付 APIv3 密钥
 * @returns {Function} Express 中间件
 */
export function createWeChatSignatureVerifier(apiSecret) {
  return async (req, res, next) => {
    try {
      const signature = req.headers['x-wxp-signature'];
      const timestamp = req.headers['x-wxp-timestamp'];
      const nonce = req.headers['x-wxp-nonce'];
      
      if (!signature || !timestamp || !nonce) {
        logger.warn('WeChat Pay webhook: Missing signature headers');
        return res.status(401).json({ error: 'Missing signature headers' });
      }
      
      // 构造验签名串
      const body = JSON.stringify(req.body);
      const signString = `${timestamp}\n${nonce}\n${body}\n`;
      
      // 使用 APIv3 密钥验证签名
      const expectedSignature = crypto
        .createHmac('sha256', apiSecret)
        .update(signString)
        .digest('hex');
      
      if (signature !== expectedSignature) {
        logger.warn('WeChat Pay webhook: Invalid signature', {
          received: signature,
          expected: expectedSignature
        });
        return res.status(401).json({ error: 'Invalid signature' });
      }
      
      logger.info('WeChat Pay webhook: Signature verified successfully');
      next();
    } catch (err) {
      logger.error('WeChat Pay webhook signature verification error:', err);
      res.status(500).json({ error: 'Signature verification failed' });
    }
  };
}

/**
 * 创建支付宝 Webhook 签名验证中间件
 * @param {string} alipayPublicKey - 支付宝公钥
 * @returns {Function} Express 中间件
 */
export function createAlipaySignatureVerifier(alipayPublicKey) {
  return async (req, res, next) => {
    try {
      const signature = req.headers['x-alipay-signature'];
      const signType = req.headers['x-alipay-sig-type'] || 'RSA2';
      
      if (!signature) {
        logger.warn('Alipay webhook: Missing signature header');
        return res.status(401).json({ error: 'Missing signature header' });
      }
      
      // 构造验签名串（支付宝规范）
      const params = { ...req.body };
      delete params['sign'];
      delete params['sign_type'];
      
      // 参数排序
      const sortedParams = Object.keys(params).sort().map(key => {
        return `${key}=${params[key]}`;
      }).join('&');
      
      // 验证签名
      let verifier;
      if (signType === 'RSA2') {
        verifier = crypto.createVerify('RSA-SHA256');
      } else {
        verifier = crypto.createVerify('RSA-SHA1');
      }
      
      verifier.update(sortedParams);
      
      const isValid = verifier.verify(alipayPublicKey, signature, 'base64');
      
      if (!isValid) {
        logger.warn('Alipay webhook: Invalid signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
      
      logger.info('Alipay webhook: Signature verified successfully');
      next();
    } catch (err) {
      logger.error('Alipay webhook signature verification error:', err);
      res.status(500).json({ error: 'Signature verification failed' });
    }
  };
}

/**
 * 创建 Stripe Webhook 签名验证中间件
 * @param {string} endpointSecret - Stripe Webhook 端点密钥
 * @returns {Function} Express 中间件
 */
export function createStripeSignatureVerifier(endpointSecret) {
  return (req, res, next) => {
    try {
      const signature = req.headers['stripe-signature'];
      
      if (!signature) {
        logger.warn('Stripe webhook: Missing signature header');
        return res.status(401).json({ error: 'Missing signature header' });
      }
      
      // Stripe 要求使用原始请求体验证签名
      const rawBody = req.rawBody || req.body;
      
      let event;
      try {
        // 使用 Stripe SDK 验证签名（推荐）
        // const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        // event = stripe.webhooks.constructEvent(rawBody, signature, endpointSecret);
        
        // Mock 验证（实际应使用 Stripe SDK）
        const parts = signature.split(',');
        const timestamp = parts[0].split('=')[1];
        const v1 = parts[1].split('=')[1];
        
        const signedPayload = `${timestamp}.${rawBody}`;
        const expectedSignature = crypto
          .createHmac('sha256', endpointSecret)
          .update(signedPayload)
          .digest('hex');
        
        if (v1 !== expectedSignature) {
          throw new Error('Invalid signature');
        }
        
        logger.info('Stripe webhook: Signature verified successfully');
        next();
      } catch (err) {
        logger.warn('Stripe webhook: Invalid signature', { error: err.message });
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch (err) {
      logger.error('Stripe webhook signature verification error:', err);
      res.status(500).json({ error: 'Signature verification failed' });
    }
  };
}

/**
 * 通用 Webhook 签名验证中间件（自动检测支付渠道）
 * 
 * 根据请求头自动选择对应的验证器。
 * 需要在环境变量中配置各支付渠道的密钥。
 */
export function webhookSignatureVerifier(req, res, next) {
  const path = req.path;
  
  if (path.includes('wechat')) {
    const apiSecret = process.env.WECHAT_PAY_APIV3_KEY;
    if (!apiSecret) {
      logger.error('WeChat Pay APIv3 key not configured');
      return res.status(500).json({ error: 'Webhook verification not configured' });
    }
    return createWeChatSignatureVerifier(apiSecret)(req, res, next);
  }
  
  if (path.includes('alipay')) {
    const publicKey = process.env.ALIPAY_PUBLIC_KEY;
    if (!publicKey) {
      logger.error('Alipay public key not configured');
      return res.status(500).json({ error: 'Webhook verification not configured' });
    }
    return createAlipaySignatureVerifier(publicKey)(req, res, next);
  }
  
  if (path.includes('stripe')) {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!endpointSecret) {
      logger.error('Stripe webhook secret not configured');
      return res.status(500).json({ error: 'Webhook verification not configured' });
    }
    return createStripeSignatureVerifier(endpointSecret)(req, res, next);
  }
  
  logger.warn('Unknown webhook path', { path });
  res.status(400).json({ error: 'Unknown webhook path' });
}

export default webhookSignatureVerifier;
