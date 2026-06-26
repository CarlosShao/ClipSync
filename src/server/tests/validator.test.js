import { describe, it, expect } from 'vitest';
import {
  isValidPhone,
  isValidCode,
  isValidUUID,
  isValidDeviceType,
  isValidPlatform,
  isValidContentType,
  validatePagination,
  validateSearch,
  sanitizeString,
  isValidDeviceName,
} from '../src/validation/validator.js';

describe('Validator', () => {
  describe('isValidPhone', () => {
    it('should accept valid Chinese phone numbers', () => {
      expect(isValidPhone('13800138000')).toBe(true);
      expect(isValidPhone('15912345678')).toBe(true);
      expect(isValidPhone('18611112222')).toBe(true);
    });

    it('should reject invalid phone numbers', () => {
      expect(isValidPhone('')).toBe(false);
      expect(isValidPhone('abc')).toBe(false);
      expect(isValidPhone('12345')).toBe(false);
      expect(isValidPhone('138001380000')).toBe(false);
      expect(isValidPhone('1380013800')).toBe(false);
      expect(isValidPhone(null)).toBe(false);
      expect(isValidPhone(undefined)).toBe(false);
    });
  });

  describe('isValidCode', () => {
    it('should accept 6-digit codes', () => {
      expect(isValidCode('888888')).toBe(true);
      expect(isValidCode('123456')).toBe(true);
      expect(isValidCode('000000')).toBe(true);
    });

    it('should reject invalid codes', () => {
      expect(isValidCode('')).toBe(false);
      expect(isValidCode('12345')).toBe(false);
      expect(isValidCode('1234567')).toBe(false);
      expect(isValidCode('abcdef')).toBe(false);
    });
  });

  describe('isValidUUID', () => {
    it('should accept valid UUIDs', () => {
      expect(isValidUUID('60faff92-83e4-43aa-af6b-a6d064b039ed')).toBe(true);
      expect(isValidUUID('00000000-0000-0000-0000-000000000000')).toBe(true);
    });

    it('should reject invalid UUIDs', () => {
      expect(isValidUUID('')).toBe(false);
      expect(isValidUUID('not-a-uuid')).toBe(false);
      expect(isValidUUID('60faff92-83e4-43aa-af6b')).toBe(false);
    });
  });

  describe('isValidDeviceType', () => {
    it('should accept valid device types', () => {
      expect(isValidDeviceType('desktop')).toBe(true);
      expect(isValidDeviceType('mobile')).toBe(true);
      expect(isValidDeviceType('tablet')).toBe(true);
      expect(isValidDeviceType('browser')).toBe(true);
    });

    it('should reject invalid device types', () => {
      expect(isValidDeviceType('')).toBe(false);
      expect(isValidDeviceType('watch')).toBe(false);
    });
  });

  describe('isValidPlatform', () => {
    it('should accept valid platforms', () => {
      expect(isValidPlatform('windows')).toBe(true);
      expect(isValidPlatform('macos')).toBe(true);
      expect(isValidPlatform('linux')).toBe(true);
      expect(isValidPlatform('ios')).toBe(true);
      expect(isValidPlatform('android')).toBe(true);
      expect(isValidPlatform('browser')).toBe(true);
    });

    it('should reject invalid platforms', () => {
      expect(isValidPlatform('')).toBe(false);
      expect(isValidPlatform('dos')).toBe(false);
    });
  });

  describe('isValidContentType', () => {
    it('should accept valid content types', () => {
      expect(isValidContentType('text')).toBe(true);
      expect(isValidContentType('image')).toBe(true);
      expect(isValidContentType('file')).toBe(true);
      expect(isValidContentType('link')).toBe(true);
      expect(isValidContentType('code')).toBe(true);
    });

    it('should reject invalid content types', () => {
      expect(isValidContentType('')).toBe(false);
      expect(isValidContentType('video')).toBe(false);
    });
  });

  describe('validatePagination', () => {
    it('should return valid pagination params', () => {
      const result = validatePagination(1, 50);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });

    it('should handle invalid inputs gracefully', () => {
      const result = validatePagination(-1, 0);
      expect(result.page).toBeGreaterThanOrEqual(1);
      expect(result.limit).toBeGreaterThanOrEqual(1);
    });

    it('should cap limit at 100', () => {
      const result = validatePagination(1, 200);
      expect(result.limit).toBeLessThanOrEqual(100);
    });
  });

  describe('validateSearch', () => {
    it('should sanitize search terms', () => {
      const result1 = validateSearch('hello');
      expect(result1).toBe('hello');

      const result2 = validateSearch('  hello  ');
      expect(result2).toBe('hello');
    });

    it('should return empty string for empty input', () => {
      expect(validateSearch('')).toBe('');
      expect(validateSearch('  ')).toBe('');
    });
  });

  describe('sanitizeString', () => {
    it('should escape HTML entities', () => {
      const result = sanitizeString('<script>alert(1)</script>');
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;');
    });

    it('should handle normal text', () => {
      expect(sanitizeString('Hello World')).toBe('Hello World');
    });

    it('should handle empty input', () => {
      expect(sanitizeString('')).toBe('');
      expect(sanitizeString(null)).toBe('');
    });

    it('should handle quotes', () => {
      const result = sanitizeString('He said "hello"');
      expect(result).toContain('&quot;');
    });
  });
});
