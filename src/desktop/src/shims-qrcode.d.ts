// 第三方库类型声明（项目未安装其 @types，用 any 桥接，避免 vue-tsc 报错）
declare module 'qrcode' {
  const QRCode: any
  export default QRCode
}

declare module 'jsqr' {
  const jsQR: any
  export default jsQR
}
