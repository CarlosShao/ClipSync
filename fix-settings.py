import re

file_path = r'D:\work\java\AI-workspace\ClipSync\src\desktop\src\index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# New renderSettings function with all P1 features
new_renderSettings = '''
    function renderSettings() {
      const container = document.getElementById('content-area');
      container.innerHTML = `
        <div class="settings-page">
          <!-- 同步与监控 -->
          <div class="settings-group">
            <div class="settings-group-title">同步与监控</div>
            <div class="settings-item">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0118.8-4.3M22 12.5a10 10 0 01-18.8 4.3"/></svg>
                <div>
                  <div class="settings-item-label">自动同步</div>
                  <div class="settings-item-desc">复制内容后自动上传到服务器</div>
                </div>
              </div>
              <label class="toggle"><input type="checkbox" ${state.autoSync ? 'checked' : ''} onchange="state.autoSync=this.checked"><span class="toggle-slider"></span></label>
            </div>
          </div>

          <!-- 账号与安全 -->
          <div class="settings-group">
            <div class="settings-group-title">账号与安全</div>
            <div class="settings-item" onclick="showSessionManagement()">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M12 2a10 10 0 0110 10M12 2a10 10 0 00-10 10M12 2v10"/><circle cx="12" cy="12" r="3"/></svg>
                <div>
                  <div class="settings-item-label">登录会话</div>
                  <div class="settings-item-desc">管理已登录设备</div>
                </div>
              </div>
              <span style="color:#6366f1;font-size:20px;">›</span>
            </div>
            <div class="settings-item" onclick="showSecuritySettings()">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                <div>
                  <div class="settings-item-label">隐私与安全</div>
                  <div class="settings-item-desc">两步验证、加密设置</div>
                </div>
              </div>
              <span style="color:#6366f1;font-size:20px;">›</span>
            </div>
          </div>

          <!-- 订阅管理 -->
          <div class="settings-group">
            <div class="settings-group-title">订阅管理</div>
            <div class="settings-item" onclick="showSubscriptionPlans()">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                <div>
                  <div class="settings-item-label">当前套餐</div>
                  <div class="settings-item-desc" id="settings-current-plan">免费版 (Free)</div>
                </div>
              </div>
              <span style="color:#6366f1;font-size:20px;">›</span>
            </div>
            <div class="settings-item" onclick="showBillingHistory()">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="9" x2="22" y2="9"/></svg>
                <div>
                  <div class="settings-item-label">账单记录</div>
                  <div class="settings-item-desc">查看历史账单</div>
                </div>
              </div>
              <span style="color:#6366f1;font-size:20px;">›</span>
            </div>
          </div>

          <!-- 偏好设置 -->
          <div class="settings-group">
            <div class="settings-group-title">偏好设置</div>
            <div class="settings-item" onclick="showNotifSettings()">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>
                <div>
                  <div class="settings-item-label">通知偏好</div>
                  <div class="settings-item-desc">配置通知类型</div>
                </div>
              </div>
              <span style="color:#6366f1;font-size:20px;">›</span>
            </div>
            <div class="settings-item" onclick="checkForUpdates()">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
                <div>
                  <div class="settings-item-label">检查更新</div>
                  <div class="settings-item-desc">当前版本 0.1.0</div>
                </div>
              </div>
              <span style="color:#6366f1;font-size:20px;">›</span>
            </div>
            <div class="settings-item" onclick="showGDPRExport()">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                <div>
                  <div class="settings-item-label">数据导出</div>
                  <div class="settings-item-desc">导出个人数据 (GDPR)</div>
                </div>
              </div>
              <span style="color:#6366f1;font-size:20px;">›</span>
            </div>
          </div>

          <!-- 个人资料 -->
          <div class="settings-group">
            <div class="settings-group-title">个人资料</div>
            <div class="settings-item" onclick="showProfileModal()">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <div>
                  <div class="settings-item-label">个人资料</div>
                  <div class="settings-item-desc">修改用户名、邮箱</div>
                </div>
              </div>
              <span style="color:#6366f1;font-size:20px;">›</span>
            </div>
          </div>

          <!-- 关于 -->
          <div class="settings-group">
            <div class="settings-group-title">关于</div>
            <div class="settings-item">
              <div class="settings-item-left">
                <svg style="width:20px;height:20px;margin-right:12px;flex-shrink:0;" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <div>
                  <div class="settings-item-label">ClipSync</div>
                  <div class="settings-item-desc">版本 0.1.0 (MVP) · 跨设备剪贴板同步</div>
                </div>
              </div>
            </div>
          </div>
        </div>`;
    }
'''

# Find and replace the renderSettings function
# Use regex to match the entire function
pattern = r'    function renderSettings\(\) \{[^}]*\}'
match = re.search(pattern, content, re.DOTALL)
if match:
    content = content[:match.start()] + new_renderSettings + content[match.end():]
    print('✅ renderSettings() updated successfully')
else:
    print('❌ Could not find renderSettings() function')

# Write back
with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)
