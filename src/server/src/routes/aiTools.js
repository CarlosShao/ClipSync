// ============ aiTools 薄壳（routes/aiTools.js） ============
// aiTools 分域拆分后，原 4978 行单文件按业务域迁移至 src/server/src/ai/tools/。
// 本文件降为 re-export 薄壳，保持既有调用方（aiChat / aiOrchestrator / aiStream / tests）
// 从 './aiTools.js' 的 import 路径与导出面完全兼容，零改动。

export {
  TOOLS,
  WRITE_TOOL_NAMES,
  READONLY_TOOLS,
  WORKER_BLOCKED_TOOLS,
  getWorkerTools,
  DESTRUCTIVE_CONFIRM_NEEDED,
  approveToolRequest,
  runAskUserGate,
  respondAskUserRequest,
  cancelPendingForStream,
  abortPendingConfirm,
  peekPendingConfirmTool,
  cancelPendingForUser,
  executeTool,
} from '../ai/tools/index.js'

export { default } from '../ai/tools/index.js'