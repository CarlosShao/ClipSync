import { describe, it, expect } from 'vitest';
import { createWeChatSignatureVerifier, createAlipaySignatureVerifier, createStripeSignatureVerifier } from '../src/middleware/webhook-signature.js';

describe('Webhook Signature Verification - Module Tests', () => {
  describe('Module Exports', () => {
    it('should export createWeChatSignatureVerifier', () => {
      expect(createWeChatSignatureVerifier).toBeDefined();
      expect(typeof createWeChatSignatureVerifier).toBe('function');
    });

    it('should export createAlipaySignatureVerifier', () => {
      expect(createAlipaySignatureVerifier).toBeDefined();
      expect(typeof createAlipaySignatureVerifier).toBe('function');
    });

    it('should export createStripeSignatureVerifier', () => {
      expect(createStripeSignatureVerifier).toBeDefined();
      expect(typeof createStripeSignatureVerifier).toBe('function');
    });
  });

  describe('WeChat Pay Signature Verifier', () => {
    it('should create verifier function', () => {
      const verifier = createWeChatSignatureVerifier('test_api_secret');
      expect(verifier).toBeDefined();
      expect(typeof verifier).toBe('function');
    });
  });

  describe('Alipay Signature Verifier', () => {
    it('should create verifier function', () => {
      const verifier = createAlipaySignatureVerifier('test_public_key');
      expect(verifier).toBeDefined();
      expect(typeof verifier).toBe('function');
    });
  });

  describe('Stripe Signature Verifier', () => {
    it('should create verifier function', () => {
      const verifier = createStripeSignatureVerifier('whsec_test_secret');
      expect(verifier).toBeDefined();
      expect(typeof verifier).toBe('function');
    });
  });
});
