/**
 * PDF 收据/发票生成（pdfkit）
 *
 * ============ 中文字体（先看这段，别再改回 Helvetica）============
 * pdfkit 的标准 14 字体（Helvetica/Times…）走 WinAnsi 编码，**装不下中文**。
 * 实测（pdfkit 0.19）：doc.font('Helvetica').text('电子发票') **不会抛错**，
 * 而是静默按 WinAnsi 逐字节写进去 → 文件能打开、内容全是乱码/丢字。
 * 也就是说「用 Helvetica 渲染中文」不是崩在服务器上，而是安静地产出一张
 * 没人看得懂的收据 —— 比抛错更糟，所以这里宁可缺字体时硬失败也不回退标准字体。
 * 结论：本文件全部文本统一走一个含 CJK 字形的 TrueType，见 FONT_CANDIDATES / resolveInvoiceFont()。
 *
 * 生产/dev 镜像是 node:22-alpine（见 src/server/Dockerfile，两个 stage 都装了
 * `apk add font-wqy-zenhei`），实测落盘路径：
 *   /usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc            ← Alpine（本仓库实际用的）
 * 字体族名同样实测过（fontkit 读集合）：这是一个 **TTC 集合**，含三款字，
 * pdfkit 的 `doc.font(path, family)` 第二个参数最终交给
 * `fontkit.create(buffer, postscriptName)`，**匹配的是 postscriptName，不是 familyName**
 * （fontkit/dist/module.mjs 的 Collection.getFont 就按 postscriptName 全等比）：
 *   WenQuanYi Zen Hei       → postscript `WenQuanYiZenHei`        ← 用这个
 *   WenQuanYi Zen Hei Mono  → postscript `WenQuanYiZenHeiMono`
 *   WenQuanYi Zen Hei Sharp → postscript `WenQuanYiZenHeiSharp`
 * 传错（例如传 'WenQuanYi Zen Hei' 带空格）→ fontkit 抛
 * `Font WenQuanYi Zen Hei not found in collection`，整份 PDF 生成失败。
 * 为免再踩：解析器会用 fontkit 打开集合，优先按 postscript/family 名命中，
 * 命中不了就退到「第一个真含 CJK 字形的字面」，把真实 postscriptName 交给 pdfkit。
 *
 * Windows 本机开发/跑测试没有 /usr/share/fonts，故候选表里带 msyh.ttc / simhei.ttf
 * （两者 postscript 名 MicrosoftYaHei / SimHei，实测含「票」「电」字形），
 * 这样 `npx vitest run` 在 Windows 上也能真生成 PDF，不必先起容器。
 *
 * 找一个都找不到时（极端：精简镜像漏装字体）→ 抛错，由调用方在**写 PDF 响应头之前**
 * 转成 500 JSON；绝不退回 Helvetica 硬出一份乱码文件。
 */

import PDFDocument from 'pdfkit';
import { existsSync } from 'fs';
import { logger } from './logger.js';
import { EMAILS } from '../../../shared/domains.js';

/** 页边距（A4 595.28 x 841.89 pt） */
const MARGIN = 50;

/** CJK 字体候选，按「生产容器 → Debian 变体 → Windows 本机 → Linux 桌面」排序 */
const FONT_CANDIDATES = [
  { path: '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc', family: 'WenQuanYiZenHei' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', family: 'WenQuanYiZenHei' },
  { path: 'C:/Windows/Fonts/msyh.ttc', family: 'MicrosoftYaHei' },
  { path: 'C:/Windows/Fonts/simhei.ttf', family: 'SimHei' },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', family: 'NotoSansCJK-Regular' },
  { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFangSC-Regular' },
];

/** 用于校验「这个字面到底画不画得出中文」的探针码点（票 / 电 / 子） */
const CJK_PROBE_CODEPOINTS = [0x7968, 0x7535, 0x5b50];

let fontPromise = null;

/**
 * 解析可用的 CJK 字体（结果缓存，整个进程只探测一次）。
 * @returns {Promise<{path: string, family: string}>} family 是要传给 pdfkit 的 postscript 名
 */
function resolveInvoiceFont() {
  if (!fontPromise) fontPromise = _probeFonts();
  return fontPromise;
}

async function _probeFonts() {
  const present = FONT_CANDIDATES.filter((c) => existsSync(c.path));
  if (present.length === 0) {
    throw new Error(
      `未找到可用于 PDF 的中文字体（候选：${FONT_CANDIDATES.map((c) => c.path).join(', ')}）` +
        '——镜像需安装 font-wqy-zenhei，见 src/server/Dockerfile'
    );
  }

  // fontkit 是 pdfkit 的依赖，正常必在；import 失败时退回候选表里写死的 family。
  let fontkit = null;
  try {
    const mod = await import('fontkit');
    fontkit = mod.openSync ? mod : mod.default;
  } catch (err) {
    logger.warn('[pdf-invoice] fontkit 不可用，按候选表写死的 family 使用:', err.message);
  }

  for (const cand of present) {
    if (!fontkit?.openSync) {
      return { path: cand.path, family: cand.family };
    }
    try {
      const opened = fontkit.openSync(cand.path);
      /** @type {any[]} TTC 集合 → fonts[]；单字体 → 自身 */
      const faces = Array.isArray(opened?.fonts) ? opened.fonts : [opened];
      const drawsCjk = (f) =>
        typeof f?.hasGlyphForCodePoint === 'function' &&
        CJK_PROBE_CODEPOINTS.every((cp) => f.hasGlyphForCodePoint(cp));
      const picked =
        faces.find((f) => cand.family && (f.postscriptName === cand.family || f.familyName === cand.family)) ||
        faces.find(drawsCjk);
      if (picked?.postscriptName) {
        return { path: cand.path, family: picked.postscriptName };
      }
      logger.warn(`[pdf-invoice] 字体 ${cand.path} 内未找到可画中文的字面，尝试下一个候选`);
    } catch (err) {
      logger.warn(`[pdf-invoice] 字体 ${cand.path} 解析失败，尝试下一个候选:`, err.message);
    }
  }

  // 全都打不开：交给 pdfkit 自己按候选表首选去开（大概率抛错，由路由转 500）
  return { path: present[0].path, family: present[0].family };
}

// =============================================
// 文本/排版小工具（一律显式给 x/y/width，避免依赖 doc.y 隐式流动标）
// 统一字体入口是下面的 FONT(doc, size) / face(doc, size)，别在这里另开。
// =============================================

const COLOR_TEXT = '#1f2328';
const COLOR_MUTED = '#6b7280';
const COLOR_LINE = '#d0d7de';
const COLOR_ACCENT = '#2563eb';
const COLOR_REFUND = '#b91c1c';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 货币符号：CNY（含空值，本站只有 CNY 单）用 ¥，其余按代码前缀 */
function fmtMoney(value, currency) {
  const n = toAmount(value);
  const cur = String(currency || 'CNY').toUpperCase();
  return cur === 'CNY' ? `¥${n.toFixed(2)}` : `${cur} ${n.toFixed(2)}`;
}

/**
 * 排版用的字体状态。pdfkit 的 font/fontSize 都是「当前值」，
 * 不显式设就沿用上一次 —— 第一版漏设字号，整页按抬头 22pt 印了出来
 * （pdftotext 看不出，只能渲染成图才发现）。所以：**所有文本一律经 face()/text()**，
 * 且 size 不传就用正文号，绝不吃上一次的残留。
 */
let _activeFont = null;
const BODY_SIZE = 10;

/** 同步版字体入口（渲染循环内用）：统一字族 + 显式字号 */
function face(doc, size) {
  if (!_activeFont) throw new Error('pdf-invoice: 字体未解析，先 await FONT(doc)');
  doc.font(_activeFont.path, _activeFont.family);
  doc.fontSize(size == null ? BODY_SIZE : size);
  return doc;
}

/**
 * 异步版字体入口（外部/首次调用用）：解析并应用中文字体。
 * 传 null 当 doc 表示「只解析、不应用」——用于渲染前预检（缺字体要立刻抛，别画一半）。
 * @param {import('pdfkit').default|null} doc
 * @param {number} [size]
 */
async function FONT(doc, size) {
  _activeFont = await resolveInvoiceFont();
  return doc ? face(doc, size) : _activeFont;
}

function text(doc, str, x, y, width, opts = {}) {
  face(doc, opts.size);
  doc.fillColor(opts.color || COLOR_TEXT);
  const measureOpts = { width, lineGap: opts.lineGap ?? 2 };
  doc.text(String(str ?? ''), x, y, {
    ...measureOpts,
    align: opts.align || 'left',
    ...(opts.ellipsis ? { ellipsis: true } : {}),
  });
  // 返回占用高度，调用方据此推进 y
  return y + doc.heightOfString(String(str ?? ''), measureOpts);
}

function line(doc, y) {
  doc.moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).strokeColor(COLOR_LINE).lineWidth(0.7).stroke();
  return y + 10;
}

// =============================================
// 对外主函数
// =============================================

/**
 * 生成收据 PDF。
 *
 * 本函数**只负责渲染**，不查库：所有字段由调用方（routes/invoices.js）查好后传进来。
 * 各参数的真实来源（列名依据 migrations/004_subscription_tables.sql）：
 *   invoice —— invoices 行：id, user_id, subscription_id, payment_order_id,
 *              invoice_no, title, tax_no, amount, tax_amount, status,
 *              issued_at, metadata, created_at
 *              （注意：该表**没有** notes / tax / plan_id / invoice_url 列）
 *   user    —— users 行：id, nickname, phone, email（users 表确有 nickname，默认 ''）
 *   order   —— payment_orders 行 + 调用方补的两个派生字段：
 *              order_no, amount(实付), currency, payment_method, status,
 *              paid_at, refunded_at, metadata,
 *              planDisplayName ← metadata.planId → subscription_plans.display_name
 *              billingCycle    ← user_subscriptions.billing_cycle（可空）
 * @returns {Promise<Buffer>} PDF Buffer
 */
async function generateInvoicePDF(invoice, user, order) {
  await FONT(null); // 仅解析并缓存字体：缺中文字体时立刻抛错，别写到一半再崩
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        bufferPages: true,
        info: {
          Title: `ClipSync 电子发票 ${invoice?.invoice_no || ''}`.trim(),
          Author: 'ClipSync',
          Subject: '付款收据 / 电子发票',
          Creator: 'ClipSync server (pdfkit)',
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      _generateInvoiceContent(doc, invoice, user, order).catch(reject);
    } catch (err) {
      logger.error('Generate invoice PDF error:', err);
      reject(err);
    }
  });
}

/** 退款判定：invoices.status 的 CHECK 只允许 issued/paid/void，**装不下 refunded**，
 *  所以「已退款」只能以订单为准（refund.js 履约：SET status='refunded', refunded_at=...）。 */
function _isRefunded(order) {
  return String(order?.status || '').toLowerCase() === 'refunded' || Boolean(order?.refunded_at);
}

function _getInvoiceStatusText(status) {
  const map = {
    draft: '草稿',
    issued: '已开具',
    paid: '已支付',
    void: '已作废',
    cancelled: '已取消',
    refunded: '已退款',
  };
  return map[String(status || '').toLowerCase()] || String(status || '-');
}

function _getPaymentMethodText(method) {
  const map = {
    mock: '模拟支付',
    wechat: '微信支付',
    wechat_pay: '微信支付',
    alipay: '支付宝',
    stripe: 'Stripe',
    apple_pay: 'Apple Pay',
    google_pay: 'Google Pay',
  };
  return map[String(method || '').toLowerCase()] || String(method || '-');
}

const CYCLE_TEXT = { monthly: '月付', yearly: '年付' };

/** 商品名：调用方查好的 display_name 优先，其次订单 metadata 里的历史值，最后兜底 */
function _productName(order) {
  const display = String(order?.planDisplayName || order?.metadata?.planName || '').trim();
  const base = display || 'ClipSync 订阅';
  const cycle = CYCLE_TEXT[String(order?.billingCycle || order?.metadata?.billingCycle || '').toLowerCase()];
  return cycle ? `${base}（${cycle}）` : base;
}

/**
 * 收据上所有**业务口径**的单一事实源（纯函数，不碰 pdfkit，单独可测）。
 * 渲染函数只负责排版，口径一律从这里取 —— 这样「实付金额取订单、税费取
 * tax_amount、退款以订单状态为准」这三条能被断言，而不是埋在画布里。
 *
 * @param {Object} invoice invoices 行
 * @param {Object} order   payment_orders 行 + 调用方补的 planDisplayName/billingCycle
 */
function invoiceFacts(invoice, order) {
  // 实付以订单为准：invoices.amount 是建票时从订单抄的，正常相等，
  // 但升级折抵单（proration）等场景订单才是真收的钱。
  const paidRaw = order && order.amount != null ? order.amount : invoice?.amount;
  const paid = toAmount(paidRaw);
  // tax_amount 是 invoices 的真实列名（**没有 tax 这一列**）；履约为 0 时不显。
  const tax = toAmount(invoice?.tax_amount);
  return {
    invoiceNo: String(invoice?.invoice_no || ''),
    statusText: _getInvoiceStatusText(invoice?.status),
    paymentMethodText: _getPaymentMethodText(order?.payment_method),
    productName: _productName(order),
    paid,
    paidText: fmtMoney(paid, order?.currency),
    tax,
    taxText: fmtMoney(tax, order?.currency),
    currency: String(order?.currency || 'CNY').toUpperCase(),
    refunded: _isRefunded(order),
    refundedAt: order?.refunded_at || null,
  };
}

/**
 * 渲染正文。async 只为拿字体（resolveInvoiceFont 有缓存，实际不产生交错）。
 * 排版全部走显式 x/y/width + 自己推进的 y，不依赖 pdfkit 的隐式文档流。
 */
async function _generateInvoiceContent(doc, invoice, user, order) {
  await FONT(doc); // 统一字族（此后所有绘制经 text()/face()）
  const pageW = doc.page.width;
  const contentW = pageW - MARGIN * 2;
  const halfW = contentW / 2;
  // 业务口径全从这里取（见 invoiceFacts 注释），本函数只管排版
  const facts = invoiceFacts(invoice, order);

  // ---- 抬头 ----
  let y = text(doc, '电子发票', MARGIN, doc.y, contentW, { size: 22, align: 'center', lineGap: 0 });
  y += 4;
  y = text(doc, 'ClipSync · 付款收据', MARGIN, y, contentW, {
    size: 11,
    align: 'center',
    color: COLOR_MUTED,
    lineGap: 0,
  });
  y += 10;
  y = text(doc, `发票号 ${facts.invoiceNo || '-'}`, MARGIN, y, contentW, {
    size: 11,
    align: 'center',
    color: COLOR_MUTED,
    lineGap: 0,
  });
  y += 8;
  y = line(doc, y);

  // ---- 已退款：如实标注（盖章式横幅，别只写在小字状态里）----
  const refunded = facts.refunded;
  if (refunded) {
    const bannerW = 140;
    const bannerX = (pageW - bannerW) / 2;
    doc.rect(bannerX, y, bannerW, 26).fillAndStroke('#fef2f2', COLOR_REFUND);
    face(doc, 14).fillColor(COLOR_REFUND);
    doc.text('已退款', bannerX, y + 7, { width: bannerW, align: 'center' });
    doc.fillColor(COLOR_TEXT);
    y += 38;
  }

  // ---- 两栏：发票信息 / 订单信息 ----
  const colW = halfW - 10;
  const colY0 = y + 4;
  let ly = sectionTitle(doc, '发票信息', MARGIN, colY0, colW);
  ly = kv(doc, '开票日期', fmtDate(invoice?.issued_at || invoice?.created_at) || '-', MARGIN, ly, colW);
  ly = kv(doc, '发票状态', facts.statusText, MARGIN, ly, colW);
  ly = kv(doc, '开具时间', fmtDateTime(invoice?.created_at) || '-', MARGIN, ly, colW);

  const rx = MARGIN + halfW;
  let ry = sectionTitle(doc, '订单信息', rx, colY0, colW);
  ry = kv(doc, '订单号', order?.order_no || '-', rx, ry, colW);
  ry = kv(doc, '支付日期', fmtDate(order?.paid_at) || '-', rx, ry, colW);
  ry = kv(doc, '支付方式', facts.paymentMethodText, rx, ry, colW);
  if (refunded) {
    ry = kv(doc, '退款时间', fmtDateTime(facts.refundedAt) || '已退款', rx, ry, colW, COLOR_REFUND);
  }

  y = Math.max(ly, ry) + 10;
  y = line(doc, y);

  // ---- 购买方 ----
  y = sectionTitle(doc, '购买方信息', MARGIN, y + 4, contentW);
  // users 表真实列：nickname（DEFAULT ''，空串要当没有）、phone、email。
  // 该表没有 display_name 列，故按 nickname → phone → email 兜底。
  const buyerName =
    String(user?.nickname || '').trim() ||
    String(user?.phone || '').trim() ||
    String(user?.email || '').trim() ||
    '未知用户';
  y = kv(doc, '购买方', buyerName, MARGIN, y, contentW);
  y = kv(doc, '用户 ID', user?.id || '-', MARGIN, y, contentW);
  if (user?.email) y = kv(doc, '邮箱', user.email, MARGIN, y, contentW);
  if (user?.phone) y = kv(doc, '手机号', user.phone, MARGIN, y, contentW);
  // title / tax_no 是 invoices 的真实列（履约链路目前不写 → 空则整行不显）
  if (invoice?.title) y = kv(doc, '发票抬头', invoice.title, MARGIN, y, contentW);
  if (invoice?.tax_no) y = kv(doc, '税号', invoice.tax_no, MARGIN, y, contentW);
  y += 10;

  // ---- 商品明细（单行：一次订阅 = 一件商品，数量恒 1）----
  y = sectionTitle(doc, '商品明细', MARGIN, y, contentW);
  const cols = [
    { label: '序号', w: 45, align: 'left' },
    { label: '商品名称', w: 235, align: 'left' },
    { label: '数量', w: 50, align: 'right' },
    { label: '单价', w: 85, align: 'right' },
    { label: '金额', w: contentW - 45 - 235 - 50 - 85, align: 'right' },
  ];
  let cx = MARGIN;
  doc.fillColor(COLOR_MUTED);
  for (const c of cols) {
    face(doc, 10);
    doc.text(c.label, cx, y, { width: c.w, align: c.align });
    cx += c.w;
  }
  doc.fillColor(COLOR_TEXT);
  y += 18;
  y = line(doc, y - 8) - 4;

  cx = MARGIN;
  const cells = [
    { v: '1', w: cols[0].w, align: cols[0].align },
    { v: facts.productName, w: cols[1].w, align: cols[1].align },
    { v: '1', w: cols[2].w, align: cols[2].align },
    { v: facts.paidText, w: cols[3].w, align: cols[3].align },
    { v: facts.paidText, w: cols[4].w, align: cols[4].align },
  ];
  for (const c of cells) {
    face(doc, 10).fillColor(COLOR_TEXT);
    doc.text(c.v, cx, y, { width: c.w, align: c.align, ellipsis: true });
    cx += c.w;
  }
  y += 20;
  y = line(doc, y);

  // ---- 金额汇总 ----
  // 口径：payment_orders.amount 就是渠道实付（回调履约前已按支付宝 total_amount
  // 对过账，见 payments.js 的 S1 校验），故「实付金额」直接取它，
  // **不做 amount + tax 的二次相加**（旧实现那么干会凭空造出一笔差价）。
  // invoices.tax_amount 由履约写 0；确为 0 时不显该行，非 0 时只作「其中税额」披露。
  const summaryLabelX = MARGIN + contentW - 220;
  const summaryValueX = summaryLabelX + 130;
  const summaryValueW = 90;

  y = sumRow(doc, '订单金额', facts.paidText, summaryLabelX, summaryValueX, summaryValueW, y) + 2;
  if (facts.tax > 0) {
    y = sumRow(doc, '其中税额', facts.taxText, summaryLabelX, summaryValueX, summaryValueW, y) + 2;
  }
  y = line(doc, y) + 4;
  doc.fillColor(refunded ? COLOR_REFUND : COLOR_TEXT);
  face(doc, 13);
  doc.text('实付金额', summaryLabelX, y, { width: 130, align: 'right' });
  doc.text(facts.paidText, summaryValueX, y, { width: summaryValueW, align: 'right' });
  doc.fillColor(COLOR_TEXT);
  y += 30;

  // ---- 说明（invoices **没有 notes 列**，此块只放由真实数据推得出的话）----
  y = sectionTitle(doc, '说明', MARGIN, y, contentW);
  const notes = refunded
    ? [
        `本订单已于 ${fmtDateTime(facts.refundedAt) || '此前'} 完成退款，金额 ${facts.paidText}，原付款凭证同时作废。`,
        `对应订单 ${order?.order_no || '-'}，支付方式 ${facts.paymentMethodText}。`,
      ]
    : [
        `本单为 ClipSync 订阅服务付款收据，对应订单 ${order?.order_no || '-'}，商品 ${facts.productName}。`,
        `支付渠道 ${facts.paymentMethodText}，支付时间 ${fmtDateTime(order?.paid_at) || '-'}。`,
      ];
  notes.push('本收据由系统自动生成，可作为付款凭证使用；如需增值税发票，请联系客服提供开票信息。');
  for (const n of notes) {
    y = text(doc, `· ${n}`, MARGIN, y, contentW, { size: 10, color: COLOR_MUTED }) + 2;
  }

  // ---- 页脚 ----
  const footerY = doc.page.height - MARGIN - 34;
  doc.moveTo(MARGIN, footerY - 12).lineTo(pageW - MARGIN, footerY - 12).strokeColor(COLOR_LINE).lineWidth(0.7).stroke();
  text(doc, `此发票由 ClipSync 自动生成，无需签字盖章。生成时间 ${fmtDateTime(new Date())}`, MARGIN, footerY, contentW, {
    size: 9,
    align: 'center',
    color: COLOR_MUTED,
    lineGap: 1,
  });
  text(doc, `如有疑问请联系客服：${EMAILS.support}`, MARGIN, footerY + 14, contentW, {
    size: 9,
    align: 'center',
    color: COLOR_MUTED,
    lineGap: 0,
  });

  doc.end();
}

/** 分节小标题（蓝色 12pt），返回下一行的 y */
function sectionTitle(doc, title, x, y, width) {
  const after = text(doc, title, x, y, width, { size: 12, color: COLOR_ACCENT, lineGap: 0 });
  return after + 6;
}

/** 标签-值 两列行（label 占 34% 宽度、上限 78pt，值可换行），返回下一行的 y */
function kv(doc, label, value, x, y, width, color) {
  const labelW = Math.min(78, Math.round(width * 0.34));
  const valueW = width - labelW;
  face(doc, 10);
  doc.fillColor(COLOR_MUTED);
  doc.text(label, x, y, { width: labelW });
  doc.fillColor(color || COLOR_TEXT);
  doc.text(String(value ?? '-'), x + labelW, y, { width: valueW });
  const h = Math.max(
    doc.heightOfString(label, { width: labelW }),
    doc.heightOfString(String(value ?? '-'), { width: valueW })
  );
  return y + h + 6;
}

/** 右对齐的「标签 金额」汇总行，返回下一行的 y */
function sumRow(doc, label, value, labelX, valueX, valueW, y) {
  face(doc, 10);
  doc.fillColor(COLOR_MUTED);
  doc.text(label, labelX, y, { width: valueX - labelX, align: 'right' });
  doc.fillColor(COLOR_TEXT);
  doc.text(value, valueX, y, { width: valueW, align: 'right' });
  return y + 16;
}

export {
  generateInvoicePDF,
  invoiceFacts,
  resolveInvoiceFont,
  FONT,
  face,
};
