/**
 * PDF 发票生成服务
 * 使用 pdfkit 生成电子发票 PDF
 */

import PDFDocument from 'pdfkit';
import { logger } from './logger.js';

/**
 * 生成发票 PDF
 * @param {Object} invoice - 发票数据
 * @param {Object} user - 用户数据
 * @param {Object} order - 订单数据
 * @returns {Promise<Buffer>} PDF Buffer
 */
export async function generateInvoicePDF(invoice, user, order) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: 50,
          bottom: 50,
          left: 50,
          right: 50,
        },
      });

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // 生成发票内容
      _generateInvoiceContent(doc, invoice, user, order);

      doc.end();
    } catch (err) {
      logger.error('Generate invoice PDF error:', err);
      reject(err);
    }
  });
}

/**
 * 生成发票内容
 */
function _generateInvoiceContent(doc, invoice, user, order) {
  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 100; // 左右边距各50

  // 标题
  doc.fontSize(24).font('Helvetica-Bold').text('电子发票', { align: 'center' });
  doc.moveDown(0.5);
  
  // 发票号
  doc.fontSize(12).font('Helvetica').text(`发票号: ${invoice.invoice_no}`, { align: 'center' });
  doc.moveDown(2);

  // 分隔线
  doc.moveTo(50, doc.y).lineTo(pageWidth - 50, doc.y).stroke();
  doc.moveDown(1);

  // 发票信息表格
  const tableTop = doc.y;
  
  // 左侧：发票信息
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('发票信息', 50, tableTop);
  
  doc.fontSize(10).font('Helvetica');
  doc.text(`发票号: ${invoice.invoice_no}`, 50, doc.y + 5);
  doc.text(`开票日期: ${new Date(invoice.created_at).toLocaleDateString('zh-CN')}`, 50, doc.y + 5);
  doc.text(`状态: ${_getInvoiceStatusText(invoice.status)}`, 50, doc.y + 5);
  
  // 右侧：订单信息
  doc.fontSize(10).font('Helvetica-Bold');
  doc.text('订单信息', pageWidth / 2, tableTop);
  
  doc.fontSize(10).font('Helvetica');
  doc.text(`订单号: ${order.order_no}`, pageWidth / 2, doc.y + 5);
  doc.text(`支付日期: ${order.paid_at ? new Date(order.paid_at).toLocaleDateString('zh-CN') : '-'}`, pageWidth / 2, doc.y + 5);
  doc.text(`支付方式: ${_getPaymentMethodText(order.payment_method)}`, pageWidth / 2, doc.y + 5);
  
  doc.moveDown(3);

  // 买方信息
  doc.fontSize(12).font('Helvetica-Bold').text('购买方信息');
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica');
  doc.text(`用户名: ${user.nickname || user.phone || user.email || '未知用户'}`);
  doc.text(`用户ID: ${user.id}`);
  if (user.email) doc.text(`邮箱: ${user.email}`);
  if (user.phone) doc.text(`手机号: ${user.phone}`);
  doc.moveDown(2);

  // 商品明细表格
  doc.fontSize(12).font('Helvetica-Bold').text('商品明细');
  doc.moveDown(0.5);

  // 表格头
  const tableHeaders = ['序号', '商品名称', '数量', '单价', '金额'];
  const colWidths = [50, 250, 60, 80, 80];
  let tableY = doc.y;
  
  // 绘制表头
  doc.fontSize(10).font('Helvetica-Bold');
  let colX = 50;
  tableHeaders.forEach((header, i) => {
    doc.text(header, colX, tableY, { width: colWidths[i], align: i === 0 ? 'left' : 'right' });
    colX += colWidths[i];
  });
  
  doc.moveDown(0.5);
  tableY = doc.y;
  
  // 绘制表头下划线
  doc.moveTo(50, tableY).lineTo(pageWidth - 50, tableY).stroke();
  doc.moveDown(0.5);
  
  // 表格内容（这里需要根据实际订单内容填充）
  // 暂时使用订阅信息作为商品
  doc.fontSize(10).font('Helvetica');
  colX = 50;
  doc.text('1', colX, doc.y, { width: colWidths[0], align: 'left' });
  colX += colWidths[0];
  
  doc.text(order.metadata?.planName || 'ClipSync 订阅', colX, doc.y - 12, { width: colWidths[1], align: 'left' });
  colX += colWidths[1];
  
  doc.text('1', colX, doc.y - 12, { width: colWidths[2], align: 'right' });
  colX += colWidths[2];
  
  doc.text(`¥${parseFloat(order.amount).toFixed(2)}`, colX, doc.y - 12, { width: colWidths[3], align: 'right' });
  colX += colWidths[3];
  
  doc.text(`¥${parseFloat(order.amount).toFixed(2)}`, colX, doc.y - 12, { width: colWidths[4], align: 'right' });
  
  doc.moveDown(2);
  tableY = doc.y;
  
  // 绘制表格下划线
  doc.moveTo(50, tableY).lineTo(pageWidth - 50, tableY).stroke();
  doc.moveDown(1);

  // 金额汇总
  const amount = parseFloat(order.amount);
  const tax = invoice.tax ? parseFloat(invoice.tax) : 0;
  const total = amount + tax;
  
  doc.fontSize(10).font('Helvetica');
  const summaryX = pageWidth - 200;
  let summaryY = doc.y;
  
  doc.text('小计:', summaryX, summaryY, { width: 100, align: 'right' });
  doc.text(`¥${amount.toFixed(2)}`, summaryX + 100, summaryY, { width: 80, align: 'right' });
  
  if (tax > 0) {
    summaryY = doc.y + 5;
    doc.text('税费:', summaryX, summaryY, { width: 100, align: 'right' });
    doc.text(`¥${tax.toFixed(2)}`, summaryX + 100, summaryY, { width: 80, align: 'right' });
  }
  
  summaryY = doc.y + 10;
  doc.fontSize(12).font('Helvetica-Bold');
  doc.text('总计:', summaryX, summaryY, { width: 100, align: 'right' });
  doc.text(`¥${total.toFixed(2)}`, summaryX + 100, summaryY, { width: 80, align: 'right' });
  
  doc.moveDown(3);

  // 备注
  if (invoice.notes) {
    doc.fontSize(10).font('Helvetica-Bold').text('备注');
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica').text(invoice.notes);
    doc.moveDown(2);
  }

  // 页脚
  doc.fontSize(9).font('Helvetica').text(
    '此发票由 ClipSync 自动生成，无需签字盖章。',
    50,
    doc.page.height - 100,
    { align: 'center', width: contentWidth }
  );
  
  doc.text(
    '如有疑问，请联系客服: support@clipsync.com',
    50,
    doc.y + 5,
    { align: 'center', width: contentWidth }
  );
}

/**
 * 获取发票状态文本
 */
function _getInvoiceStatusText(status) {
  const statusMap = {
    'draft': '草稿',
    'issued': '已开具',
    'paid': '已支付',
    'cancelled': '已取消',
    'refunded': '已退款',
  };
  return statusMap[status] || status;
}

/**
 * 获取支付方式文本
 */
function _getPaymentMethodText(method) {
  const methodMap = {
    'mock': '模拟支付',
    'wechat': '微信支付',
    'alipay': '支付宝',
    'stripe': 'Stripe',
    'apple_pay': 'Apple Pay',
    'google_pay': 'Google Pay',
  };
  return methodMap[method] || method;
}

export default {
  generateInvoicePDF,
};
