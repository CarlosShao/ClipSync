
    // ====== State ======
    // API 基础路径 — 开发环境通过 dev-server.py 代理，同源请求无需 CORS
    const API_BASE = window.location.origin;  // http://localhost:1420 (proxied to 3001)
    // WS 也走代理，但 WebSocket 不支持 HTTP 代理，所以直连后端
    const WS_URL = 'ws://localhost:3001/ws';
    let state = {
      token: localStorage.getItem('cs_token') || null,
      user: JSON.parse(localStorage.getItem('cs_user') || 'null'),
      deviceId: localStorage.getItem('cs_device_id') || null,
      items: [],
      devices: [],
      ws: null,
      wsConnected: false,
      currentPage: 'clipboard',
      searchQuery: '',
      autoSync: true,
      currentClipboard: '',
    };

    // ====== Init ======
    // Track whether device is ready (loaded from API or registered)
    let deviceReady = false;
    let tauriRetryCount = 0;
    const MAX_TAURI_RETRIES = 3;

    window.addEventListener('DOMContentLoaded', async () => {
      // ====== DIAGNOSTIC: Check Tauri IPC availability ======
      const hasTAURI = !!(window.__TAURI__);
      const t = window.__TAURI__;
      // Tauri 2.x: invoke at .core.invoke; Tauri 1.x: at .invoke; CDN fallback: __TAURI_INVOKE__
      const hasCdnInvoke = !!window.__TAURI_INVOKE__;
      const hasInvoke = !!(
        (t && t.core && typeof t.core.invoke === 'function') ||
        (t && typeof t.invoke === 'function') ||
        hasCdnInvoke
      );
      const hasTAURIInternals = !!(window.__TAURI_INTERNALS__);
      console.log('[Diag] __TAURI__:', hasTAURI, '| core.invoke:', !!(t && t.core), '| invoke(1.x):', !!(t && t.invoke));
      console.log('[Diag] CDN invoke:', hasCdnInvoke, '| final hasInvoke:', hasInvoke, '| __TAURI_INTERNALS__:', !!window.__TAURI_INTERNALS__);
      if (window.__TAURI_INTERNALS__) {
        console.log('[Diag] __TAURI_INTERNALS__ keys:', Object.keys(window.__TAURI_INTERNALS__));
      }
      console.log('[Diag] url:', window.location.href);

      // Visual indicator for Tauri mode vs browser mode
      const modeIndicator = document.createElement('div');
      modeIndicator.className = 'diag-badge';
      if (hasInvoke) {
        modeIndicator.textContent = 'Tauri IPC';
        modeIndicator.style.background = '#D1FAE5'; modeIndicator.style.color = '#059669';
      } else if (hasTAURI) {
        modeIndicator.textContent = 'Tauri no invoke';
        modeIndicator.style.background = '#FEE2E2'; modeIndicator.style.color = '#DC2626';
      } else if (hasTAURIInternals) {
        modeIndicator.textContent = 'Tauri Internals';
        modeIndicator.style.background = '#FEF3C7'; modeIndicator.style.color = '#D97706';
      } else {
        modeIndicator.textContent = 'Browser';
        modeIndicator.style.background = '#FEE2E2'; modeIndicator.style.color = '#DC2626';
      }
      document.body.appendChild(modeIndicator);

      // Request clipboard read permission upfront for image detection
      try {
        await navigator.permissions.query({ name: 'clipboard-read' });
      } catch (permErr) {
        console.log('[Init] clipboard-read permission query not supported, will try anyway');
      }

      // Paste event listener for file detection
      // Browser Clipboard API cannot read file paths from system-level copies (Ctrl+C in Explorer).
      // But when user pastes (Ctrl+V), paste.clipboardData.files will contain the file!
      document.addEventListener('paste', (event) => {
        const files = event.clipboardData?.files;
        const items = event.clipboardData?.items;
        if (files && files.length > 0) {
          console.log('[Paste] detected', files.length, 'file(s)');
          for (const file of files) {
            console.log('[Paste] file:', file.name, file.size, file.type);
            if (file.type.startsWith('image/')) {
              // Upload as image
              const reader = new FileReader();
              reader.onload = (e) => {
                uploadImageClipboard(e.target.result, file.type, file.size);
              };
              reader.readAsDataURL(file);
            } else {
              // Upload as file
              const reader = new FileReader();
              reader.onload = (e) => {
                uploadFileBlobFromPaste(e.target.result, file.name, file.type, file.size);
              };
              reader.readAsDataURL(file);
            }
          }
        } else if (items && items.length > 0) {
          // Check for text/uri-list (file references)
          for (const item of items) {
            if (item.type === 'text/uri-list') {
              item.getAsString((uri) => {
                if (uri && uri.startsWith('file://')) {
                  console.log('[Paste] file URI:', uri.substring(0, 60));
                  uploadFileUri(uri);
                }
              });
            }
          }
        }
      });

      if (state.token && state.user) {
        showMainApp();
        // Drag-and-drop file upload
        setupDragDrop();
        // CRITICAL: Must load devices FIRST, then connect WS + start clipboard
        try {
          await loadDevices();
          deviceReady = true;
        } catch (e) {
          console.error('[Init] loadDevices failed:', e.message);
          showToast('设备加载失败，请刷新重试');
          return;
        }
        loadClipboardItems();
        connectWebSocket();
        attachClipboardListener();
      } else {
        document.getElementById('login-modal').classList.remove('hidden');
        attachClipboardListener();  // Attach but won't upload without deviceId
      }
    });

    // ====== Clipboard Listener (Tauri native or browser fallback) ======
    // Tauri 2.x detection: check for window.__TAURI__.invoke (the most reliable indicator)
    // DO NOT check window.__TAURI__.event — it doesn't exist in Tauri 2.x!
    async function attachClipboardListener() {
      // Guard: prevent multiple attachments
      if (state._listenerAttached) return;
      state._listenerAttached = true;

      // Check ALL possible invoke sources:
      // 1) Tauri 2.x: window.__TAURI__.core.invoke
      // 2) Tauri 1.x: window.__TAURI__.invoke
      // 3) CDN import: window.__TAURI_INVOKE__ (for external devUrl)
      const tauri = window.__TAURI__;
      let hasInvoke = !!(
        (tauri && tauri.core && typeof tauri.core.invoke === 'function') ||
        (tauri && typeof tauri.invoke === 'function') ||
        window.__TAURI_INVOKE__
      );

      // If running inside Tauri (__TAURI_INTERNALS__ exists) but invoke isn't ready yet,
      // the CDN module may still be loading — poll for it up to 3s
      if (!hasInvoke && window.__TAURI_INTERNALS__) {
        console.log('[Clipboard] ⏳ Inside Tauri but invoke not ready yet, waiting for CDN module...');
        for (let i = 0; i < 15 && !hasInvoke; i++) {
          await new Promise(r => setTimeout(r, 200));
          hasInvoke = !!(
            (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') ||
            (window.__TAURI__ && typeof window.__TAURI__.invoke === 'function') ||
            window.__TAURI_INVOKE__
          );
        }
        console.log('[Clipboard] After wait:', hasInvoke ? '✅ invoke found!' : '❌ still no invoke');
      }

      if (hasInvoke) {
        // ✅ Tauri mode: use invoke-based polling (reliable, no event issues)
        console.log('[Clipboard] ✅ Tauri detected — using invoke-based polling (500ms)');
        startTauriClipboardPoll();
      } else {
        // ❌ Browser mode: use Clipboard API (limited — cannot detect file copies from Explorer)
        console.log('[Clipboard] ⚠️ Browser mode — Clipboard API only (no native file detection)');
        console.log('[Clipboard] → Files copied in Explorer will NOT be auto-detected in browser mode');
        console.log('[Clipboard] → Use Tauri app window for full file detection');
        startBrowserClipboardPoll();
      }
    }

    // ====== Tauri invoke-based clipboard polling (primary mechanism) ======
    // This is the ONLY clipboard detection mechanism — no Rust thread, no events.
    // Polls `invoke('get_clipboard_files')` + `invoke('get_clipboard_content')` every 500ms.

    function startTauriClipboardPoll() {
      if (state._tauriPollStarted) return;
      state._tauriPollStarted = true;

      let _lastPolledText = '';
      let _lastPolledFiles = '';
      let pollCount = 0;

      console.log('[TauriPoll] ✓ invoke-based polling STARTED (500ms)');

      async function pollTauri() {
        pollCount++;
        // Resolve invoke function from any available source
        const tauri = window.__TAURI__;
        let _invoke = null;
        if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
          _invoke = tauri.core.invoke.bind(tauri.core);
        } else if (tauri && typeof tauri.invoke === 'function') {
          _invoke = tauri.invoke.bind(tauri);
        } else if (window.__TAURI_INVOKE__) {
          _invoke = window.__TAURI_INVOKE__;
        }
        if (!_invoke) return;
        if (!state.autoSync) return;
        if (!deviceReady && !state.deviceId) return; // Wait for device to be ready

        try {
          // 1) Check for files via invoke
          const files = await _invoke('get_clipboard_files');
          if (Array.isArray(files) && files.length > 0) {
            const fileKey = files.join('|');
            if (fileKey !== _lastPolledFiles) {
              _lastPolledFiles = fileKey;
              console.log('[TauriPoll] 📁 FILE detected:', files.length, 'file(s), first:', files[0].split(/[/\\]/).pop());
              const fileName = files[0].split(/[/\\]/).pop() || 'unknown';
              const preview = files.length === 1
                ? '[文件] ' + fileName + ' (1个文件)'
                : '[文件] ' + fileName + ' 等 ' + files.length + ' 个文件';
              // Upload as file item with metadata.filePaths (NOT text!)
              await uploadTauriFileClipboard(files);
              showToast('📁 检测到文件复制: ' + fileName);
            }
            return; // Files take priority over text
          }

          // 2) Check for text via invoke
          const text = await _invoke('get_clipboard_content');
          if (text && text !== _lastPolledText && text !== state.currentClipboard) {
            _lastPolledText = text;
            console.log('[TauriPoll] 📝 TEXT detected:', text.length, 'chars');
            uploadClipboard(text);
          }

          // 3) Reset file tracking when files are cleared
          if (_lastPolledFiles && (!files || files.length === 0)) {
            _lastPolledFiles = '';
          }
        } catch (e) {
          if (pollCount % 60 === 1) {
            console.warn('[TauriPoll] invoke error:', e.message || e);
          }
        }
      }

      setInterval(pollTauri, 500);
      pollTauri();
    }

    function startBrowserClipboardPoll() {
      if (state._clipboardPolling) return;
      state._clipboardPolling = true;
      let lastText = '';
      let lastImageHash = '';
      let lastFileKey = '';
      console.log('[Clipboard] browser poll started (1s interval)');

      // Simple hash for image data comparison (first 100 chars of b64)
      function imgHash(b64) { return b64 ? b64.substring(0, 100) : ''; }

      async function pollClipboard() {
        try {
          if (!state.autoSync || !state.deviceId || !deviceReady) return;

          // Use read() for image + file detection (more types available)
          try {
            const items = await navigator.clipboard.read();
            if (items && items.length > 0) {
              for (const item of items) {
                // --- IMAGE ---
                const imgType = item.types.find(t => t.startsWith('image/'));
                if (imgType) {
                  const blob = await item.getType(imgType);
                  if (blob.size > 0) {
                    const b64 = await blobToBase64(blob);
                    const hash = imgHash(b64);
                    if (hash !== lastImageHash) {
                      lastImageHash = hash;
                      lastText = '';
                      lastFileKey = '';
                      state.currentClipboard = '';
                      console.log('[Clipboard] detected image, size=', blob.size);
                      uploadImageClipboard(b64, blob.type, blob.size);
                      return;
                    }
                  }
                  break;
                }

                // --- FILE (actual File objects from clipboard) ---
                const fileType = item.types.find(t => t === 'Files' || t.startsWith('application/x-file'));
                if (fileType) {
                  const blob = await item.getType(fileType);
                  const fileKey = blob.size + '|' + (blob.name || blob.type || '');
                  if (fileKey !== lastFileKey) {
                    lastFileKey = fileKey;
                    lastText = '';
                    lastImageHash = '';
                    state.currentClipboard = '';
                    console.log('[Clipboard] detected file, type=', fileType, 'size=', blob.size);
                    uploadFileClipboard(blob, fileType);
                    return;
                  }
                  break;
                }

                // --- URI list (file paths like file:///C:/path/to/file.txt) ---
                if (item.types.includes('text/uri-list')) {
                  const blob = await item.getType('text/uri-list');
                  const uriText = await blob.text();
                  if (uriText && uriText.startsWith('file://')) {
                    const fileKey = uriText;
                    if (fileKey !== lastFileKey) {
                      lastFileKey = fileKey;
                      lastText = '';
                      lastImageHash = '';
                      state.currentClipboard = '';
                      console.log('[Clipboard] detected file URI:', uriText.substring(0, 80));
                      uploadFileUri(uriText);
                      return;
                    }
                  }
                  break;
                }
              }
            }
          } catch (e) {
            // Debug: log what types are actually available
            console.warn('[Clipboard] navigator.clipboard.read() failed:', e.message);
            // Try to enumerate types via a more permissive approach
            try {
              // navigator.clipboard.read() doesn't support file types from system in most browsers
              // Fallback: check if ClipboardEvent has files
            } catch (_) {}
          }

          // --- Try text ---
          const text = await navigator.clipboard.readText();
          if (text && text !== lastText && text !== state.currentClipboard && !text.startsWith('file://')) {
            lastText = text;
            state.currentClipboard = text;
            lastImageHash = '';
            lastFileKey = '';
            console.log('[Clipboard] browser poll detected text change, len=', text.length);
            uploadClipboard(text);
          }
        } catch (e) {
          // Clipboard API requires permission or not available — silently ignore
        }
      }
      setInterval(pollClipboard, 1000);
      pollClipboard();
    }

    // Helper: Blob → base64 data URL
    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result); // data:image/png;base64,...
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }

    // Upload image clipboard item
    async function uploadImageClipboard(dataUrl, mimeType, fileSize) {
      if (!state.deviceId) {
        state.deviceId = localStorage.getItem('cs_device_id');
      }
      if (!state.deviceId || !deviceReady) {
        console.warn('[UploadImage] SKIPPED: deviceId=', state.deviceId);
        return;
      }
      console.log('[UploadImage] START', { mimeType, size: fileSize, deviceId: state.deviceId.substring(0, 12) });
      try {
        await api('POST', '/api/clipboard', {
          sourceDeviceId: state.deviceId,
          contentType: 'image',
          contentEncrypted: dataUrl, // Base64 data URL or raw b64
          contentPreview: '[图片] ' + mimeType + ' (' + (fileSize / 1024).toFixed(1) + 'KB)',
          contentSize: fileSize,
        });
        console.log('[UploadImage] SUCCESS');
        loadClipboardItems();
        showToast('图片已同步');
      } catch (e) {
        console.error('[UploadImage] FAILED:', e.message);
        showToast('图片同步失败：' + e.message);
      }
    }

    // Upload file clipboard item (actual file blob from clipboard)
    async function uploadFileClipboard(blob, type) {
      if (!state.deviceId) {
        state.deviceId = localStorage.getItem('cs_device_id');
      }
      if (!state.deviceId || !deviceReady) return;
      const fileName = blob.name || ('clipboard_file_' + Date.now());
      const fileSize = blob.size;
      const fileNameDisplay = fileName.length > 50 ? fileName.substring(0, 47) + '...' : fileName;
      console.log('[UploadFile] START', { fileName, type, size: fileSize });
      try {
        // Convert file blob to base64
        const b64 = await blobToBase64(blob);
        await api('POST', '/api/clipboard', {
          sourceDeviceId: state.deviceId,
          contentType: 'file',
          contentEncrypted: b64,
          contentPreview: '[文件] ' + fileNameDisplay + ' (' + (fileSize / 1024).toFixed(1) + 'KB)',
          contentSize: fileSize,
          metadata: { fileName, mimeType: type },
        });
        console.log('[UploadFile] SUCCESS');
        loadClipboardItems();
        showToast('文件已同步');
      } catch (e) {
        console.error('[UploadFile] FAILED:', e.message);
        showToast('文件同步失败：' + e.message);
      }
    }

    // Upload file URI (file path like file:///C:/path/to/file.txt)
    async function uploadFileUri(uri) {
      if (!state.deviceId) {
        state.deviceId = localStorage.getItem('cs_device_id');
      }
      if (!state.deviceId || !deviceReady) return;
      // Extract file name from path
      const filePath = decodeURIComponent(uri.replace(/^file:\/\/\//, ''));
      const fileName = filePath.split(/[/\\]/).pop() || 'unknown';
      console.log('[UploadFileURI] START', { uri: uri.substring(0, 60), fileName });
      try {
        // Clean up Windows paths: file:///C:/... → C:/...
        let cleanPath = uri.replace(/^file:\/\/\//, '');
        // Decode percent-encoded characters
        cleanPath = decodeURIComponent(cleanPath);
        await api('POST', '/api/clipboard', {
          sourceDeviceId: state.deviceId,
          contentType: 'file',
          contentEncrypted: uri,
          contentPreview: '[文件] ' + fileName,
          contentSize: 0,
          metadata: { filePath: cleanPath, fileName },
        });
        console.log('[UploadFileURI] SUCCESS');
        loadClipboardItems();
        showToast('文件已同步');
      } catch (e) {
        console.error('[UploadFileURI] FAILED:', e.message);
        showToast('文件同步失败：' + e.message);
      }
    }

    // Upload file blob from paste event (actual file content)
    async function uploadFileBlobFromPaste(dataUrl, fileName, mimeType, fileSize) {
      if (!state.deviceId) {
        state.deviceId = localStorage.getItem('cs_device_id');
      }
      if (!state.deviceId || !deviceReady) {
        console.warn('[UploadPaste] SKIPPED: no deviceId');
        return;
      }
      const sizeKB = (fileSize / 1024).toFixed(1);
      console.log('[UploadPaste] START', { fileName, mimeType, size: sizeKB + 'KB' });
      try {
        await api('POST', '/api/clipboard', {
          sourceDeviceId: state.deviceId,
          contentType: mimeType.startsWith('image/') ? 'image' : 'file',
          contentEncrypted: dataUrl,
          contentPreview: (mimeType.startsWith('image/') ? '[图片粘贴] ' : '[文件粘贴] ') + fileName + ' (' + sizeKB + 'KB)',
          contentSize: fileSize,
          metadata: { fileName, mimeType, source: 'paste' },
        });
        console.log('[UploadPaste] SUCCESS');
        loadClipboardItems();
        showToast((mimeType.startsWith('image/') ? '图片' : '文件') + '已同步');
      } catch (e) {
        console.error('[UploadPaste] FAILED:', e.message);
      }
    }

    // Upload file item from Tauri poll — stores original file paths
    // so that viewFileItem() can restore CF_HDROP later.
    async function uploadTauriFileClipboard(files) {
      if (!state.deviceId) {
        state.deviceId = localStorage.getItem('cs_device_id');
      }
      if (!state.deviceId || !deviceReady) {
        console.warn('[UploadTauriFile] SKIPPED: deviceId=', state.deviceId);
        if (!state.deviceId && state.token) {
          try {
            await loadDevices();
            deviceReady = true;
            if (state.deviceId) return uploadTauriFileClipboard(files);
          } catch (e) {
            console.error('[UploadTauriFile] Registration failed:', e.message);
          }
        }
        return;
      }
      const fileName = files[0].split(/[/\\]/).pop() || 'unknown';
      const preview = files.length === 1
        ? fileName
        : fileName + ' 等 ' + files.length + ' 个文件';
      console.log('[UploadTauriFile] START', { count: files.length, deviceId: state.deviceId.substring(0, 12) });
      try {
        await api('POST', '/api/clipboard', {
          sourceDeviceId: state.deviceId,
          contentType: 'file',
          contentEncrypted: btoa(unescape(encodeURIComponent(files.join('\n')))),
          contentPreview: preview,
          metadata: { fileName, filePaths: files },
        });
        console.log('[UploadTauriFile] SUCCESS');
        loadClipboardItems();
      } catch (e) {
        console.error('[UploadTauriFile] FAILED:', e.message);
      }
    }

    // ====== Log clipboard API capability for debugging ======
    // (Inform the user why file auto-sync from Explorer doesn't work)
    if (navigator.clipboard && navigator.clipboard.read) {
      console.log('[Clipboard] navigator.clipboard.read() supported — can detect text/images');
      console.log('[Clipboard] Note: file system copies (Ctrl+C in Explorer) are NOT accessible via web APIs');
      console.log('[Clipboard] For files: paste (Ctrl+V) or drag-drop directly into the app');
    }

    // ====== Auth ======
    async function sendCode() {
      const phone = document.getElementById('phone-input').value.trim();
      if (!phone || phone.length !== 11) { showToast('请输入11位手机号'); return; }
      const btn = document.getElementById('send-code-btn');
      btn.disabled = true;
      try {
        await api('POST', '/api/auth/send-code', { phone });
        showToast('验证码已发送（MVP: 888888）');
        let sec = 60;
        btn.textContent = sec + 's';
        const timer = setInterval(() => {
          sec--;
          btn.textContent = sec + 's';
          if (sec <= 0) { clearInterval(timer); btn.textContent = '发送验证码'; btn.disabled = false; }
        }, 1000);
      } catch (e) {
        showToast('发送失败: ' + e.message);
        btn.disabled = false;
      }
    }

    async function login() {
      const phone = document.getElementById('phone-input').value.trim();
      const code = document.getElementById('code-input').value.trim();
      const tosAccepted = document.getElementById('tos-checkbox').checked;
      if (!phone || !code) { showToast('请输入手机号和验证码'); return; }
      if (!tosAccepted) { showToast('请先同意服务条款和隐私政策'); return; }
      try {
        const data = await api('POST', '/api/auth/verify-code', { phone, code, accept_tos: tosAccepted, accept_privacy: tosAccepted });
        state.token = data.token;
        state.user = data.user;
        localStorage.setItem('cs_token', data.token);
        localStorage.setItem('cs_user', JSON.stringify(data.user));
        showMainApp();
        // Sequential init: devices → clipboard → websocket
        try {
          await loadDevices();
          deviceReady = true;
        } catch (e) {
          console.error('[Login] loadDevices failed:', e.message);
        }
        loadClipboardItems();
        connectWebSocket();
        // Ensure clipboard listener is attached
        if (!state._listenerAttached) attachClipboardListener();
        showToast('登录成功');
      } catch (e) {
        showToast('登录失败: ' + e.message);
      }
    }

    function logout() {
      state.token = null;
      state.user = null;
      state.deviceId = null;
      localStorage.removeItem('cs_token');
      localStorage.removeItem('cs_user');
      localStorage.removeItem('cs_device_id');
      if (state.ws) { state.ws.close(); state.ws = null; }
      document.getElementById('main-app').style.display = 'none';
      document.getElementById('login-modal').classList.remove('hidden');
    }

    function showMainApp() {
      document.getElementById('login-modal').classList.add('hidden');
      document.getElementById('main-app').style.display = 'grid';
      const u = state.user;
      const name = (u && u.nickname) || (u && u.phone) || '?';
      document.getElementById('user-name').textContent = name;
      document.getElementById('user-phone').textContent = u?.phone || '';
      document.getElementById('user-avatar').textContent = name[0].toUpperCase();
    }

    // ====== Drag & Drop File Upload ======
    function setupDragDrop() {
      // Listen on document level to catch drag events on all child elements
      document.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        document.getElementById('main-app').style.opacity = '0.7';
      });
      document.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('main-app').style.opacity = '1';
      });
      document.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.getElementById('main-app').style.opacity = '1';
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
          console.log('[Drop] received', files.length, 'file(s)');
          for (const file of files) {
            console.log('[Drop] file:', file.name, file.size, file.type);
            const reader = new FileReader();
            reader.onload = (ev) => {
              if (file.type.startsWith('image/')) {
                uploadImageClipboard(ev.target.result, file.type, file.size);
              } else {
                uploadFileBlobFromPaste(ev.target.result, file.name, file.type, file.size);
              }
            };
            reader.readAsDataURL(file);
          }
        } else {
          console.warn('[Drop] no files detected in drop event');
        }
      });
      console.log('[Drop] drag-and-drop file upload ready (document-level)');
    }

    // ====== API helper ======
    // Cached CSRF token (single-use on server, but we cache briefly for resilience)
    let _cachedCsrfToken = null;
    let _csrfFetchTime = 0;
    const CSRF_CACHE_MS = 5000; // Cache token for 5 seconds max

    async function api(method, path, body) {
      const opts = { method, headers: {} };
      if (state.token) opts.headers['Authorization'] = 'Bearer ' + state.token;

      // CSRF: fetch fresh token before each non-GET request
      if (state.token && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        const now = Date.now();
        // Use cached token if still fresh (<5s old)
        if (_cachedCsrfToken && (now - _csrfFetchTime < CSRF_CACHE_MS)) {
          opts.headers['x-csrf-token'] = _cachedCsrfToken;
          console.log('[CSRF] using cached token');
        } else {
          try {
            const csrfResp = await fetch(API_BASE + '/api/csrf-token', {
              headers: { 'Authorization': 'Bearer ' + state.token },
              mode: 'cors',
            });
            if (csrfResp.ok) {
              const { csrfToken } = await csrfResp.json();
              _cachedCsrfToken = csrfToken;
              _csrfFetchTime = Date.now();
              opts.headers['x-csrf-token'] = csrfToken;
              console.log('[CSRF] fetched fresh token');
            } else {
              console.warn('[CSRF] server returned', csrfResp.status);
            }
          } catch (e) {
            // If CORS blocks or network fails, use stale cache or proceed without
            console.warn('[CSRF] fetch failed:', e.message, '- will retry on 403');
          }
        }
      }

      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(API_BASE + path, opts);

      // Safe JSON parse: handle non-JSON responses gracefully
      let data;
      const text = await resp.text();
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        // Response is not valid JSON — return structured error
        console.error('[API] Non-JSON response for', method, path, ':', text.substring(0, 200));
        throw new Error('Server returned invalid response (' + resp.status + ')');
      }

      // If 403 due to CSRF issue, retry ONCE with fresh token
      if (resp.status === 403 && (data.error || '').includes('CSRF') && !opts._csrfRetried) {
        console.warn('[API] 403 CSRF error, invalidating cache and retrying...');
        _cachedCsrfToken = null;
        _csrfFetchTime = 0;
        opts._csrfRetried = true; // Mark as retried to prevent infinite loops
        return api(method, path, body); // Recursive retry with fresh token
      }

      if (!resp.ok) throw new Error(data.error || 'Request failed (' + resp.status + ')');
      return data;
    }

    // ====== WebSocket ======
    function connectWebSocket() {
      if (state.ws) { state.ws.close(); }
      updateConnStatus('connecting');
      const ws = new WebSocket(WS_URL + '?token=' + state.token);
      state.ws = ws;

      ws.onopen = () => {
        updateConnStatus('online');
        // Register current device
        if (state.deviceId) {
          ws.send(JSON.stringify({ type: 'register', deviceId: state.deviceId }));
        }
        // Heartbeat
        setInterval(() => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30000);
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      };

      ws.onclose = () => {
        updateConnStatus('offline');
        // Auto reconnect after 5s
        setTimeout(() => {
          if (state.token) connectWebSocket();
        }, 5000);
      };

      ws.onerror = () => {
        updateConnStatus('offline');
      };
    }

    function handleWsMessage(msg) {
      switch (msg.type) {
        case 'registered':
          const wasNew = (state.deviceId !== msg.deviceId);
          state.deviceId = msg.deviceId;
          localStorage.setItem('cs_device_id', msg.deviceId);
          deviceReady = true;
          if (wasNew) showToast('设备已注册');
          break;
        case 'error':
          console.error('WS error:', msg.message);
          // Handle "Device not found" — stale deviceId, need to re-register
          if (msg.message === 'Device not found') {
            console.warn('[WS] Device not found — clearing stale deviceId and re-registering');
            state.deviceId = null;
            localStorage.removeItem('cs_device_id');
            deviceReady = false;
            // Re-register device
            loadDevices().then(() => {
              deviceReady = true;
              console.log('[WS] Device re-registered successfully');
            }).catch(e => {
              console.error('[WS] Re-registration failed:', e.message);
              showToast('设备注册失败：' + e.message);
            });
          }
          break;
        case 'clipboard':
        case 'new_clipboard':
          // New item from another device
          if (msg.item) {
            state.items.unshift(msg.item);
            if (state.currentPage === 'clipboard') renderClipboardItems();
            showToast('收到新同步内容');
          }
          break;
        case 'clipboard_deleted':
          if (msg.itemId) {
            state.items = state.items.filter(i => i.id !== msg.itemId);
          } else if (msg.itemIds) {
            state.items = state.items.filter(i => !msg.itemIds.includes(i.id));
          }
          if (state.currentPage === 'clipboard') renderClipboardItems();
          break;
        case 'clipboard_favorite':
          const item = state.items.find(i => i.id === msg.itemId);
          if (item) { item.isFavorite = msg.isFavorite; renderClipboardItems(); }
          break;
      }
    }

    function updateConnStatus(status) {
      const dot = document.getElementById('conn-dot');
      const text = document.getElementById('conn-text');
      dot.className = 'conn-dot ' + status;
      const labels = { online: '已连接', offline: '未连接', connecting: '连接中...' };
      text.textContent = labels[status] || status;
      state.wsConnected = (status === 'online');
    }

    // ====== Clipboard ======
    async function loadClipboardItems() {
      try {
        const data = await api('GET', '/api/clipboard?limit=50');
        state.items = data.items || data.clipboardItems || [];
        console.log('[Clipboard] loaded', state.items.length, 'items');
        renderClipboardItems();
      } catch (e) {
        console.error('[Clipboard] Failed to load:', e);
        // 如果是 403 limit 错误，尝试用不带 limit 参数的请求
        if ((e.message || '').includes('limit') || (e.message || '').includes('Forbidden')) {
          try {
            const fallbackData = await fetch(API_BASE + '/api/clipboard', {
              headers: state.token ? { 'Authorization': 'Bearer ' + state.token } : {}
            });
            if (fallbackData.ok) {
              const json = await fallbackData.json();
              state.items = json.items || json.clipboardItems || [];
              renderClipboardItems();
            }
          } catch (fallbackErr) { /* ignore */ }
        }
      }
    }

    async function uploadClipboard(content) {
      // Ensure we have a valid deviceId
      if (!state.deviceId) {
        state.deviceId = localStorage.getItem('cs_device_id');
      }
      if (!state.deviceId || !deviceReady || !content.trim()) {
        console.warn('[Upload] SKIPPED: deviceId=', state.deviceId, 'deviceReady=', deviceReady, 'content.len=', content?.length);
        // If no deviceId, try to register
        if (!state.deviceId && state.token) {
          console.warn('[Upload] No deviceId — attempting device registration');
          try {
            await loadDevices();
            deviceReady = true;
            if (state.deviceId) {
              console.log('[Upload] Device registered, retrying upload');
              return uploadClipboard(content);  // Retry with new deviceId
            }
          } catch (e) {
            console.error('[Upload] Registration failed:', e.message);
          }
        }
        return;
      }
      const type = detectContentType(content);
      console.log('[Upload] START', { type, size: content.length, deviceId: state.deviceId.substring(0, 12) });
      try {
        await api('POST', '/api/clipboard', {
          sourceDeviceId: state.deviceId,
          contentType: type,
          contentEncrypted: btoa(unescape(encodeURIComponent(content))), // Base64 for MVP
          contentPreview: content.length > 5000 ? content.substring(0, 5000) + '…(' + content.length + '字符)' : content,
          contentSize: content.length,
        });
        console.log('[Upload] SUCCESS');
        // Reload to get the item with proper ID
        loadClipboardItems();
        showToast('已同步到服务器');
      } catch (e) {
        console.error('[Upload] FAILED:', e.message);
        // 清晰提示用户具体原因
        if (e.message.includes('limit') || e.message.includes('Forbidden')) {
          showToast('⚠️ 剪贴板数量已达上限，请清理旧记录', 'error');
        }
        // If "Device not found", clear stale ID and re-register
        if (e.message.includes('Device not found')) {
          console.warn('[Upload] Device not found from API — re-registering');
          state.deviceId = null;
          localStorage.removeItem('cs_device_id');
          deviceReady = false;
          try {
            await loadDevices();
            deviceReady = true;
            if (state.deviceId) {
              console.log('[Upload] Re-registered, retrying upload');
              return uploadClipboard(content);
            }
          } catch (re) {
            console.error('[Upload] Re-registration failed:', re.message);
          }
        }
        showToast('同步失败：' + e.message);
      }
    }

    function detectContentType(text) {
      if (/^https?:\/\//.test(text.trim())) return 'link';
      if (/[{}\[\]];?|function |const |let |var |=>|import |class /.test(text)) return 'code';
      return 'text';
    }

    // Track collapsed category state (persists across re-renders)
    const _collapsedCategories = new Set();

    function renderClipboardItems() {
      const container = document.getElementById('content-area');
      let items = state.items;
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        items = items.filter(i =>
          (i.contentPreview || '').toLowerCase().includes(q) ||
          (i.sourceDevice?.name || '').toLowerCase().includes(q)
        );
      }
      if (items.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="icon">&#x1F4C4;</div>
            <p>${state.searchQuery ? '没有匹配的内容' : '暂无剪贴板内容'}</p>
            <p style="margin-top:8px;font-size:12px;">复制内容后将自动同步到此处 &middot; 文件可拖拽或粘贴( Ctrl+V )</p>
          </div>`;
        return;
      }

      // Group items by type
      const groups = { recent: [], file: [], image: [], text: [] };
      items.forEach(item => {
        groups.recent.push(item);
        if (item.contentType === 'file') groups.file.push(item);
        else if (item.contentType === 'image') groups.image.push(item);
        else groups.text.push(item);
      });

      const groupTitles = {
        recent: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg> 最近',
        file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg> 文件',
        image: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg> 图片 / 视频',
        text: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg> 文字'
      };

      let html = '<div class="clipboard-grid">';
      for (const [type, typeItems] of Object.entries(groups)) {
        if (typeItems.length === 0) continue;
        const catId = 'cat-' + type;
        const collapsed = _collapsedCategories.has(type);
        html += `<div class="category-header${collapsed ? ' collapsed' : ''}" onclick="toggleCategory('${type}')">
          <span class="category-chevron"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M7 10l5 5 5-5z"/></svg></span>
          ${groupTitles[type]}
          <span class="category-count">${typeItems.length}</span>
        </div>`;
        html += `<div class="category-body${collapsed ? ' collapsed' : ''}">`;
        html += typeItems.map(item => {
          const isImage = item.contentType === 'image';
          const isFile = item.contentType === 'file';
          const t = item.contentType || 'text';
          const cardClick = isImage ? `viewImageItem('${item.id}')`
                         : isFile ? `viewFileItem('${item.id}')`
                         : `copyTextItem('${item.id}')`;
          return `
          <div class="clipboard-card" onclick="${cardClick}">
            <div class="card-header">
              <div class="card-type">
                <div class="card-type-icon ${getTypeClass(t)}">${getTypeIcon(t)}</div>
                ${getTypeLabel(t)}
              </div>
              <div class="card-actions">
                <span class="card-fav ${item.isFavorite ? 'active' : ''}" onclick="event.stopPropagation();toggleFav('${item.id}')">${item.isFavorite ? '&#x2605;' : '&#x2606;'}</span>
                <button onclick="event.stopPropagation();deleteItem('${item.id}')" title="\u5220\u9664">&#xD7;</button>
              </div>
            </div>
            ${isImage
              ? `<div class="card-image-placeholder">
                  <div class="card-image-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                  </div>
                  <span class="card-image-desc">${escapeHtml(item.contentPreview || '\u56FE\u7247')}</span>
                </div>`
              : isFile
              ? `<div class="card-image-placeholder">
                  <div class="card-image-icon" style="background:linear-gradient(135deg,#FEF3C7,#FDE68A)">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="1.8"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                  </div>
                  <span class="card-image-desc">${escapeHtml(item.contentPreview || '\u6587\u4EF6')}</span>
                </div>`
              : `<div class="card-content">${escapeHtml(item.contentPreview || '(空内容)')}</div>`
            }
            <div class="card-footer">
              <div class="card-device"><svg style="width:12px;height:12px;vertical-align:-1px;margin-right:2px;opacity:.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg> ${escapeHtml(item.sourceDevice?.name || '\u672A\u77E5\u8BBE\u5907')}</div>
              <span>${formatTime(item.createdAt)}</span>
            </div>
          </div>`;
        }).join('');
        html += '</div>'; // end category-body
      }
      html += '</div>';
      container.innerHTML = html;
      // 动态添加卡片菜单按钮
      container.querySelectorAll('.clipboard-card').forEach(card => {
        const footer = card.querySelector('.card-footer');
        if (!footer || footer.querySelector('.card-menu-btn')) return;
        const rightDiv = footer.querySelector('div[style*="display:flex"]') || footer.lastElementChild;
        if (!rightDiv) return;
        const btn = document.createElement('button');
        btn.className = 'card-menu-btn';
        btn.innerHTML = '⋮';
        btn.title = '更多操作';
        btn.style.cssText = 'background:none;border:none;cursor:pointer;padding:2px 6px;font-size:15px;color:#999;border-radius:4px;margin-left:4px;';
        btn.onmouseover = () => btn.style.background = '#f0f0f0';
        btn.onmouseout = () => { if (!btn.dataset.open) btn.style.background = 'none'; };
        btn.onclick = (e) => {
          e.stopPropagation();
          toggleCardMenu(card.dataset.id, btn);
        };
        rightDiv.insertBefore(btn, rightDiv.firstChild);
      });
    }

    function toggleCategory(type) {
      if (_collapsedCategories.has(type)) _collapsedCategories.delete(type);
      else _collapsedCategories.add(type);
      renderClipboardItems();
    }

    let _rightPanelCollapsed = false;
    // Create persistent expand button (stays visible even when panel collapsed)
    let _expandBtn = null;
    function _ensureExpandBtn() {
      if (!_expandBtn) {
        _expandBtn = document.createElement('button');
        _expandBtn.className = 'panel-expand-btn';
        _expandBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9,18 15,12 9,6"/></svg>';
        _expandBtn.title = '展开面板';
        _expandBtn.onclick = toggleRightPanel;
      }
      const rp = document.getElementById('right-panel');
      if (_expandBtn.parentNode !== rp) {
        rp.appendChild(_expandBtn);
      }
    }
    function toggleRightPanel() {
      const app = document.getElementById('main-app');
      const btn = document.querySelector('.panel-toggle-btn');
      const chevronLeft = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15,18 9,12 15,6"/></svg>';
      const chevronRight = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9,18 15,12 9,6"/></svg>';
      _rightPanelCollapsed = !_rightPanelCollapsed;
      if (_rightPanelCollapsed) {
        app.classList.add('panel-collapsed');
        btn.innerHTML = chevronLeft;
        btn.title = '折叠面板';
        _ensureExpandBtn();
        _expandBtn.style.display = '';
      } else {
        app.classList.remove('panel-collapsed');
        btn.innerHTML = chevronLeft;
        btn.title = '折叠面板';
        if (_expandBtn) _expandBtn.style.display = 'none';
      }
    }

    async function copyItem(content) {
      try {
        await navigator.clipboard.writeText(content);
        state.currentClipboard = content;
        showToast('已复制到剪贴板');
      } catch (e) { showToast('复制失败'); }
    }

    // Click a text card → fetch full content and copy to clipboard
    async function copyTextItem(id) {
      try {
        const item = await api('GET', '/api/clipboard/' + id);
        let fullContent = '';
        if (item.contentEncrypted) {
          // Decode base64 contentEncrypted to get original text
          try { fullContent = decodeURIComponent(escape(atob(item.contentEncrypted))); } catch(e) { fullContent = item.contentEncrypted; }
        } else {
          fullContent = item.contentPreview || '';
        }
        await navigator.clipboard.writeText(fullContent);
        state.currentClipboard = fullContent;
        showToast('已复制到剪贴板（' + fullContent.length + '字符）');
      } catch (e) { showToast('复制失败：' + e.message); }
    }

    // ====== Image Viewer ======
    let _viewingImageUrl = null;

    async function viewImageItem(id) {
      try {
        const item = await api('GET', '/api/clipboard/' + id);
        if (item.contentType !== 'image' || !item.contentEncrypted) {
          showToast('无法查看此项目');
          return;
        }
        _viewingImageUrl = item.contentEncrypted;
        document.getElementById('viewer-image').src = item.contentEncrypted;
        document.getElementById('image-viewer').classList.remove('hidden');
      } catch (e) {
        showToast('加载失败：' + e.message);
      }
    }

    function closeImageViewer() {
      document.getElementById('image-viewer').classList.add('hidden');
      document.getElementById('viewer-image').src = '';
      _viewingImageUrl = null;
    }

    async function copyImageFromViewer() {
      if (!_viewingImageUrl) return;
      try {
        // Fetch the blob from the data URL and write to clipboard
        const resp = await fetch(_viewingImageUrl);
        const blob = await resp.blob();
        await navigator.clipboard.write([
          new ClipboardItem({ [blob.type]: blob })
        ]);
        showToast('图片已复制');
        closeImageViewer();
      } catch (e) {
        showToast('复制失败：' + e.message);
      }
    }

    // ====== File Viewer ======
    // Clicking a file card should write the file paths to the Windows clipboard
    // in CF_HDROP format, so pasting in Explorer pastes the actual files.
    async function viewFileItem(id) {
      try {
        const item = await api('GET', '/api/clipboard/' + id);
        const meta = item.metadata || {};
        const filePaths = meta.filePaths || [];

        if (filePaths.length === 0) {
          showToast('没有可用的文件路径');
          return;
        }

        // Try to write CF_HDROP via Tauri backend
        const _invoke = window.__TAURI_INVOKE__ ||
          (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) ||
          (window.__TAURI__ && window.__TAURI__.invoke);

        if (_invoke) {
          try {
            await _invoke('set_clipboard_files', { paths: filePaths });
            const label = filePaths.length === 1
              ? filePaths[0].split(/[/\\]/).pop()
              : filePaths.length + ' 个文件';
            showToast('已复制 ' + label + ' 到剪贴板，可粘贴');
          } catch (e) {
            console.error('[viewFileItem] set_clipboard_files failed:', e);
            showToast('复制失败：' + e.message);
          }
        } else {
          // Browser fallback — cannot write CF_HDROP; show file info
          showToast('文件: ' + (meta.fileName || filePaths[0].split(/[/\\]/).pop()));
        }
      } catch (e) {
        showToast('加载失败：' + e.message);
      }
    }

    async function toggleFav(id) {
      try {
        await api('PUT', `/api/clipboard/${id}/favorite`);
        loadClipboardItems();
      } catch (e) { showToast('操作失败'); }
    }

    async function deleteItem(id) {
      try {
        await api('DELETE', `/api/clipboard/${id}`);
        state.items = state.items.filter(i => i.id !== id);
        renderClipboardItems();
        showToast('已删除');
      } catch (e) { showToast('删除失败'); }
    }

    function onSearch(value) {
      state.searchQuery = value;
      const box = document.getElementById('search-box');
      if (box) box.classList.toggle('has-value', value.length > 0);
      renderClipboardItems();
    }
    function clearSearch() {
      const inp = document.getElementById('search-input');
      if (inp) { inp.value = ''; onSearch(''); inp.focus(); }
    }

    // ====== Devices ======
    async function loadDevices() {
      try {
        const devices = await api('GET', '/api/devices');
        state.devices = Array.isArray(devices) ? devices : [];

        if (state.devices.length === 0) {
          // No devices → auto-register this desktop
          const newDevice = await api('POST', '/api/devices', {
            deviceName: 'Desktop-' + navigator.platform,
            deviceType: 'desktop',
            platform: 'windows',
          });
          state.deviceId = newDevice.id;
          localStorage.setItem('cs_device_id', newDevice.id);
          state.devices = [newDevice];
          showToast('设备已注册');
        } else {
          // Devices exist → always sync deviceId with the first one from DB
          // (localStorage may be stale from a previous session)
          const firstId = state.devices[0].id;
          if (state.deviceId !== firstId) {
            console.log('[Devices] syncing deviceId:', state.deviceId, '->', firstId);
          }
          state.deviceId = firstId;
          localStorage.setItem('cs_device_id', state.deviceId);
        }

        renderDevices();

        // Register with WebSocket if connected
        if (state.ws && state.ws.readyState === 1 && state.deviceId) {
          state.ws.send(JSON.stringify({ type: 'register', deviceId: state.deviceId }));
        }
      } catch (e) {
        console.error('Failed to load devices:', e);
      }
    }

    function renderDevices() {
      const dt = (d) => d.deviceType || d.type;
      // Update sidebar device list
      const container = document.getElementById('device-list');
      document.getElementById('device-count').textContent = state.devices.length + ' 台';
      const devSvgs = {
        desktop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="1.8"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
        mobile: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="1.8"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
        tablet: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="1.8"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>'
      };
      container.innerHTML = state.devices.map(d => {
        const t = dt(d);
        return `
        <div class="device-item">
          <div class="device-icon ${getDeviceClass(t)}">${devSvgs[t] || devSvgs.desktop}</div>
          <div class="device-info">
            <div class="device-name">${escapeHtml(d.deviceName || d.name || '未知设备')}</div>
            <div class="device-status">
              <span class="status-dot ${d.isOnline ? '' : 'offline'}"></span>
              ${d.isOnline ? '在线' : (d.platform || '离线')}
            </div>
          </div>
        </div>`;
      }).join('');

      // Update main content area with device management view
      const mainArea = document.getElementById('content-area');
      if (!state.devices.length) {
        mainArea.innerHTML = '<div class="empty-state"><div class="icon">&#x1F4F1;</div><p>暂无已连接的设备</p><p style="margin-top:8px;font-size:12px;">在其他设备上登录 ClipSync 即可自动发现</p></div>';
      } else {
        mainArea.innerHTML = `
          <div class="settings-page">
            ${state.devices.map((d) => {
              const t = dt(d);
              return `
              <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg-card);border-radius:10px;margin-bottom:8px;border:1px solid var(--border-light);transition:border-color 0.12s;" onmouseenter="this.style.borderColor='var(--border)'" onmouseleave="this.style.borderColor='var(--border-light)'">
                <div class="device-icon ${getDeviceClass(t)}" style="width:40px;height:40px;border-radius:10px;">${devSvgs[t] || devSvgs.desktop}</div>
                <div style="flex:1;">
                  <div style="font-weight:600;font-size:13px;color:var(--text);">${escapeHtml(d.deviceName || d.name || '未知设备')}</div>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeHtml(d.platform || '')} &middot; ${d.isOnline ? '<span style="color:var(--success);font-weight:500;">在线</span>' : '<span>离线</span>'}</div>
                </div>
              </div>`}).join('')}
          </div>`;
      }
    }

    // ====== Pages ======
    function switchPage(page) {
      state.currentPage = page;
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
      document.querySelector(`[data-page="${page}"]`).classList.add('active');
      const titles = { clipboard: '剪贴板', devices: '设备管理', settings: '设置' };
      document.getElementById('page-title').textContent = titles[page] || page;
      if (page === 'clipboard') renderClipboardItems();
      else if (page === 'devices') renderDevices();
      else if (page === 'settings') renderSettings();
    }

    // ====== Settings ======
        function renderSettings() {
      const container = document.getElementById('content-area');
      container.innerHTML = `
        <div class="settings-page">

          <!-- Sync -->
          <div class="settings-group">
            <div class="settings-group-title">同步与监控</div>
            <div class="settings-item">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0118.8-4.3M22 12.5a10 10 0 01-18.8 4.3"/></svg>
                <div>
                  <div class="settings-item-label">自动同步</div>
                  <div class="settings-item-desc">复制内容后自动上传到云端</div>
                </div>
              </div>
              <label class="toggle"><input type="checkbox" ${state.autoSync ? 'checked' : ''} onchange="state.autoSync=this.checked"><span class="toggle-slider"></span></label>
            </div>
          </div>

          <!-- Account & Security -->
          <div class="settings-group">
            <div class="settings-group-title">账号与安全</div>
            <div class="settings-item" onclick="showProfileModal()">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <div>
                  <div class="settings-item-label">个人资料</div>
                  <div class="settings-item-desc">编辑用户名、头像、邮箱</div>
                </div>
              </div>
              <span class="settings-arrow">编辑 ›</span>
            </div>
            <div class="settings-item" onclick="showSessionManagement()">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                <div>
                  <div class="settings-item-label">登录会话</div>
                  <div class="settings-item-desc">管理已登录的设备，可踢出异常设备</div>
                </div>
              </div>
              <span class="settings-arrow">管理 ›</span>
            </div>
            <div class="settings-item" onclick="showSecuritySettings()">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <div>
                  <div class="settings-item-label">隐私与安全</div>
                  <div class="settings-item-desc">两步验证、登录提醒、端到端加密</div>
                </div>
              </div>
              <span class="settings-arrow">设置 ›</span>
            </div>
          </div>

          <!-- Subscription -->
          <div class="settings-group" id="subscription-settings-group">
            <div class="settings-group-title">订阅管理</div>
            <div class="settings-item" onclick="showSubscriptionPlans()">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                <div>
                  <div class="settings-item-label">当前套餐</div>
                  <div class="settings-item-desc" id="settings-current-plan">加载中...</div>
                </div>
              </div>
              <span class="settings-arrow" id="plan-upgrade-btn">升级 ›</span>
            </div>
            <div class="settings-item" onclick="showBillingHistory()">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <div>
                  <div class="settings-item-label">账单记录</div>
                  <div class="settings-item-desc">订单历史、支付凭证、发票下载</div>
                </div>
              </div>
              <span class="settings-arrow">查看 ›</span>
            </div>
          </div>

          <!-- Preferences -->
          <div class="settings-group">
            <div class="settings-group-title">偏好设置</div>
            <div class="settings-item" onclick="showNotifSettings()">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
                <div>
                  <div class="settings-item-label">通知偏好</div>
                  <div class="settings-item-desc">选择接收哪些通知提醒</div>
                </div>
              </div>
              <span class="settings-arrow">设置 ›</span>
            </div>
            <div class="settings-item" onclick="checkForUpdates()">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <div>
                  <div class="settings-item-label">检查更新</div>
                  <div class="settings-item-desc">当前版本 v0.1.0 · 检查是否有新版本</div>
                </div>
              </div>
              <span class="settings-arrow">检查 ›</span>
            </div>
            <div class="settings-item" onclick="showGDPRExport()">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                <div>
                  <div class="settings-item-label">数据导出 (GDPR)</div>
                  <div class="settings-item-desc">导出你的所有个人数据副本</div>
                </div>
              </div>
              <span class="settings-arrow">导出 ›</span>
            </div>
          </div>

          <!-- About -->
          <div class="settings-group">
            <div class="settings-group-title">关于</div>
            <div class="settings-item" style="cursor:default;">
              <div class="settings-item-left">
                <svg class="settings-item-icon-svg" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <div>
                  <div class="settings-item-label">ClipSync</div>
                  <div class="settings-item-desc">版本 0.1.0 (MVP) · 跨设备剪贴板同步工具</div>
                </div>
              </div>
            </div>
          </div>

        `        `;
    }

    // ====== Helpers ======
    function getTypeIcon(type) {
      const icons = {
        text: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>',
        link: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
        image: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
        code: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="16,18 22,12 16,6"/><polyline points="8,6 2,12 8,18"/></svg>',
        file: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>'
      };
      return icons[type] || '?';
    }
    function getTypeLabel(type) {
      return { text: '文本', link: '链接', image: '图片', code: '代码', file: '文件' }[type] || type;
    }
    function getTypeClass(type) {
      return { text: 'type-text', link: 'type-link', image: 'type-image', code: 'type-code', file: 'type-file' }[type] || 'type-text';
    }
    function getDeviceIcon(type) {
      const map = { desktop: '&#x1F4BB;', mobile: '&#x1F4F1;', tablet: '&#x1F4FA;' };
      return map[type] || '&#x1F4BB;';
    }
    function getDeviceClass(type) {
      return { desktop: 'dev-desktop', mobile: 'dev-mobile', tablet: 'dev-tablet' }[type] || 'dev-desktop';
    }
    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
    function escapeAttr(t) { return t.replace(/'/g, "\\'").replace(/\n/g, '\\n'); }
    function formatTime(iso) {
      if (!iso) return '';
      const diff = Date.now() - new Date(iso).getTime();
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
      return new Date(iso).toLocaleDateString();
    }
    function showToast(msg) {
      const old = document.querySelector('.toast');
      if (old) old.remove();
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2500);
    }
    // ====== 快速粘贴面板 (Ctrl+Shift+V) ======
    // 挂到 window 上，让 Rust 的 window.eval() 能找到这些函数
    window._quickPasteOpen = false;
    window.toggleQuickPaste = function() {
      console.log('[QuickPaste] toggle called, current state:', window._quickPasteOpen);
      if (window._quickPasteOpen) { window.hideQuickPaste(); return; }
      window.showQuickPaste();
    };
    window.showQuickPaste = function() {
      const panel = document.getElementById('quick-paste-panel');
      if (!panel) return;
      window._quickPasteOpen = true;
      panel.classList.add('open');
      window.loadQuickPasteItems();
      setTimeout(() => {
        const inp = document.getElementById('quick-paste-search');
        if (inp) inp.focus();
      }, 100);
    };

    window.hideQuickPaste = function() {
      const panel = document.getElementById('quick-paste-panel');
      if (panel) panel.classList.remove('open');
      window._quickPasteOpen = false;
    };
    window.loadQuickPasteItems = async function(filter) {
      try {
        const items = await api('GET', '/api/clipboard?limit=50');
        window.renderQuickPasteItems(items, filter || '');
      } catch (e) { console.error('[QuickPaste] load failed:', e); }
    };
    window.renderQuickPasteItems = function(items, filter) {
      const list = document.getElementById('quick-paste-list');
      if (!list) return;
      let filtered = items;
      if (filter) {
        const f = filter.toLowerCase();
        filtered = items.filter(it =>
          (it.contentPreview || '').toLowerCase().includes(f) ||
          (it.contentType || '').toLowerCase().includes(f)
        );
      }
      if (filtered.length === 0) {
        list.innerHTML = '<div class="qp-empty">暂无剪贴板记录</div>';
        return;
      }
      list.innerHTML = filtered.map((item, i) => {
        const icon = getTypeIcon(item.contentType);
        const label = getTypeLabel(item.contentType);
        const preview = (item.contentPreview || '').substring(0, 120);
        const time = formatTime(item.createdAt);
        return `<div class="qp-item${i === 0 ? ' active' : ''}" data-id="${item.id}" data-type="${item.contentType}" onclick="quickPasteSelect(this, '${item.id}', '${item.contentType}')">
          <div class="qp-item-icon ${getTypeClass(item.contentType)}">${icon}</div>
          <div class="qp-item-body">
            <div class="qp-item-label">${label}</div>
            <div class="qp-item-preview">${escapeHtml(preview)}</div>
            <div class="qp-item-time">${time}</div>
          </div>
        </div>`;
      }).join('');
      // 键盘导航
      window._qpIndex = 0;
    }
    window._qpIndex = 0;
    window.updateQPActive = function() {
      const items = document.querySelectorAll('#quick-paste-list .qp-item');
      items.forEach((el, i) => el.classList.toggle('active', i === window._qpIndex));
      const active = items[window._qpIndex];
      if (active) active.scrollIntoView({ block: 'nearest' });
    };
    window.quickPasteSelect = async function(el, id, type) {
      // 写入剪贴板并隐藏面板
      try {
        if (type === 'file') {
          const item = await api('GET', '/api/clipboard/' + id);
          if (item.metadata && item.metadata.filePaths && window.__TAURI_INVOKE__) {
            const { invoke } = window.__TAURI_INVOKE__ ? { invoke: window.__TAURI_INVOKE__ } : {};
            // 通过 Tauri 命令写入 CF_HDROP
            if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
              await window.__TAURI__.core.invoke('set_clipboard_files', { paths: item.metadata.filePaths });
            } else if (window.__TAURI_INVOKE__) {
              await window.__TAURI_INVOKE__( 'set_clipboard_files', { paths: item.metadata.filePaths });
            }
          }
        } else if (type === 'image') {
          // 图片：复制 base64 到剪贴板
          const item = await api('GET', '/api/clipboard/' + id);
          if (item.contentEncrypted && item.contentEncrypted.startsWith('data:')) {
            const blob = await (await fetch(item.contentEncrypted)).blob();
            await navigator.clipboard.write([
              new ClipboardItem({ 'image/png': blob })
            ]);
          }
        } else {
          // 文字：解码并写入
          const item = await api('GET', '/api/clipboard/' + id);
          let text = '';
          try { text = decodeURIComponent(escape(atob(item.contentEncrypted))); } catch(e) { text = item.contentPreview || ''; }
          await navigator.clipboard.writeText(text);
        }
        showToast('已复制，可粘贴');
      } catch (e) {
        showToast('复制失败: ' + e.message);
      }
      hideQuickPaste();
    }

    // ESC 关闭面板
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && window._quickPasteOpen) { window.hideQuickPaste(); return; }
      if (window._quickPasteOpen) {
        if (e.key === 'ArrowDown') { e.preventDefault(); window._qpIndex = Math.min(window._qpIndex + 1, document.querySelectorAll('#quick-paste-list .qp-item').length - 1); window.updateQPActive(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); window._qpIndex = Math.max(window._qpIndex - 1, 0); window.updateQPActive(); }
        if (e.key === 'Enter') { e.preventDefault(); const active = document.querySelector('#quick-paste-list .qp-item.active'); if (active) active.click(); }
      }
    });

    // 搜索过滤
    window._qpSearchTimer = null;
    window.onQuickPasteSearch = function(e) {
      clearTimeout(window._qpSearchTimer);
      window._qpSearchTimer = setTimeout(() => window.loadQuickPasteItems(e.target.value), 200);
    };

    // ====== Onboarding ======
    (function() {
      window._obPage = 1;
      const TOTAL = 4;

      function renderDots() {
        const dots = document.getElementById('onboarding-dots');
        if (!dots) return;
        dots.innerHTML = Array.from({length: TOTAL}, (_, i) =>
          '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;transition:all 0.2s;' +
          (i + 1 === window._obPage ? 'background:#667eea;transform:scale(1.3);' : 'background:#ddd;') +
          '"></span>'
        ).join('');
      }

      function renderPage() {
        for (let i = 1; i <= TOTAL; i++) {
          const el = document.getElementById('ob-page-' + i);
          if (el) el.style.display = (i === window._obPage) ? '' : 'none';
        }
        const prevBtn = document.getElementById('ob-prev-btn');
        const nextBtn = document.getElementById('ob-next-btn');
        const startBtn = document.getElementById('ob-start-btn');
        if (prevBtn) prevBtn.style.display = window._obPage > 1 ? '' : 'none';
        if (nextBtn) nextBtn.style.display = window._obPage < TOTAL ? '' : 'none';
        if (startBtn) startBtn.style.display = window._obPage === TOTAL ? '' : 'none';
        renderDots();
      }

      window.obNext = function() {
        if (window._obPage < TOTAL) { window._obPage++; renderPage(); }
      };
      window.obPrev = function() {
        if (window._obPage > 1) { window._obPage--; renderPage(); }
      };
      window.skipOnboarding = function() {
        localStorage.setItem('onboarding_done', 'true');
        document.getElementById('onboarding-overlay').style.display = 'none';
      };
      window.finishOnboarding = function() {
        localStorage.setItem('onboarding_done', 'true');
        document.getElementById('onboarding-overlay').style.display = 'none';
      };

      // Show onboarding on first launch
      document.addEventListener('DOMContentLoaded', function() {
        const done = localStorage.getItem('onboarding_done');
        if (!done) {
          document.getElementById('onboarding-overlay').style.display = 'flex';
          renderPage();
        }
      });
    })();

    // 点击面板外部关闭
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('quick-paste-panel');
      if (window._quickPasteOpen && panel && !panel.contains(e.target)) window.hideQuickPaste();
    });

    // ====== 订阅管理 ======
    async function loadSubscriptionInfo() {
      if (!state.token) return;
      try {
        const data = await api('GET', '/api/subscriptions/current', false); // silent: don't log 500 errors
        const el = document.getElementById('settings-current-plan');
        if (el) {
          if (data && data.plan) {
            el.textContent = `${data.plan.name} · ¥${data.plan.price}/${data.plan.billingCycle === 'month' ? '月' : '年'}`;
          } else {
            el.textContent = '免费版（Free）';
          }
        }
      } catch (e) {
        const el = document.getElementById('settings-current-plan');
        if (el) el.textContent = '免费版（Free）';
      }
    }

    async function showSubscriptionPlans() {
      if (!state.token) { showToast('请先登录'); return; }
      document.getElementById('subscription-modal').style.display = 'flex';
      const listEl = document.getElementById('plans-list');
      listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">加载中...</div>';
      try {
        const data = await api('GET', '/api/subscriptions/plans');
        const plans = data.plans || [];
        listEl.innerHTML = plans.map(p => `
          <div class="plan-card" style="border:2px solid ${p.price > 0 ? '#667eea' : '#e5e7eb'};border-radius:12px;padding:20px;cursor:pointer;transition:all 0.15s;"
               onmouseover="this.style.box-shadow='0 4px 16px rgba(102,126,234,0.18)'"
               onmouseout="this.style.box-shadow='none'"
               onclick="selectPlan(${p.id},'${p.name.replace(/'/g, "\\'")}',${p.price})">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <div style="font-size:18px;font-weight:700;color:#1a1a2e;">${p.name}</div>
              <div style="font-size:22px;font-weight:800;color:#667eea;">¥${p.price}<span style="font-size:13px;font-weight:500;color:#999;">/${p.billingCycle === 'month' ? '月' : '年'}</span></div>
            </div>
            <div style="font-size:12px;color:#666;margin-bottom:12px;">${p.maxDevices} 台设备 · ${p.maxClipboardItems} 条记录 · ${p.maxStorageMb}MB 存储</div>
            <ul style="list-style:none;padding:0;margin:0;font-size:13px;color:#444;">
              ${(p.features || []).map(f => `<li style="padding:3px 0;">✅ ${f}</li>`).join('')}
            </ul>
          </div>
        `).join('');
      } catch (e) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;">加载失败，请重试</div>';
      }
    }

    function closeSubscriptionModal() {
      document.getElementById('subscription-modal').style.display = 'none';
    }

    async function selectPlan(planId, planName, price) {
      if (price === 0) {
        showToast('已是免费版');
        closeSubscriptionModal();
        return;
      }
      if (!confirm(`确认订阅「${planName}」？\n价格：¥${price}/月\n\n将在浏览器中完成支付，完成后请返回本应用。`)) return;
      try {
        const data = await api('POST', '/api/payments/create', { planId, paymentMethod: 'wechat' });
        if (data && data.paymentUrl) {
          // 用系统浏览器打开支付链接
          window.open(data.paymentUrl, '_blank');
          showToast('支付页面已打开，完成后会自动同步');
        } else {
          showToast('创建支付订单失败');
        }
      } catch (e) {
        showToast('创建支付订单失败：' + (e.message || '未知错误'));
      }
      closeSubscriptionModal();
    }

    async function showBillingHistory() {
      if (!state.token) { showToast('请先登录'); return; }
      document.getElementById('billing-modal').style.display = 'flex';
      const listEl = document.getElementById('billing-list');
      listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">加载中...</div>';
      try {
        const data = await api('GET', '/api/payments/history');
        const bills = data.bills || [];
        if (bills.length === 0) {
          listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">暂无账单记录</div>';
        } else {
          listEl.innerHTML = bills.map(b => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #f0f0f0;">
              <div>
                <div style="font-size:14px;font-weight:600;color:#1a1a2e;">${b.planName || '未知套餐'}</div>
                <div style="font-size:12px;color:#999;margin-top:2px;">${new Date(b.createdAt).toLocaleString()}</div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:15px;font-weight:700;color:#1a1a2e;">¥${b.amount}</div>
                <div style="font-size:11px;color:${b.status === 'paid' ? '#059669' : b.status === 'pending' ? '#d97706' : '#e74c3c'};margin-top:2px;">
                  ${b.status === 'paid' ? '已支付' : b.status === 'pending' ? '待支付' : '已取消'}
                </div>
              </div>
            </div>
          `).join('');
        }
      } catch (e) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;">加载失败，请重试</div>';
      }
    }

    function closeBillingModal() {
      document.getElementById('billing-modal').style.display = 'none';
    }

    // 修改 renderSettings 加载订阅信息
    const _origRenderSettings = window.renderSettings;
    window.renderSettings = function() {
      if (_origRenderSettings) _origRenderSettings();
      loadSubscriptionInfo();
    };

    // 支付结果轮询（从浏览器返回时检查）
    let _paymentCheckTimer = null;
    window.addEventListener('focus', () => {
      if (state.token && _paymentCheckTimer === null) {
        _paymentCheckTimer = setTimeout(async () => {
          _paymentCheckTimer = null;
          try {
            const data = await api('GET', '/api/subscriptions/current', null, true);
            if (data && data.subscription && data.subscription.status === 'active') {
              showToast('✅ 支付成功！订阅已激活：' + (data.plan?.name || ''));
              loadSubscriptionInfo();
            }
          } catch (e) {}
        }, 1000);
      }
    });

    // ====== 文件上传 ======
    window.uploadFile = async function(input) {
      const files = input.files;
      if (!files || files.length === 0) return;
      for (const file of files) {
        showToast('正在上传：' + file.name);
        try {
          const chunkSize = 1024 * 1024; // 1MB
          const totalChunks = Math.ceil(file.size / chunkSize);
          let uploadId = null;
          for (let i = 0; i < totalChunks; i++) {
            const chunk = file.slice(i * chunkSize, (i + 1) * chunkSize);
            const form = new FormData();
            if (uploadId) form.append('uploadId', uploadId);
            form.append('chunkIndex', i);
            form.append('totalChunks', totalChunks);
            form.append('chunk', chunk, file.name + '.part' + i);
            const headers = state.token ? { 'Authorization': 'Bearer ' + state.token } : {};
            const resp = await fetch(API_URL + '/api/media/upload-chunked', {
              method: 'POST',
              headers,
              body: form
            });
            const data = await resp.json();
            if (i === totalChunks - 1) {
              uploadId = data.uploadId;
              // 完成上传
              await api('POST', '/api/media/complete-upload', { uploadId });
              showToast('✅ 上传完成：' + file.name);
            } else {
              uploadId = data.uploadId;
            }
          }
        } catch(e) {
          showToast('上传失败：' + file.name);
        }
      }
      input.value = '';
      loadClipboardItems();
    };

    // ====== 通知设置 ======
    window.showNotifSettings = async function() {
      document.getElementById('notif-settings-modal').style.display = 'flex';
      const listEl = document.getElementById('notif-settings-list');
      listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">加载中...</div>';
      try {
        const data = await api('GET', '/api/notifications/settings');
        const s = data.settings || {};
        const keys = ['新设备登录','剪贴板同步','订阅到期','安全警告'];
        listEl.innerHTML = keys.map(k => {
          const on = s[k] !== false;
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;">' +
            '<span style="font-size:13px;color:#333;">' + k + '</span>' +
            '<label class="toggle"><input type="checkbox" ' + (on ? 'checked' : '') + ' onchange="toggleNotifSetting(\'' + k + '\',this.checked)"><span class="toggle-slider"></span></label>' +
          '</div>';
        }).join('');
      } catch(e) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;">加载失败</div>';
      }
    };

    window.toggleNotifSetting = async function(key, val) {
      try { await api('PUT', '/api/notifications/settings', { key, enabled: val }); } catch(e) {}
    };

    window.closeNotifSettingsModal = function() {
      document.getElementById('notif-settings-modal').style.display = 'none';
    };

    // ====== 会话管理 ======
    window.showSessionManagement = async function() {
      document.getElementById('session-modal').style.display = 'flex';
      const listEl = document.getElementById('session-list');
      listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">加载中...</div>';
      try {
        const data = await api('GET', '/api/sessions');
        const sessions = data.sessions || [];
        if (sessions.length === 0) {
          listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">暂无会话</div>';
        } else {
          listEl.innerHTML = sessions.map(s => {
            const isCurrent = s.id === state.sessionId;
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #f0f0f0;">' +
              '<div>' +
                '<div style="font-size:13px;font-weight:600;color:#333;">' + (s.deviceName || '未知设备') + (isCurrent ? ' (当前)' : '') + '</div>' +
                '<div style="font-size:11px;color:#999;margin-top:2px;">' + (s.ip || '') + ' · ' + new Date(s.lastActive).toLocaleString() + '</div>' +
              '</div>' +
              (isCurrent ? '<span style="font-size:12px;color:#999;">当前</span>' : '<button class="btn btn-secondary" style="padding:4px 12px;font-size:12px;color:#e74c3c;border-color:#e74c3c;" onclick="kickSession(" + s.id + ")">踢出</button>') +
            '</div>';
          }).join('');
        }
      } catch(e) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;">加载失败</div>';
      }
    };

    window.kickSession = async function(sessionId) {
      if (!confirm('确认踢出该会话？')) return;
      try {
        await api('DELETE', '/api/sessions/' + sessionId);
        showToast('✅ 已踢出');
        showSessionManagement();
      } catch(e) {
        showToast('操作失败：' + (e.message || '未知错误'));
      }
    };

    window.closeSessionModal = function() {
      document.getElementById('session-modal').style.display = 'none';
    };


    // ====== 通知设置 ======
    window.showNotifSettings = async function() {
      document.getElementById('notif-settings-modal').style.display = 'flex';
      const listEl = document.getElementById('notif-settings-list');
      listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">加载中...</div>';
      try {
        const data = await api('GET', '/api/notifications/settings');
        const s = data.settings || {};
        const keys = ['新设备登录','剪贴板同步','订阅到期','安全警告'];
        listEl.innerHTML = keys.map(k => {
          const on = s[k] !== false;
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f0f0f0;">' +
            '<span style="font-size:13px;color:#333;">' + k + '</span>' +
            '<label class="toggle"><input type="checkbox" ' + (on ? 'checked' : '') + ' onchange="toggleNotifSetting(\'' + k + '\',this.checked)"><span class="toggle-slider"></span></label>' +
          '</div>';
        }).join('');
      } catch(e) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;">加载失败</div>';
      }
    };

    window.toggleNotifSetting = async function(key, val) {
      try { await api('PUT', '/api/notifications/settings', { key, enabled: val }); } catch(e) {}
    };

    window.closeNotifSettingsModal = function() {
      document.getElementById('notif-settings-modal').style.display = 'none';
    };

    // ====== 会话管理 ======
    window.showSessionManagement = async function() {
      document.getElementById('session-modal').style.display = 'flex';
      const listEl = document.getElementById('session-list');
      listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">加载中...</div>';
      try {
        const data = await api('GET', '/api/sessions');
        const sessions = data.sessions || [];
        if (sessions.length === 0) {
          listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">暂无会话</div>';
        } else {
          listEl.innerHTML = sessions.map(s => {
            const isCurrent = s.id === state.sessionId;
            return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #f0f0f0;">' +
              '<div>' +
                '<div style="font-size:13px;font-weight:600;color:#333;">' + (s.deviceName || '未知设备') + (isCurrent ? ' (当前)' : '') + '</div>' +
                '<div style="font-size:11px;color:#999;margin-top:2px;">' + (s.ip || '') + ' · ' + new Date(s.lastActive).toLocaleString() + '</div>' +
              '</div>' +
              (isCurrent ? '<span style="font-size:12px;color:#999;">当前</span>' : '<button class="btn btn-secondary" style="padding:4px 12px;font-size:12px;color:#e74c3c;border-color:#e74c3c;" onclick="kickSession(" + s.id + ")">踢出</button>') +
            '</div>';
          }).join('');
        }
      } catch(e) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;">加载失败</div>';
      }
    };

    window.kickSession = async function(sessionId) {
      if (!confirm('确认踢出该会话？')) return;
      try {
        await api('DELETE', '/api/sessions/' + sessionId);
        showToast('✅ 已踢出');
        showSessionManagement();
      } catch(e) {
        showToast('操作失败：' + (e.message || '未知错误'));
      }
    };

    window.closeSessionModal = function() {
      document.getElementById('session-modal').style.display = 'none';
    };


    // ====== 个人资料编辑 ======
    window.showProfileModal = async function() {
      document.getElementById('profile-modal').style.display = 'flex';
      if (state.user) {
        const el1 = document.getElementById('profile-username');
        const el2 = document.getElementById('profile-email');
        if (el1) el1.value = state.user.username || '';
        if (el2) el2.value = state.user.email || '';
      }
    };
    window.closeProfileModal = function() {
      document.getElementById('profile-modal').style.display = 'none';
    };
    window.saveProfile = async function() {
      const username = document.getElementById('profile-username').value;
      const email = document.getElementById('profile-email').value;
      if (!username) { showToast('请输入用户名'); return; }
      try {
        await api('PUT', '/api/user/profile', { username, email });
        showToast('✅ 个人资料已更新');
        closeProfileModal();
      } catch(e) {
        showToast('更新失败：' + (e.message || '未知错误'));
      }
    };

    // ====== GDPR 数据导出 ======
    window.showGDPRExport = function() {
      document.getElementById('gdpr-modal').style.display = 'flex';
    };
    window.closeGDPRModal = function() {
      document.getElementById('gdpr-modal').style.display = 'none';
    };
    window.exportGDPRData = async function() {
      const status = document.getElementById('gdpr-status');
      if (status) status.textContent = '正在导出数据...';
      try {
        const data = await api('POST', '/api/gdpr/export');
        const downloadUrl = data && data.url;
        if (downloadUrl) {
          if (status) status.innerHTML = '✅ 导出完成！<br><a href="' + downloadUrl + '" target="_blank" style="color:#667eea;">点击下载</a>';
          showToast('✅ 数据导出完成');
        } else {
          if (status) status.textContent = '✅ 导出完成！数据已准备就绪';
          showToast('✅ 数据导出完成，请查看邮箱');
        }
      } catch(e) {
        if (status) status.textContent = '❌ 导出失败：' + (e.message || '未知错误');
        showToast('导出失败：' + (e.message || '未知错误'));
      }
    };

    // ====== 隐私与安全设置 ======
    window.showSecuritySettings = async function() {
      document.getElementById('security-modal').style.display = 'flex';
      const listEl = document.getElementById('security-settings-list');
      listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#999;">加载中...</div>';
      try {
        const data = await api('GET', '/api/user/security-settings');
        const s = data.settings || {};
        const items = [
          { key: 'twoFactorAuth', label: '两步验证（2FA）', desc: '增加登录安全性' },
          { key: 'loginAlerts', label: '登录提醒', desc: '新设备登录时发送通知' },
          { key: 'encryptSync', label: '端到端加密同步', desc: '剪贴板内容加密传输' }
        ];
        listEl.innerHTML = items.map(item => {
          const on = s[item.key] !== false;
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #f0f0f0;">' +
            '<div><div style="font-size:13px;font-weight:600;color:#333;">' + item.label + '</div><div style="font-size:11px;color:#999;margin-top:2px;">' + item.desc + '</div></div>' +
            '<label class="toggle"><input type="checkbox" ' + (on ? 'checked' : '') + ' onchange="toggleSecuritySetting(\'' + item.key + '\',this.checked)"><span class="toggle-slider"></span></label>' +
          '</div>';
        }).join('');
      } catch(e) {
        listEl.innerHTML = '<div style="text-align:center;padding:20px;color:#e74c3c;">加载失败</div>';
      }
    };
    window.toggleSecuritySetting = async function(key, val) {
      try { await api('PUT', '/api/user/security-settings', { key, enabled: val }); } catch(e) {}
    };
    window.closeSecurityModal = function() {
      document.getElementById('security-modal').style.display = 'none';
    };

    // ====== 检查更新 ======
    window.checkForUpdates = async function() {
      showToast('正在检查更新...');
      try {
        const data = await api('GET', '/api/updates/check');
        if (data && data.hasUpdate) {
          showToast('有新版本可用：' + (data.latestVersion || '') + '，请访问官网下载');
          if (data.downloadUrl && confirm('新版本 ' + data.latestVersion + ' 可用，是否前往下载？')) {
            window.open(data.downloadUrl, '_blank');
          }
        } else {
          showToast('✅ 当前已是最新版本（' + (data.currentVersion || '0.1.0') + '）');
        }
      } catch(e) {
        showToast('检查更新失败：' + (e.message || '未知错误'));
      }
    };

  