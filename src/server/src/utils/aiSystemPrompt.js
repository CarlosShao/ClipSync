// =============================================
// AI 角色强制系统（#211 / #472）
// - buildRoleSystemPrompt(role, userId): 后端构建角色专属系统提示词，覆盖前端传入的提示词
// - getToolsForRole(role, tools): 按角色过滤下发给 LLM 的工具集
// - assertToolAllowed(role, toolName): 敏感工具执行前权限校验
//
// 三层安全闸门：
//   1) 后端系统提示词覆盖前端（buildRoleSystemPrompt）
//   2) 下发给 LLM 的工具按角色过滤（getToolsForRole）
//   3) 敏感工具执行前再校验一次（assertToolAllowed）
// =============================================

// ============ RBACv2：四级 × 四维权限矩阵 ============
// 四级（由低到高，高等级继承低等级的全部能力）：
//   L0 只读 / L1 操作 / L2 管理 / L3 超管 / L4 Agent 服务
// 四维（工具可能涉及的能力维度，供分级与审计参考）：
//   read / write / destructive / cross_user
// 角色映射：user→L1、admin→L2、super_admin→L3；未知角色降级 L1；L4 不参与角色映射。
// ====================================================

// 角色 -> 等级键（L4 为 Agent 服务专用等级，不参与角色映射）
const ROLE_TO_LEVEL = {
  user: 'L1',
  admin: 'L2',
  super_admin: 'L3',
};

// 维度 -> 所需最低等级（保留四维口径，供权限审计/后续扩展）
const DIMENSION_MIN_LEVEL = {
  read: 'L0',
  write: 'L1',
  destructive: 'L2',
  cross_user: 'L3',
};

// 等级键 -> 数值（越大权限越高，用于继承比较）
const LEVEL_RANK = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

// 工具登记矩阵：列出各等级下可用的工具。
// 工具按其「所需最低等级」登记：出现在 levels[Ln] 表示最低需要 Ln 级权限。
// 新工具登记位：向对应等级数组追加工具名即可（Agent-B 等后续在此补充）。
const levels = {
  L0: [],
  L1: [],
  L2: [],
  L3: [
    // 敏感读（安全 / 受保护条目 / 部署 / 架构源码），仅超管可用
    'get_security_overview',
    'get_protected_clips',
    'explain_deployment',
    'get_project_architecture',
  ],
  L4: [],
};

// 角色降级兜底：未知角色一律按普通用户处理（最小权限）
function normalizeRole(role) {
  if (role && ROLE_TO_LEVEL[role]) return role;
  return 'user';
}

// 角色 -> 等级键；未知角色降级 L1
function levelKeyForRole(role) {
  if (role && ROLE_TO_LEVEL[role]) return ROLE_TO_LEVEL[role];
  return 'L1';
}

// 返回工具所属等级键；未登记的工具视为 L0（只读，全开放）。
// args 暂不参与分级，预留给需要按参数细分级别的工具（如 Agent-C 的 destroy_clips）。
export function getToolLevel(tool, args) {
  const name = typeof tool === 'string' ? tool : (tool && (tool.function ? tool.function.name : tool.name));
  if (!name) return 'L0';
  for (const lv of Object.keys(LEVEL_RANK)) {
    if (levels[lv] && levels[lv].includes(name)) return lv;
  }
  return 'L0';
}

// 指定等级（levelKey）是否允许该工具
export function isToolAllowedForLevel(tool, levelKey) {
  const granted = LEVEL_RANK[levelKey];
  const required = LEVEL_RANK[getToolLevel(tool)];
  if (granted == null || required == null) return false;
  return granted >= required;
}

// 角色等级距工具所需等级还缺失的能力维度（用于 missing 提示）
function missingDimensions(grantedKey, requiredKey) {
  const granted = LEVEL_RANK[grantedKey] != null ? LEVEL_RANK[grantedKey] : 0;
  const required = LEVEL_RANK[requiredKey] != null ? LEVEL_RANK[requiredKey] : 0;
  return Object.keys(DIMENSION_MIN_LEVEL).filter(
    (dim) => LEVEL_RANK[DIMENSION_MIN_LEVEL[dim]] > granted && LEVEL_RANK[DIMENSION_MIN_LEVEL[dim]] <= required,
  );
}

// 原生推理模型关键字（与前端 useAiChat.ts 保持一致）：这类模型自带推理能力，
// 不再追加 <think> 标签提示词，避免重复推理。
const NATIVE_REASONING_KEYWORDS = [
  'deepseek-r1',
  'claude-3-7-sonnet',
  'o1',
  'o1-preview',
  'o1-mini',
  'o3',
  'o4-mini',
  'qwq',
  'qwen3',
  'minimax',
  'mimo',
  'step-',
];

function isNativeReasoningModel(model) {
  if (!model) return false;
  const lower = String(model).toLowerCase();
  return NATIVE_REASONING_KEYWORDS.some((k) => lower.includes(k));
}

const THINKING_STRENGTH = {
  low: 'Think step by step briefly.',
  medium: 'Think step by step with moderate detail.',
  high: 'Think step by step with thorough analysis.',
};

// 在角色系统提示词基础上，复用前端的思考/agent 增强逻辑（#212）：
// 覆盖前端 system 消息时会丢掉原增强，故后端重放一遍，确保思考与 Agent 模式行为不变。
export function enhanceSystemPrompt(base, opts = {}) {
  let content = base;
  if (opts.thinking) {
    content += `\n\n${THINKING_STRENGTH[opts.thinkingStrength] || THINKING_STRENGTH.medium}`;
    if (!isNativeReasoningModel(opts.model)) {
      content +=
        '\n\nWhen you need to think before answering, put your step-by-step reasoning inside <think>...</think> tags. Only the final answer should appear outside the tags. Keep the reasoning concise.';
    }
  }
  if (opts.agentMode) {
    content +=
      '\n\n【Agent 模式 · 去伪存真】' +
      '\n你处于 Agent 模式，可以调用工具获取实时数据。' +
      '\n核心原则——基于事实回答，不臆造：' +
      '\n- 你的回答必须且只能基于工具返回的真实数据。未通过工具获取的信息，不得在回答中呈现为事实。' +
      '\n- 如果工具未返回某项数据，明确告知用户"该信息暂不可用"或"未查到"，而非编造内容。' +
      '\n- 不要推测不存在的文件名、ID、数值或其他具体细节。宁可说"不确定"也不要说错。' +
      '\n- 引用数据时附带来源（如"根据 XX 工具返回的结果"），方便用户验证。' +
      '\n- 如果用户要求分析项目，请先调用工具读取实际文件/代码，再基于读取到的真实内容作答。' +
      '\n  切勿凭记忆或猜测列出功能、架构或代码细节。' +
      '\n- 遇到不确定的技术细节时，坦诚说明，不要用"可能""大概"等模糊表述来掩盖不确定性。';
  }
  return content;
}

// 按角色过滤工具集：低于工具所需等级的工具被剔除；结果每个工具带 level 标签
export function getToolsForRole(role, tools) {
  const levelKey = levelKeyForRole(role);
  return (tools || [])
    .map((t) => {
      const name = t && (t.function ? t.function.name : t.name);
      return { tool: t, name, level: getToolLevel(name) };
    })
    .filter(({ name }) => isToolAllowedForLevel(name, levelKey))
    .map(({ tool, level }) => ({ ...tool, level }));
}

// 执行前权限校验：返回 { allowed: boolean, missing: string[], level: string }
export function assertToolAllowed(role, toolName) {
  const levelKey = levelKeyForRole(role);
  const required = getToolLevel(toolName);
  if (!isToolAllowedForLevel(toolName, levelKey)) {
    return {
      allowed: false,
      missing: missingDimensions(levelKey, required),
      level: required,
    };
  }
  return { allowed: true, missing: [], level: levelKey };
}

// 角色专属系统提示词（覆盖前端传入的提示词）
export function buildRoleSystemPrompt(role, userId) {
  const r = normalizeRole(role);
  const base = [
    '你是 ClipSync 的 AI 智能助手。ClipSync 是一款跨设备剪贴板同步工具，',
    '帮助用户在一台设备复制、在另一台设备粘贴，支持文本、图片、文件等剪贴板内容的云端同步、历史管理与检索。',
    '你的回答应简洁、准确、有帮助，使用与用户相同的语言。',
    '',
    '【核心原则 · 去伪存真】',
    '- 你必须基于工具返回的真实数据回答问题。未通过工具获取的信息，绝不在回答中呈现为事实。',
    '- 如果工具未返回某项数据，明确告知用户"该信息暂不可用"或"未查到"，而非编造内容。',
    '- 不要推测不存在的文件名、ID、数值或其他具体细节。宁可说"不确定"也不要说错。',
    '- 引用数据时请注明来源（如"根据XX查询结果"），方便用户验证。',
  ].join('');

  if (r === 'super_admin') {
    return [
      base,
      '',
      '【角色：超级管理员 / 产品所有者】',
      '你拥有系统最高权限，可以访问并讨论一切内部信息，包括：数据库表结构、',
      '部署与架构细节、安全相关配置、源码实现、以及其他用户的数据（在用户明确需要时）。',
      '你可以调用所有可用工具。涉及敏感操作时，保持专业并提示潜在风险即可，无需隐藏任何技术细节。',
      userId ? `当前操作者用户ID：${userId}。` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (r === 'admin') {
    return [
      base,
      '',
      '【角色：管理员 / 受信任协作者】',
      '你可以协助管理用户的剪贴板、设备、订阅等平台能力，但不得暴露任何内部敏感信息，',
      '包括：数据库表结构、部署/架构细节、安全相关数据、源码实现细节。',
      '当被问及上述内部实现时，礼貌说明你无法提供该级别的技术细节，并引导用户联系产品所有者。',
      '你只能访问当前用户自身的数据，不得访问其他用户的数据。',
      userId ? `当前操作者用户ID：${userId}。` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // 默认：普通用户（user）
  return [
    base,
    '',
    '【角色：普通用户】',
    '你只能基于 ClipSync 的公开产品能力帮助用户：管理自己的剪贴板历史、设备、订阅，',
    '以及解答产品使用问题。',
    '严格禁止：讨论或透露任何内部实现细节，包括但不限于数据库结构、服务器部署、',
    '系统架构、源代码、安全机制，以及任何其他用户的数据。',
    '当被问及内部实现、数据库、部署、源码或他人数据时，必须明确回复你无法提供此类信息，',
    '并仅围绕 ClipSync 的公开功能作答。切勿臆造内部技术细节。',
    '你只能访问当前用户自身的数据，不得访问其他用户的数据。',
    userId ? `当前操作者用户ID：${userId}。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export default {
  getToolsForRole,
  assertToolAllowed,
  buildRoleSystemPrompt,
};
