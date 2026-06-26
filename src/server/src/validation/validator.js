/**
 * 输入验证与防护模块
 * 
 * 功能：
 * 1. API参数验证
 * 2. SQL注入防护
 * 3. XSS防护
 * 4. 通用数据清理
 */

/**
 * 验证手机号格式
 * @param {string} phone 
 * @returns {boolean}
 */
export function isValidPhone(phone) {
  // 中国大陆手机号：1开头，11位数字
  const phoneRegex = /^1[3-9]\d{9}$/;
  return phoneRegex.test(phone);
}

/**
 * 验证验证码格式
 * @param {string} code 
 * @returns {boolean}
 */
export function isValidCode(code) {
  // 6位数字验证码
  const codeRegex = /^\d{6}$/;
  return codeRegex.test(code);
}

/**
 * 验证UUID格式
 * @param {string} uuid 
 * @returns {boolean}
 */
export function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * 验证内容类型
 * @param {string} contentType 
 * @returns {boolean}
 */
export function isValidContentType(contentType) {
  const validTypes = ['text', 'image', 'file', 'link', 'code'];
  return validTypes.includes(contentType);
}

/**
 * 验证设备类型
 * @param {string} deviceType 
 * @returns {boolean}
 */
export function isValidDeviceType(deviceType) {
  const validTypes = ['desktop', 'mobile', 'tablet', 'browser'];
  return validTypes.includes(deviceType);
}

/**
 * 验证平台类型
 * @param {string} platform 
 * @returns {boolean}
 */
export function isValidPlatform(platform) {
  const validPlatforms = ['windows', 'macos', 'linux', 'ios', 'android', 'browser'];
  return validPlatforms.includes(platform);
}

/**
 * 清理字符串输入（防XSS）
 * @param {string} input 
 * @returns {string}
 */
export function sanitizeString(input) {
  if (typeof input !== 'string') return '';
  
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * 清理HTML内容（保留基本格式）
 * @param {string} html 
 * @returns {string}
 */
export function sanitizeHtml(html) {
  if (typeof html !== 'string') return '';
  
  // 移除所有HTML标签
  return html.replace(/<[^>]*>/g, '');
}

/**
 * 防SQL注入：转义特殊字符
 * 注意：使用参数化查询时不需要这个
 * @param {string} input 
 * @returns {string}
 */
export function escapeSql(input) {
  if (typeof input !== 'string') return '';
  
  return input
    .replace(/'/g, "''")
    .replace(/\\/g, '\\\\')
    .replace(/\0/g, '\\0');
}

/**
 * 验证并清理分页参数
 * @param {any} page 
 * @param {any} limit 
 * @returns {{page: number, limit: number}}
 */
export function validatePagination(page, limit) {
  let pageNum = parseInt(page) || 1;
  let limitNum = parseInt(limit) || 50;

  // 限制范围
  pageNum = Math.max(1, Math.min(1000, pageNum));
  limitNum = Math.max(1, Math.min(100, limitNum));

  return { page: pageNum, limit: limitNum };
}

/**
 * 验证并清理搜索参数
 * @param {string} search 
 * @param {number} maxLength 
 * @returns {string}
 */
export function validateSearch(search, maxLength = 100) {
  if (typeof search !== 'string') return '';
  
  // 清理并限制长度
  return sanitizeString(search.trim()).substring(0, maxLength);
}

/**
 * 验证JSON数据
 * @param {any} data 
 * @returns {boolean}
 */
export function isValidJson(data) {
  try {
    if (typeof data === 'string') {
      JSON.parse(data);
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 验证URL格式
 * @param {string} url 
 * @returns {boolean}
 */
export function isValidUrl(url) {
  try {
    new URL(url);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 验证邮箱格式
 * @param {string} email 
 * @returns {boolean}
 */
export function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * 验证昵称
 * @param {string} nickname 
 * @returns {{valid: boolean, error?: string}}
 */
export function validateNickname(nickname) {
  if (!nickname || typeof nickname !== 'string') {
    return { valid: false, error: '昵称不能为空' };
  }

  const trimmed = nickname.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: '昵称不能为空' };
  }

  if (trimmed.length > 50) {
    return { valid: false, error: '昵称不能超过50个字符' };
  }

  // 检查是否包含特殊字符
  const invalidChars = /[<>"'&]/;
  if (invalidChars.test(trimmed)) {
    return { valid: false, error: '昵称包含非法字符' };
  }

  return { valid: true };
}

/**
 * 验证设备名称
 * @param {string} name 
 * @returns {{valid: boolean, error?: string}}
 */
export function validateDeviceName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: '设备名称不能为空' };
  }

  const trimmed = name.trim();
  
  if (trimmed.length === 0) {
    return { valid: false, error: '设备名称不能为空' };
  }

  if (trimmed.length > 100) {
    return { valid: false, error: '设备名称不能超过100个字符' };
  }

  return { valid: true };
}

/**
 * 验证剪贴板内容
 * @param {object} data 
 * @returns {{valid: boolean, error?: string}}
 */
export function validateClipboardData(data) {
  const { sourceDeviceId, contentType, contentEncrypted } = data;

  if (!sourceDeviceId) {
    return { valid: false, error: 'sourceDeviceId 不能为空' };
  }

  if (!isValidUUID(sourceDeviceId)) {
    return { valid: false, error: 'sourceDeviceId 格式无效' };
  }

  if (!contentType) {
    return { valid: false, error: 'contentType 不能为空' };
  }

  if (!isValidContentType(contentType)) {
    return { valid: false, error: 'contentType 无效' };
  }

  if (!contentEncrypted) {
    return { valid: false, error: 'contentEncrypted 不能为空' };
  }

  if (typeof contentEncrypted !== 'string') {
    return { valid: false, error: 'contentEncrypted 必须是字符串' };
  }

  if (contentEncrypted.length > 10 * 1024 * 1024) { // 10MB limit
    return { valid: false, error: '内容过大' };
  }

  return { valid: true };
}

/**
 * 验证设备注册数据
 * @param {object} data 
 * @returns {{valid: boolean, error?: string}}
 */
export function validateDeviceData(data) {
  const { deviceName, deviceType, platform } = data;

  const nameValidation = validateDeviceName(deviceName);
  if (!nameValidation.valid) {
    return nameValidation;
  }

  if (!deviceType) {
    return { valid: false, error: 'deviceType 不能为空' };
  }

  if (!isValidDeviceType(deviceType)) {
    return { valid: false, error: 'deviceType 无效' };
  }

  if (!platform) {
    return { valid: false, error: 'platform 不能为空' };
  }

  if (!isValidPlatform(platform)) {
    return { valid: false, error: 'platform 无效' };
  }

  return { valid: true };
}

/**
 * 验证中间件工厂
 * @param {Function} validator 
 * @param {Function} extractor 
 * @returns {Function}
 */
export function validationMiddleware(validator, extractor = (req) => req.body) {
  return (req, res, next) => {
    const data = extractor(req);
    const result = validator(data);

    if (!result.valid) {
      return res.status(400).json({ error: result.error });
    }

    next();
  };
}

/**
 * 常用验证中间件
 */
export const validators = {
  // 验证登录数据
  login: validationMiddleware((data) => {
    const { phone, code } = data;

    if (!phone) {
      return { valid: false, error: '手机号不能为空' };
    }

    if (!isValidPhone(phone)) {
      return { valid: false, error: '手机号格式无效' };
    }

    if (!code) {
      return { valid: false, error: '验证码不能为空' };
    }

    if (!isValidCode(code)) {
      return { valid: false, error: '验证码格式无效' };
    }

    return { valid: true };
  }),

  // 验证发送验证码
  sendCode: validationMiddleware((data) => {
    const { phone } = data;

    if (!phone) {
      return { valid: false, error: '手机号不能为空' };
    }

    if (!isValidPhone(phone)) {
      return { valid: false, error: '手机号格式无效' };
    }

    return { valid: true };
  }),

  // 验证设备注册
  registerDevice: validationMiddleware(validateDeviceData),

  // 验证剪贴板数据
  createClipboard: validationMiddleware(validateClipboardData),
};

export default {
  isValidPhone,
  isValidCode,
  isValidUUID,
  isValidContentType,
  isValidDeviceType,
  isValidPlatform,
  sanitizeString,
  sanitizeHtml,
  escapeSql,
  validatePagination,
  validateSearch,
  isValidJson,
  isValidUrl,
  isValidEmail,
  validateNickname,
  validateDeviceName,
  validateClipboardData,
  validateDeviceData,
  validationMiddleware,
  validators,
};
