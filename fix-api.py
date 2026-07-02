import re

file_path = r'D:\work\java\AI-workspace\ClipSync\src\desktop\src\index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix 1: Update api() function to add silent parameter
old_api = '''    async function api(method, path, body) {
      const opts = { method, headers: {} };
      if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(API_BASE + path, opts);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Request failed');
      return data;
    }'''

new_api = '''    async function api(method, path, body, silent) {
      const opts = { method, headers: {} };
      if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;
      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(API_BASE + path, opts);
      const data = await resp.json();
      if (!resp.ok) {
        if (!silent) console.error('API Error:', path, data.error);
        throw new Error(data.error || 'Request failed');
      }
      return data;
    }'''

content = content.replace(old_api, new_api)

# Write back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print('✅ File updated successfully')
