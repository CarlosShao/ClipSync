/**
 * 开发环境专用调试日志。
 * 生产构建（import.meta.env.DEV === false）下所有 debug 调用为空操作，
 * 避免调试日志污染用户控制台；console.warn / console.error 仍直接使用。
 */
const isDev = import.meta.env.DEV

/* eslint-disable no-console */
export const logger = {
  debug: (...args: unknown[]) => {
    if (isDev) console.log(...args)
  },
}
