/**
 * 从定稿 SVG（48 网格）渲染桌面端全套图标：
 *   32x32.png / 128x128.png / 128x128@2x.png(256) / icon.ico（PNG 直嵌三尺寸）
 * 圆角外保留透明通道；ico 目录项 256px 按规范以 0 记录。
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', 'clipsync-mark-gradient.svg');
const OUT = path.resolve(__dirname, '..', '..', '..', 'src', 'desktop', 'src-tauri', 'icons');

async function renderPng(size, file) {
  // density = 72dpi 基准 × 目标边长/48 视图单位，保证一次性矢量放大不糊
  const density = Math.round((72 * size) / 48);
  const buf = await sharp(SRC, { density }).png().toBuffer();
  await sharp(buf).resize(size, size).png().toFile(path.join(OUT, file));
  return buf;
}

function buildIco(entries) {
  // entries: [{size, png}] —— ICO 头 + 目录项 + 图片数据（PNG 直嵌）
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  const blobs = [];
  entries.forEach(({ size, png }, i) => {
    const b = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, b); // width（256 记 0）
    dir.writeUInt8(size >= 256 ? 0 : size, b + 1); // height
    dir.writeUInt8(0, b + 2); // palette
    dir.writeUInt8(0, b + 3); // reserved
    dir.writeUInt16LE(1, b + 4); // color planes
    dir.writeUInt16LE(32, b + 6); // bits per pixel
    dir.writeUInt32LE(png.length, b + 8); // data size
    dir.writeUInt32LE(offset, b + 12); // data offset
    offset += png.length;
    blobs.push(png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

(async () => {
  const p32 = await renderPng(32, '32x32.png');
  const p128 = await renderPng(128, '128x128.png');
  const p256 = await renderPng(256, '128x128@2x.png');
  fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco([
    { size: 32, png: p32 },
    { size: 128, png: p128 },
    { size: 256, png: p256 },
  ]));
  console.log('desktop icons written to', OUT);
})();
