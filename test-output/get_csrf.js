// 从后端获取 CSRF Token 并保存
const https = require('https');
const http = require('http');
const fs = require('fs');

const token = JSON.parse(fs.readFileSync('login_result.json', 'utf8')).token;
console.log('使用 Token:', token.substring(0, 20) + '...');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/csrf-token',
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('CSRF 响应:', data);
    const csrf = JSON.parse(data).csrfToken;
    fs.writeFileSync('csrf_token.txt', csrf);
    console.log('✅ CSRF Token 已保存到 csrf_token.txt');
  });
});
req.on('error', e => console.error('错误:', e.message));
req.end();
