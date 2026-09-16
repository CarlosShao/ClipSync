/**
 * ICP 备案信息（T-W3 的最终值）。
 *
 * 来源：阿里云备案控制台（2026-09-16 管局审核通过）
 *   主体备案号  苏ICP备2026067775号    （主办单位：邵伟琦）
 *   网站备案号  苏ICP备2026067775号-1  （网站名称：网页分享，域名 clipchain.top）
 *
 * 备案是「域名级」的：clipchain.top 备一次即可，api. / www. / admin. / ws. /
 * updates. 等子域无需单独备案（见 docs/audit/filing-guide-2026-09-09.md:65）。
 *
 * ⚠️ 法规要求备案号展示在网站底部并链到工信部，**不要删这个常量**；
 * dist 产物校验（scripts/check-dist.mjs）会断言页脚确实渲染出了它。
 */
export const ICP_LICENSE = '苏ICP备2026067775号-1';

/** 工信部备案查询入口（备案号必须链到这里）。 */
export const ICP_LICENSE_HREF = 'https://beian.miit.gov.cn/';
