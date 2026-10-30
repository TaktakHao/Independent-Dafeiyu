/**
 * @file app.js
 * 🐋 CyberFish Daughter — 深海赛博玻璃舱前端交互与全链路状态同步引擎
 */

let currentAppMode = 'companion'
let activeWorkspaceTab = 'command'

/**
 * 悬浮毛玻璃 Toast 通知（彻底替代阻塞式 window.alert）
 */
function showToast(message, type = 'info', durationMs = 3500) {
  const container = document.getElementById('toastContainer')
  if (!container) return

  const toast = document.createElement('div')
  const typeClass =
    type === 'success'
      ? 'toast-success'
      : type === 'error'
      ? 'toast-error'
      : type === 'warn'
      ? 'toast-warn'
      : ''
  toast.className = 'glass-toast ' + typeClass
  toast.innerText = String(message || '')
  container.appendChild(toast)

  setTimeout(() => {
    toast.style.opacity = '0'
    toast.style.transition = 'opacity 0.25s ease'
    setTimeout(() => toast.remove(), 260)
  }, durationMs)
}

/**
 * HTML 安全转义
 */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 切换左侧工作区标签页
 */
function switchTab(tabId) {
  activeWorkspaceTab = tabId || 'command'
  const navItems = document.querySelectorAll('.nav-item')
  navItems.forEach((btn) => {
    if (btn.getAttribute('data-tab') === activeWorkspaceTab) {
      btn.classList.add('active')
    } else {
      btn.classList.remove('active')
    }
  })

  const panes = document.querySelectorAll('.tab-pane')
  panes.forEach((pane) => {
    if (pane.id === 'pane-' + activeWorkspaceTab) {
      pane.classList.add('active')
    } else {
      pane.classList.remove('active')
    }
  })

  if (activeWorkspaceTab === 'memory') {
    refreshMemories()
    refreshContacts()
  } else if (activeWorkspaceTab === 'security') {
    loadOneBotStatus()
    refreshApprovals()
  } else if (activeWorkspaceTab === 'brain') {
    refreshBrainStatus()
  }
}

/**
 * 更新全局三态模式 UI
 */
function updateModeUI(mode) {
  currentAppMode = mode || 'companion'
  const badge = document.getElementById('modeBadge')
  const banner = document.getElementById('workModeBanner')
  const input = document.getElementById('chatInput')
  const sendBtn = document.getElementById('sendBtn')
  const tabComp = document.getElementById('tabCompanionBtn')
  const tabWork = document.getElementById('tabWorkBtn')
  const tabLive = document.getElementById('tabLiveBtn')

  if (badge) {
    if (currentAppMode === 'live') {
      badge.className = 'badge badge-warn'
      badge.innerText = '🔴 直播模式 (操控已物理锁定)'
    } else if (currentAppMode === 'work') {
      badge.className = 'badge badge-purple'
      badge.innerText = '🛠️ 工作模式 (专职执行任务)'
    } else {
      badge.className = 'badge'
      badge.innerText = '🟢 陪伴模式 (闲聊 + 认知加深)'
    }
  }

  if (banner) {
    banner.style.display = currentAppMode === 'work' ? 'block' : 'none'
  }

  if (input) {
    if (currentAppMode === 'work') {
      input.placeholder =
        '🛠️ [工作模式] 直接输入你要执行的任务、代码排查、终端命令或搜索需求...（按 ⌘ Cmd+Enter 或点右侧按钮执行）'
    } else {
      input.placeholder =
        '💬 [陪伴模式] 跟大肥鱼聊聊天、分享你的喜好，或让她帮忙...（直接按 Enter 换行防误触，按 ⌘ Cmd+Enter 发送）'
    }
  }

  if (sendBtn) {
    sendBtn.innerText = currentAppMode === 'work' ? '⚡ 立即执行任务' : '🚀 发送消息'
    sendBtn.className = currentAppMode === 'work' ? 'btn btn-purple' : 'btn btn-primary'
  }

  if (tabComp && tabWork && tabLive) {
    tabComp.className = 'mode-seg-btn ' + (currentAppMode === 'companion' ? 'active-companion' : '')
    tabWork.className = 'mode-seg-btn ' + (currentAppMode === 'work' ? 'active-work' : '')
    tabLive.className = 'mode-seg-btn ' + (currentAppMode === 'live' ? 'active-live' : '')
  }
}

/**
 * 防中文输入法选词误触：仅 Cmd+Enter / Ctrl+Enter 触发发送
 */
function handleChatKeydown(event) {
  if (event.isComposing || event.keyCode === 229) {
    return
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    sendChat()
  }
}

/**
 * 刷新共生体基础状态 (/api/status)
 */
async function refreshStatus() {
  try {
    const res = await fetch('/api/status')
    const data = await res.json()
    updateModeUI(data.mode)

    const hungerVal = document.getElementById('hungerVal')
    const hungerFill = document.getElementById('hungerFill')
    const moodVal = document.getElementById('moodVal')
    const moodFill = document.getElementById('moodFill')
    const energyVal = document.getElementById('energyVal')
    const energyFill = document.getElementById('energyFill')

    if (hungerVal) hungerVal.innerText = data.stats.hunger + '%'
    if (hungerFill) hungerFill.style.width = data.stats.hunger + '%'
    if (moodVal) moodVal.innerText = data.stats.mood + ' (' + data.emotion + ')'
    if (moodFill) moodFill.style.width = data.stats.mood + '%'
    if (energyVal) energyVal.innerText = data.stats.energy + '%'
    if (energyFill) energyFill.style.width = data.stats.energy + '%'

    const appBadge = document.getElementById('syncAppBadge')
    if (appBadge) {
      if (data.screenLocked) {
        appBadge.innerText = '🌙 屏幕锁定 · 精力充电中'
      } else if (data.activeApp && data.activeApp.name) {
        const catMap = {
          code: '💻 编码专注',
          media: '🍿 视频娱乐回血',
          chat: '💬 社交聊天回温',
          browser: '🌐 网页冲浪',
          other: '✨ 日常陪伴',
        }
        appBadge.innerText = (catMap[data.activeApp.category] || '✨ 陪伴') + ' [' + data.activeApp.name + ']'
      } else {
        appBadge.innerText = '✨ 实时状态共频中'
      }
    }
  } catch {}
}

/**
 * 刷新主人印象档案与技能树 (/api/memories)
 */
async function refreshMemories() {
  try {
    const res = await fetch('/api/memories')
    const data = await res.json()
    if (data.profile) {
      const p = data.profile
      const bondBadge = document.getElementById('bondBadge')
      const memBadge = document.getElementById('memoryStatsBadge')
      if (bondBadge) {
        bondBadge.innerText = '💜 ' + p.bondLevel + ' · 亲密度 ' + p.bondScore
      }
      if (memBadge) {
        memBadge.innerText =
          '专属称呼: ' + p.hostName + ' | 累计对话: ' + p.chatCount + ' | 完成任务: ' + p.taskCount
      }
      const tagsBox = document.getElementById('impressionTagsBox')
      if (tagsBox && Array.isArray(p.impressionTags)) {
        tagsBox.innerHTML = p.impressionTags
          .map((t) => '<span class="pill">#' + escapeHtml(String(t).replace(/^#/, '')) + '</span>')
          .join('')
      }
    }

    const factsBox = document.getElementById('factsListBox')
    if (factsBox && Array.isArray(data.facts)) {
      if (data.facts.length === 0) {
        factsBox.innerHTML = '<div style="color: #64748b;">暂无持久事实，在指挥舱跟大肥鱼聊聊你的喜好或习惯吧~</div>'
      } else {
        factsBox.innerHTML = data.facts
          .map((f) => {
            const conf = Math.round((f.confidence || 0.85) * 100)
            return (
              '<div style="display:flex;justify-content:space-between;border-bottom:1px solid rgba(148,163,184,0.12);padding-bottom:5px;">' +
              '<span><strong>' +
              escapeHtml(f.predicate) +
              '</strong>: ' +
              escapeHtml(f.object) +
              '</span>' +
              '<span style="color:#38bdf8;font-size:11px;">强度 ' +
              conf +
              '%</span></div>'
            )
          })
          .join('')
      }
    }

    const skillsBox = document.getElementById('skillsListBox')
    if (skillsBox && Array.isArray(data.skills)) {
      if (data.skills.length === 0) {
        skillsBox.innerHTML = '<div style="color: #64748b;">暂无自定义口令技能，可在右侧现场传授~</div>'
      } else {
        skillsBox.innerHTML = data.skills
          .map((s) => {
            return (
              '<div style="border-bottom:1px solid rgba(148,163,184,0.12);padding-bottom:6px;">' +
              '<div style="display:flex;justify-content:space-between;">' +
              '<strong>⚡ ' +
              escapeHtml(s.name) +
              '</strong>' +
              '<span style="color:#c4b5fd;font-size:11px;">Lv.' +
              s.level +
              ' (用过' +
              s.usageCount +
              '次)</span></div>' +
              '<div style="color:#94a3b8;font-size:11px;">触发词: 「' +
              escapeHtml(s.triggerPhrase) +
              '」 → ' +
              escapeHtml(s.actionTemplate || '') +
              '</div></div>'
            )
          })
          .join('')
      }
    }
  } catch {}
}

/**
 * 刷新多联系人独立印象图谱 (/api/contacts)
 */
async function refreshContacts() {
  try {
    const searchEl = document.getElementById('contactSearchInput')
    const roleEl = document.getElementById('contactRoleFilter')
    const search = searchEl ? searchEl.value.trim() : ''
    const role = roleEl ? roleEl.value : ''

    const qs = new URLSearchParams()
    if (search) qs.set('search', search)
    if (role) qs.set('role', role)

    const res = await fetch('/api/contacts?' + qs.toString())
    const data = await res.json()
    const contacts = Array.isArray(data.contacts) ? data.contacts : []

    const countBadge = document.getElementById('navContactsCount')
    if (countBadge) {
      countBadge.innerText = String(contacts.length)
    }

    const grid = document.getElementById('contactsGrid')
    if (!grid) return

    if (contacts.length === 0) {
      grid.innerHTML =
        '<div class="sub-box" style="grid-column: 1 / -1; color: #94a3b8; font-size: 13px;">' +
        '🐟 暂无匹配的 QQ 群友/联系人档案。当群友或好友在 QQ 里和大肥鱼互动后，会自动在此生成千人千面独立印象卡片！' +
        '</div>'
      return
    }

    grid.innerHTML = contacts
      .map((c) => {
        const isOwner = c.role === 'owner'
        const avatarUrl =
          'https://q1.qlogo.cn/g?b=qq&nk=' + encodeURIComponent(c.externalId || '10000') + '&s=100'
        const roleBadge = isOwner
          ? '<span class="badge badge-warn">👑 唯一主人</span>'
          : c.role === 'trusted'
          ? '<span class="badge badge-green">🛡️ 信任好友</span>'
          : c.role === 'blocked'
          ? '<span class="badge badge-danger">🚫 黑名单</span>'
          : '<span class="badge">🐟 ' + escapeHtml(c.bondLevel || '群友') + '</span>'

        const tagsHtml =
          Array.isArray(c.impressionTags) && c.impressionTags.length > 0
            ? c.impressionTags
                .map((t) => '<span class="pill">' + escapeHtml(t) + '</span>')
                .join('')
            : '<span style="font-size:11px;color:#64748b;">暂无性格标签</span>'

        const factsHtml =
          Array.isArray(c.facts) && c.facts.length > 0
            ? c.facts
                .map(
                  (f) =>
                    '<div style="font-size:11px;color:#cbd5e1;">• <strong>' +
                    escapeHtml(f.predicate) +
                    '</strong>: ' +
                    escapeHtml(f.object) +
                    '</div>'
                )
                .join('')
            : '<div style="font-size:11px;color:#64748b;">暂未沉淀专属事实</div>'

        const safeUid = escapeHtml(c.uid)
        return (
          '<div class="contact-card ' +
          (isOwner ? 'is-owner' : '') +
          '">' +
          '<div class="contact-header">' +
          '<img class="contact-avatar" src="' +
          avatarUrl +
          '" alt="QQ头像" onerror="this.style.display=\'none\'" />' +
          '<div style="flex:1;min-width:0;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">' +
          '<strong style="font-size:14px;color:#f8fafc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          escapeHtml(c.nickname || c.externalId) +
          '</strong>' +
          roleBadge +
          '</div>' +
          '<div class="mono" style="font-size:11px;color:#94a3b8;">QQ: ' +
          escapeHtml(c.externalId) +
          (c.groupCard ? ' · 群名片: ' + escapeHtml(c.groupCard) : '') +
          ' · 互动 ' +
          (c.chatCount || 1) +
          ' 次</div>' +
          '</div>' +
          '</div>' +
          '<div>' +
          '<div style="display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-bottom:3px;">' +
          '<span>好感度 (' +
          escapeHtml(c.bondLevel) +
          ')</span><span>' +
          (c.affinity ?? 10) +
          '/100</span></div>' +
          '<div class="progress" style="height:6px;margin-bottom:6px;">' +
          '<div class="progress-fill" style="width:' +
          Math.min(100, Math.max(0, c.affinity ?? 10)) +
          '%;background:linear-gradient(90deg,#38bdf8,#a855f7);"></div>' +
          '</div>' +
          '</div>' +
          '<div class="pill-list">' +
          tagsHtml +
          '</div>' +
          '<div style="background:rgba(15,23,42,0.55);padding:8px;border-radius:8px;border:1px solid rgba(148,163,184,0.1);">' +
          factsHtml +
          '</div>' +
          '<div style="display:flex;gap:6px;align-items:center;margin-top:auto;padding-top:4px;">' +
          '<input type="text" id="title-' +
          safeUid +
          '" class="input-box" style="margin-bottom:0;padding:5px 8px;font-size:12px;flex:1;" value="' +
          escapeHtml(c.preferredTitle) +
          '" placeholder="专属称呼" />' +
          '<select id="role-' +
          safeUid +
          '" class="input-box" style="margin-bottom:0;padding:5px 6px;font-size:12px;width:96px;">' +
          '<option value="member" ' +
          (c.role === 'member' ? 'selected' : '') +
          '>普通群友</option>' +
          '<option value="trusted" ' +
          (c.role === 'trusted' ? 'selected' : '') +
          '>信任好友</option>' +
          '<option value="owner" ' +
          (c.role === 'owner' ? 'selected' : '') +
          '>唯一主人</option>' +
          '<option value="blocked" ' +
          (c.role === 'blocked' ? 'selected' : '') +
          '>黑名单</option>' +
          '</select>' +
          '<button class="btn btn-outline btn-sm" data-uid="' +
          safeUid +
          '" onclick="saveContactEdit(this.dataset.uid)">💾 保存</button>' +
          '</div>' +
          '</div>'
        )
      })
      .join('')
  } catch (e) {
    console.error('加载联系人印象失败:', e)
  }
}

/**
 * 保存对单个联系人的专属称呼或角色修改 (/api/contacts/update)
 */
async function saveContactEdit(uid) {
  const titleEl = document.getElementById('title-' + uid)
  const roleEl = document.getElementById('role-' + uid)
  const preferredTitle = titleEl ? titleEl.value.trim() : ''
  const role = roleEl ? roleEl.value : 'member'

  try {
    const res = await fetch('/api/contacts/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid, preferredTitle, role }),
    })
    const data = await res.json()
    if (data.success) {
      showToast('✅ 已更新联系人「' + (data.profile.preferredTitle || uid) + '」的印象设定！', 'success')
      refreshContacts()
    } else {
      showToast('❌ 更新失败: ' + (data.error || '未知错误'), 'error')
    }
  } catch (e) {
    showToast('❌ 请求异常: ' + e.message, 'error')
  }
}

/**
 * 刷新 L1 危险操作待审批队列与近期审计历史 (/api/approvals)
 */
async function refreshApprovals() {
  try {
    const res = await fetch('/api/approvals')
    const data = await res.json()
    const pending = Array.isArray(data.pending) ? data.pending : []
    const history = Array.isArray(data.history) ? data.history : []

    const ownerBadge = document.getElementById('securityOwnerBadge')
    if (ownerBadge) {
      if (data.ownerQq) {
        ownerBadge.className = 'badge badge-green'
        ownerBadge.innerText = '👑 主人 QQ: ' + data.ownerQq
      } else {
        ownerBadge.className = 'badge badge-warn'
        ownerBadge.innerText = '⚠️ 主人 QQ: 尚未绑定'
      }
    }

    const pendingCountText = document.getElementById('pendingCountText')
    if (pendingCountText) pendingCountText.innerText = String(pending.length)

    const navBadge = document.getElementById('navPendingBadge')
    const topBadge = document.getElementById('topApprovalBadge')
    if (navBadge) {
      navBadge.style.display = pending.length > 0 ? 'inline-flex' : 'none'
      navBadge.innerText = String(pending.length)
    }
    if (topBadge) {
      topBadge.style.display = pending.length > 0 ? 'inline-flex' : 'none'
      topBadge.innerText = '⏳ 待审批 (' + pending.length + ')'
    }

    const pendingBox = document.getElementById('pendingApprovalsList')
    if (pendingBox) {
      if (pending.length === 0) {
        pendingBox.innerHTML =
          '<div class="sub-box" style="color: #94a3b8; font-size: 12px;">' +
          '🎉 当前没有挂起的危险操作请求，大肥鱼正在严密守护老爸的电脑~' +
          '</div>'
      } else {
        const now = Date.now()
        pendingBox.innerHTML = pending
          .map((req) => {
            const remainSec = Math.max(0, Math.ceil((req.expiresAt - now) / 1000))
            const safeCode = escapeHtml(req.code)
            return (
              '<div class="approval-card">' +
              '<div style="flex:1;min-width:220px;">' +
              '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
              '<span class="badge badge-warn mono">' +
              safeCode +
              '</span>' +
              '<strong>' +
              escapeHtml(req.senderName) +
              '</strong>' +
              '<span class="mono" style="font-size:11px;color:#94a3b8;">(' +
              escapeHtml(req.senderId) +
              (req.groupId ? ' · 群:' + escapeHtml(req.groupId) : ' · 私聊') +
              ')</span>' +
              '<span style="font-size:11px;color:#fbbf24;">剩余 ' +
              remainSec +
              's</span>' +
              '</div>' +
              '<div style="font-size:12px;color:#f8fafc;">🎯 意图: <strong>' +
              escapeHtml(req.intentLabel) +
              '</strong></div>' +
              '<div style="font-size:12px;color:#cbd5e1;">💬 原话: 「' +
              escapeHtml(req.rawText) +
              '」</div>' +
              '</div>' +
              '<div style="display:flex;gap:8px;">' +
              '<button class="btn btn-success btn-sm" data-code="' +
              safeCode +
              '" onclick="resolveApproval(this.dataset.code, \'approve\')">✅ 批准并执行</button>' +
              '<button class="btn btn-danger btn-sm" data-code="' +
              safeCode +
              '" onclick="resolveApproval(this.dataset.code, \'reject\')">❌ 驳回</button>' +
              '</div>' +
              '</div>'
            )
          })
          .join('')
      }
    }

    const historyBox = document.getElementById('approvalHistoryList')
    if (historyBox) {
      if (history.length === 0) {
        historyBox.innerHTML = '<div style="color:#64748b;">暂无历史审批审计记录</div>'
      } else {
        historyBox.innerHTML = history
          .map((h) => {
            const stBadge =
              h.status === 'approved'
                ? '<span class="tag tag-ready">已批准</span>'
                : h.status === 'rejected'
                ? '<span class="tag" style="background:rgba(239,68,68,0.2);color:#fca5a5;">已驳回</span>'
                : '<span class="tag tag-disabled">已超时</span>'
            return (
              '<div class="provider-row" style="padding:8px 12px;font-size:12px;">' +
              '<div><strong class="mono">' +
              escapeHtml(h.code) +
              '</strong> · ' +
              escapeHtml(h.senderName) +
              ' → ' +
              escapeHtml(h.intentLabel) +
              ' <span style="color:#64748b;">(' +
              escapeHtml(h.rawText) +
              ')</span></div>' +
              '<div>' +
              stBadge +
              '</div>' +
              '</div>'
            )
          })
          .join('')
      }
    }
  } catch {}
}

/**
 * 在 Web 控制台一键批准或驳回 L1 请求 (/api/approvals/resolve)
 */
async function resolveApproval(code, action) {
  try {
    showToast(
      action === 'approve'
        ? '⏳ 正在批准 ' + code + ' 并唤醒执行器回传结果...'
        : '⏳ 正在驳回 ' + code + '...',
      'info'
    )
    const res = await fetch('/api/approvals/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, action }),
    })
    const data = await res.json()
    if (data.success) {
      showToast(
        action === 'approve'
          ? '✅ 已批准并执行 ' + code + '！结果已回传 QQ。'
          : '🛡️ 已驳回请求 ' + code + '！',
        'success'
      )
      refreshApprovals()
    } else {
      showToast('❌ 操作失败: ' + (data.error || '未知错误'), 'error')
      refreshApprovals()
    }
  } catch (e) {
    showToast('❌ 请求异常: ' + e.message, 'error')
  }
}

/**
 * 快捷指令下发
 */
function quickCommand(cmdText) {
  const input = document.getElementById('chatInput')
  if (!input) return
  input.value = cmdText
  sendChat()
}

/**
 * 现场传授新技能或强化长期事实 (/api/memories/teach)
 */
async function teachDaughter(type) {
  const tInput = document.getElementById('teachTriggerInput')
  const aInput = document.getElementById('teachActionInput')
  const v1 = tInput ? tInput.value.trim() : ''
  const v2 = aInput ? aInput.value.trim() : ''
  if (!v1 || !v2) {
    showToast('⚠️ 请填写完整的触发口令/属性与内容哦~', 'warn')
    return
  }
  const payload =
    type === 'skill'
      ? { type: 'skill', triggerPhrase: v1, actionTemplate: v2, name: '专属技能: ' + v1 }
      : { type: 'fact', predicate: v1, object: v2 }

  const res = await fetch('/api/memories/teach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (data.success) {
    showToast(
      type === 'skill' ? '🪄 大肥鱼学会新口令技能啦：' + v1 : '🧠 已加深对老爸的长期记忆：' + v1,
      'success'
    )
  }
  if (tInput) tInput.value = ''
  if (aInput) aInput.value = ''
  refreshMemories()
}

/**
 * 触发每日进化日记生成 (/api/evolve)
 */
async function triggerEvolve() {
  showToast('🧬 正在复盘今日记忆并生成进化日记...', 'info')
  const res = await fetch('/api/evolve', { method: 'POST' })
  const data = await res.json()
  if (data.diary) {
    const logs = document.getElementById('chatLogs')
    if (logs) {
      const msg = document.createElement('div')
      msg.className = 'chat-msg daughter'
      msg.innerHTML =
        '<div class="chat-meta">🐋 大肥鱼 · 每日自我进化与日记沉淀</div>' +
        '哼，本鱼把今天的记忆和学到的本领都写进日记本啦！' +
        '<div class="task-report">' +
        escapeHtml(data.diary.content) +
        '</div>'
      logs.appendChild(msg)
      logs.scrollTop = logs.scrollHeight
    }
    showToast('✨ 今日进化日记已生成！', 'success')
    refreshMemories()
  }
}

/**
 * 全局一键紧急急停 (/api/emergency-stop)
 */
async function emergencyStop() {
  await fetch('/api/emergency-stop', { method: 'POST' })
  showToast('⚡ 已触发全链路紧急急停并清空事件队列！', 'warn')
  refreshStatus()
}

/**
 * 切换运行模式 (/api/mode)
 */
async function toggleMode(mode) {
  await fetch('/api/mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  })
  const modeNames = { companion: '💬 闲聊陪伴模式', work: '🛠️ 工作模式', live: '🔴 直播模式' }
  showToast('已切换至 ' + (modeNames[mode] || mode), 'info')
  refreshStatus()
  refreshMemories()
}

/**
 * 投喂小鱼干奖励 (/api/feed)
 */
async function feed() {
  await fetch('/api/feed', { method: 'POST' })
  showToast('🐟 投喂成功！大肥鱼心情值与饱食度上升啦~', 'success')
  refreshStatus()
  refreshMemories()
}

/**
 * 人工代发言 (/api/say)
 */
async function hostSay(clip) {
  const input = document.getElementById('sayInput')
  const text = input ? input.value.trim() : ''
  if (!text) {
    showToast('⚠️ 请先输入要代大肥鱼说的话哦~', 'warn')
    return
  }
  await fetch('/api/say', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, clip }),
  })
  if (input) input.value = ''
  showToast('🗣️ 已发送至桌面气泡说出！', 'success')
  refreshStatus()
}

/**
 * 注入模拟弹幕事件 (/api/danmaku)
 */
async function injectTestDanmaku() {
  const uEl = document.getElementById('danmakuUserInput')
  const tEl = document.getElementById('danmakuTextInput')
  const nickname = (uEl && uEl.value.trim()) || '热心鱼友'
  const text = (tEl && tEl.value.trim()) || '大肥鱼今天真可爱！'
  await fetch('/api/danmaku', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, text, kind: 'DANMAKU' }),
  })
  if (tEl) tEl.value = ''
  showToast('📡 已注入来自「' + nickname + '」的测试弹幕！', 'success')
}

/**
 * 与大肥鱼对话或下达工作指令 (/api/chat)
 */
async function sendChat() {
  const input = document.getElementById('chatInput')
  const text = input ? input.value.trim() : ''
  if (!text) return
  input.value = ''

  const logs = document.getElementById('chatLogs')
  const userMsg = document.createElement('div')
  userMsg.className = 'chat-msg user'
  userMsg.innerHTML = '<div class="chat-meta">👨‍💻 老爸 (我)</div>' + escapeHtml(text)
  logs.appendChild(userMsg)
  logs.scrollTop = logs.scrollHeight

  const daughterMsg = document.createElement('div')
  daughterMsg.className = 'chat-msg daughter'
  daughterMsg.innerHTML = '<div class="chat-meta">🐋 大肥鱼</div><i>思考 / 施法执行中...</i>'
  logs.appendChild(daughterMsg)
  logs.scrollTop = logs.scrollHeight

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        forceWorkMode: currentAppMode === 'work',
      }),
    })
    const data = await res.json()
    if (data.reply) {
      const rawText = String(data.reply.text || '').trim()
      const finalText =
        rawText ||
        (data.reply.clip === 'success' || data.reply.clip === 'dance'
          ? '老爸，搞定啦！快夸我~ ✨'
          : '诶嘿，本鱼随时待命哦~ 🐟')
      let html =
        '<div class="chat-meta">🐋 大肥鱼 (' +
        escapeHtml(data.reply.clip || '开心') +
        ')</div>' +
        escapeHtml(finalText)
      if (data.reply.taskReport) {
        html += '<div class="task-report">' + escapeHtml(data.reply.taskReport) + '</div>'
      }
      if (
        data.reply.assimilated &&
        Array.isArray(data.reply.assimilated.extractedFacts) &&
        data.reply.assimilated.extractedFacts.length > 0
      ) {
        const fStr = data.reply.assimilated.extractedFacts
          .map((f) => f.predicate + '=' + f.object)
          .join('；')
        html += '<div><span class="mem-badge">🧠 印象已加深：' + escapeHtml(fStr) + '</span></div>'
      }
      if (data.reply.assimilated && data.reply.assimilated.learnedSkill) {
        html +=
          '<div><span class="mem-badge">🪄 习得新技能：' +
          escapeHtml(data.reply.assimilated.learnedSkill.name) +
          '</span></div>'
      }
      daughterMsg.innerHTML = html
    } else {
      daughterMsg.innerHTML =
        '<div class="chat-meta">🐋 大肥鱼</div>(哼，本鱼暂时不想理你或者走神啦)'
    }
  } catch {
    daughterMsg.innerHTML =
      '<div class="chat-meta">🐋 大肥鱼</div>(脑瓜短路了，请检查网络或模型配置)'
  }
  logs.scrollTop = logs.scrollHeight
  refreshStatus()
  refreshMemories()
}

/**
 * 渲染 Google AI Pro (Antigravity) 额度面板
 */
function renderQuotaPanel(quota) {
  if (!quota) return
  const formulaEl = document.getElementById('quotaFormulaHint')
  if (formulaEl && quota.formulaNote) {
    formulaEl.innerText = '📐 饱食度公式: ' + quota.formulaNote
  }

  const ag = quota.antigravity
  const agBadge = document.getElementById('agPlanModelBadge')
  const agBox = document.getElementById('agQuotaItemsBox')
  if (agBadge && ag) {
    agBadge.innerText = (ag.modelName || 'Gemini') + ' · 综合 ' + ag.combinedPct + '%'
  }
  if (agBox && ag && Array.isArray(ag.items) && ag.items.length > 0) {
    agBox.innerHTML = ag.items
      .map((item) => {
        const color =
          item.remainingPct <= 15 ? '#ef4444' : item.remainingPct <= 40 ? '#f59e0b' : '#10b981'
        return (
          '<div>' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:3px;">' +
          '<span>' +
          escapeHtml(item.label) +
          '</span>' +
          '<span><strong style="color:' +
          color +
          ';">' +
          item.remainingPct +
          '%</strong> <small style="color:#64748b;">(' +
          escapeHtml(item.resetInText) +
          '重置)</small></span>' +
          '</div>' +
          '<div style="height:6px;border-radius:4px;background:#0f172a;overflow:hidden;">' +
          '<div style="height:100%;width:' +
          item.remainingPct +
          '%;background:' +
          color +
          ';"></div>' +
          '</div></div>'
        )
      })
      .join('')
  }
}

/**
 * 刷新阶梯思考大脑与额度状态 (/api/brain/status)
 */
async function refreshBrainStatus() {
  try {
    const res = await fetch('/api/brain/status')
    const data = await res.json()
    const list = document.getElementById('providerList')
    const badge = document.getElementById('activeTierBadge')
    if (badge) {
      badge.innerText = '当前首选生效: Tier ' + data.activeTier
    }
    if (data.quota) {
      renderQuotaPanel(data.quota)
    }
    if (list && Array.isArray(data.providers)) {
      let html = ''
      for (const p of data.providers) {
        const isReady = p.available && p.state === 'READY'
        const tagClass = isReady
          ? 'tag-ready'
          : p.state === 'EXHAUSTED' || p.state === 'CIRCUIT_BROKEN'
          ? 'tag-busy'
          : 'tag-disabled'
        const tagLabel = isReady
          ? '就绪'
          : p.state === 'EXHAUSTED'
          ? '额度超限冷却'
          : p.state === 'DISABLED'
          ? '未配置'
          : p.state || '离线'

        let extra = ''
        if (p.binPath) extra = ' · ' + p.binPath
        else if (p.maskedApiKey) {
          const balText =
            p.balance && p.balance.status === 'ready' ? ' · 余额: ' + p.balance.summary : ''
          extra =
            ' · 密钥 (' +
            p.maskedApiKey +
            ')' +
            balText +
            ' · 今日消耗: ¥' +
            (p.todayCostCny || 0)
        } else if (p.todayCostCny !== undefined) {
          extra = ' · 未配置密钥 · 今日消耗: ¥' + p.todayCostCny
        }

        html += '<div class="provider-row">'
        html += '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px;">'
        html += '<strong>Tier ' + p.tier + ': ' + escapeHtml(p.name || p.id) + '</strong>'
        html += '<span style="font-size: 11px; color: #94a3b8;">' + escapeHtml(extra) + '</span>'
        html += '</div>'
        html += '<div style="display:flex;align-items:center;gap:8px;">'
        if (p.tier <= 3) {
          html +=
            '<button class="btn btn-outline btn-sm" style="padding:3px 9px;font-size:11px;" data-pid="' +
            escapeHtml(p.id) +
            '" onclick="testProvider(this.dataset.pid)">⚡ 测试连通性</button>'
        }
        html += '<span class="tag ' + tagClass + '">' + tagLabel + '</span>'
        html += '</div>'
        html += '</div>'

        if (p.tier === 2) {
          const hint = document.getElementById('keyHintText')
          const balBadge = document.getElementById('deepseekBalanceBadge')
          const keyInput = document.getElementById('deepseekKeyInput')
          const bal = p.balance || (data.quota && data.quota.deepseek) || {}
          if (p.maskedApiKey) {
            if (keyInput && !keyInput.value) {
              keyInput.placeholder =
                '🟢 已保存密钥: ' + p.maskedApiKey + ' (输入新Key可直接覆盖更新)'
            }
            if (bal.status === 'ready') {
              if (balBadge) balBadge.innerText = '💰 DeepSeek 余额: ' + bal.summary
              if (hint) {
                hint.innerHTML =
                  '🟢 <strong>当前密钥</strong>: <code>' +
                  escapeHtml(p.maskedApiKey) +
                  '</code> &nbsp;|&nbsp; 💰 <strong>账户真实余额</strong>: <span style="color:#34d399;font-weight:bold;">' +
                  escapeHtml(bal.summary) +
                  '</span> &nbsp;|&nbsp; 📊 <strong>今日已耗</strong>: ¥' +
                  (p.todayCostCny || 0) +
                  ' / 限额 ¥' +
                  (p.dailyBudgetCny || 5)
              }
            } else if (bal.status === 'auth-error' || bal.status === 'error') {
              if (balBadge) balBadge.innerText = '⚠️ ' + (bal.error || '余额查询异常')
              if (hint) {
                hint.innerHTML =
                  '🟡 <strong>当前密钥</strong>: <code>' +
                  escapeHtml(p.maskedApiKey) +
                  '</code> &nbsp;|&nbsp; ⚠️ <strong>余额状态</strong>: <span style="color:#f59e0b;">' +
                  escapeHtml(bal.error || bal.summary || '请点击测试连通性') +
                  '</span>'
              }
            } else {
              if (balBadge) balBadge.innerText = '🔑 密钥已就绪'
              if (hint) {
                hint.innerHTML =
                  '🟢 <strong>当前配置密钥</strong>: <code>' +
                  escapeHtml(p.maskedApiKey) +
                  '</code> (今日已用: ¥' +
                  (p.todayCostCny || 0) +
                  ' / 限额 ¥' +
                  (p.dailyBudgetCny || 5) +
                  ')'
              }
            }
          } else {
            if (keyInput && !keyInput.value) {
              keyInput.placeholder =
                '输入 sk-******************************** (保存至 runtime/data/secrets.json)'
            }
            if (balBadge) balBadge.innerText = '⚪ 未配置 DeepSeek 密钥'
            if (hint) {
              hint.innerHTML =
                '⚪ <strong>当前状态</strong>: 尚未配置 DeepSeek API Key。请在上方输入框粘贴 <code>sk-...</code> 并点击「💾 保存密钥并查余额」。'
            }
          }
        }
      }
      list.innerHTML = html
    }
  } catch (e) {
    console.error('[Console] refreshBrainStatus error:', e)
  }
}

/**
 * 强制同步 Google AI Pro 与 DeepSeek 额度 (/api/brain/quota)
 */
async function forceRefreshQuota() {
  const btn = document.getElementById('syncQuotaBtn')
  if (btn) {
    btn.disabled = true
    btn.innerText = '⏳ 正在探测 Google AI Pro 与 DeepSeek 额度...'
  }
  try {
    const res = await fetch('/api/brain/quota', { method: 'POST' })
    const data = await res.json()
    if (data.quota) {
      renderQuotaPanel(data.quota)
    }
    showToast('✅ 算力粮仓额度已同步！', 'success')
    await refreshStatus()
    await refreshBrainStatus()
  } catch {}
  if (btn) {
    btn.disabled = false
    btn.innerText = '🔄 同步 Google AI Pro & DeepSeek 额度'
  }
}

/**
 * 一键扫描本地 CLI 并刷新额度 (/api/brain/detect-cli)
 */
async function detectAllClis() {
  const btn = document.getElementById('detectCliBtn')
  const banner = document.getElementById('testResultBanner')
  if (btn) {
    btn.disabled = true
    btn.innerText = '⏳ 正在扫描 CLI...'
  }
  if (banner) {
    banner.style.display = 'block'
    banner.innerHTML =
      '🔍 正在自动扫描系统 PATH 与常用目录中的 <code>agy</code> / <code>cursor-agent</code> 并同步额度...'
  }
  try {
    const res = await fetch('/api/brain/detect-cli', { method: 'POST' })
    const data = await res.json()
    if (banner && Array.isArray(data.detected)) {
      const summary = data.detected
        .map((d) => (d.installed ? '✅ ' : '⚪ ') + d.name + ': ' + (d.binPath || '未安装'))
        .join(' &nbsp;|&nbsp; ')
      banner.innerHTML = '🎉 <strong>CLI 一键识别完成</strong>：' + summary
    }
    if (data.quota) {
      renderQuotaPanel(data.quota)
    }
    showToast('🔍 CLI 扫描与额度同步完成！', 'success')
    await refreshStatus()
    await refreshBrainStatus()
  } catch (e) {
    if (banner) {
      banner.innerHTML = '❌ 识别失败: ' + escapeHtml(e.message)
    }
  }
  if (btn) {
    btn.disabled = false
    btn.innerText = '🔍 扫描本地 CLI & 刷新额度'
  }
}

/**
 * 测试指定大脑通道连通性 (/api/brain/test)
 */
async function testProvider(providerId) {
  const banner = document.getElementById('testResultBanner')
  if (banner) {
    banner.style.display = 'block'
    banner.style.borderColor = 'rgba(56, 189, 248, 0.45)'
    banner.innerHTML =
      '⏳ 正在测试通道 <strong>' +
      escapeHtml(providerId) +
      '</strong> 的真实连通性与响应延迟，请稍候...'
  }
  try {
    const res = await fetch('/api/brain/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId }),
    })
    const data = await res.json()
    if (banner) {
      if (data.ok) {
        banner.style.borderColor = 'rgba(16, 185, 129, 0.55)'
        const balInfo =
          data.balance && data.balance.status === 'ready'
            ? ' | 💰 账户余额: <strong>' + escapeHtml(data.balance.summary) + '</strong>'
            : ''
        banner.innerHTML =
          '✅ <strong>[' +
          escapeHtml(providerId) +
          '] 连通测试成功</strong> (耗时 <strong>' +
          data.latencyMs +
          'ms</strong>)' +
          balInfo +
          '<br/>💬 模型响应: 「' +
          escapeHtml(data.replySample || 'OK') +
          '」'
        showToast('✅ [' + providerId + '] 连通成功 (' + data.latencyMs + 'ms)', 'success')
      } else {
        banner.style.borderColor = 'rgba(239, 68, 68, 0.55)'
        banner.innerHTML =
          '❌ <strong>[' +
          escapeHtml(providerId) +
          '] 连通测试失败</strong> (耗时 ' +
          (data.latencyMs || 0) +
          'ms): <span style="color:#fca5a5;">' +
          escapeHtml(data.error || '未知错误') +
          '</span>'
        showToast('❌ [' + providerId + '] 连通失败: ' + (data.error || ''), 'error')
      }
    }
    await refreshBrainStatus()
    await refreshStatus()
  } catch (e) {
    if (banner) {
      banner.style.borderColor = 'rgba(239, 68, 68, 0.55)'
      banner.innerHTML = '❌ 请求异常: ' + escapeHtml(e.message)
    }
  }
}

/**
 * 保存 DeepSeek API Key (/api/config/deepseek)
 */
async function saveDeepSeekKey() {
  const input = document.getElementById('deepseekKeyInput')
  const btn = document.getElementById('saveKeyBtn')
  const key = input ? input.value.trim() : ''
  if (!key) {
    showToast('⚠️ 请输入有效的 DeepSeek API Key (以 sk- 开头)', 'warn')
    return
  }
  const hint = document.getElementById('keyHintText')
  if (btn) {
    btn.disabled = true
    btn.innerText = '⏳ 正在保存...'
  }
  if (hint) {
    hint.innerHTML = '⏳ 正在保存密钥至本地密盒，并向 DeepSeek 校验余额...'
  }
  try {
    const res = await fetch('/api/config/deepseek', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    })
    const data = await res.json()
    if (input) {
      input.value = ''
      if (data.maskedApiKey) {
        input.placeholder = '🟢 已保存密钥: ' + data.maskedApiKey + ' (输入新Key可直接覆盖更新)'
      }
    }
    await refreshBrainStatus()
    await refreshStatus()
    showToast(data.message || '✅ DeepSeek 密钥配置已生效！', 'success')
  } catch (e) {
    showToast('❌ 保存失败: ' + e.message, 'error')
  } finally {
    if (btn) {
      btn.disabled = false
      btn.innerText = '💾 保存密钥并查余额'
    }
  }
}

/**
 * 触发桌面宠物灵动动作与复合神态 (/api/action/play)
 */
async function playPetAction(clip) {
  const badge = document.getElementById('actionStatusBadge')
  const banner = document.getElementById('actionFeedbackBanner')
  const customInput = document.getElementById('customMotionSpeechInput')
  const speech = customInput ? customInput.value.trim() : ''

  if (badge) badge.innerText = '⏳ 正在执行: ' + clip
  try {
    const res = await fetch('/api/action/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clip, speech }),
    })
    const data = await res.json()
    if (badge) badge.innerText = '✅ 已演练: ' + clip
    if (banner) {
      banner.style.display = 'block'
      banner.innerHTML =
        '🎬 <strong>动作「' +
        escapeHtml(clip) +
        '」已触发</strong>' +
        (data.speech ? ' · 💬 伴随台词: 「' + escapeHtml(data.speech) + '」' : '')
    }
    showToast('🎭 已演练动作: ' + clip, 'success', 2200)
    await refreshStatus()
  } catch {
    if (badge) badge.innerText = '❌ 执行失败'
  }
}

/**
 * 加载 QQ OneBot 网关与主人 QQ 状态 (/api/config/onebot)
 */
async function loadOneBotStatus() {
  try {
    const res = await fetch('/api/config/onebot')
    const data = await res.json()
    const badge = document.getElementById('onebotStatusBadge')
    const wsInput = document.getElementById('obWsUrlInput')
    const nameInput = document.getElementById('obBotNameInput')
    const tokenInput = document.getElementById('obTokenInput')
    const ownerInput = document.getElementById('obOwnerQqInput')
    const infoInput = document.getElementById('obBotInfoInput')
    const hint = document.getElementById('obHintText')
    const privateCheck = document.getElementById('obAllowPrivateCheck')
    const groupCheck = document.getElementById('obAllowGroupCheck')
    const atCheck = document.getElementById('obGroupRequireAtCheck')
    const ownerBadge = document.getElementById('securityOwnerBadge')

    if (ownerBadge) {
      if (data.ownerQq) {
        ownerBadge.className = 'badge badge-green'
        ownerBadge.innerText = '👑 主人 QQ: ' + data.ownerQq
      } else {
        ownerBadge.className = 'badge badge-warn'
        ownerBadge.innerText = '⚠️ 主人 QQ: 尚未绑定'
      }
    }

    if (data.connected) {
      if (badge) {
        badge.className = 'badge badge-green'
        badge.innerText =
          '🟢 已连入 QQ (' + (data.botNickname || '大肥鱼') + ' · ' + (data.botQq || '') + ')'
      }
      if (infoInput) {
        infoInput.value =
          (data.botNickname || '大肥鱼') +
          ' (' +
          (data.botQq || '未知') +
          ') · 已收 ' +
          (data.totalReceived || 0) +
          ' 消息'
      }
      if (hint) {
        hint.innerHTML =
          '🟢 <strong>QQ 网关连接就绪</strong>：已连接到 <code>' +
          escapeHtml(data.wsUrl) +
          '</code>，可在私聊或群聊 @' +
          escapeHtml(data.botName || '大肥鱼') +
          ' 互动！'
      }
    } else {
      if (badge) {
        badge.className = 'badge'
        badge.innerText = '⚪ 未连接 NapCatQQ (每5秒自动重试)'
      }
      if (infoInput) infoInput.value = '未连接 (请在本地启动 NapCatQQ)'
      if (hint) {
        hint.innerHTML =
          '💡 <strong>提示</strong>：请确保 NapCatQQ / OneBot 已在 <code>' +
          escapeHtml(data.wsUrl || 'ws://127.0.0.1:3001') +
          '</code> 运行'
      }
    }

    if (wsInput && !wsInput.dataset.filled && data.wsUrl) {
      wsInput.value = data.wsUrl
      wsInput.dataset.filled = 'true'
    }
    if (nameInput && !nameInput.dataset.filled && data.botName) {
      nameInput.value = data.botName
      nameInput.dataset.filled = 'true'
    }
    if (tokenInput && !tokenInput.dataset.filled && data.accessToken) {
      tokenInput.value = data.accessToken
      tokenInput.dataset.filled = 'true'
    }
    if (ownerInput && !ownerInput.dataset.filled && data.ownerQq !== undefined) {
      ownerInput.value = data.ownerQq || ''
      ownerInput.dataset.filled = 'true'
    }
    if (privateCheck && !privateCheck.dataset.filled && data.allowPrivate !== undefined) {
      privateCheck.checked = Boolean(data.allowPrivate)
      privateCheck.dataset.filled = 'true'
    }
    if (groupCheck && !groupCheck.dataset.filled && data.allowGroup !== undefined) {
      groupCheck.checked = Boolean(data.allowGroup)
      groupCheck.dataset.filled = 'true'
    }
    if (atCheck && !atCheck.dataset.filled && data.groupRequireAt !== undefined) {
      atCheck.checked = Boolean(data.groupRequireAt)
      atCheck.dataset.filled = 'true'
    }
  } catch (e) {
    console.error('加载 QQ OneBot 状态失败:', e)
  }
}

/**
 * 保存 QQ OneBot 配置与唯一主人 QQ 号 (/api/config/onebot)
 */
async function saveOneBotConfig() {
  const wsInput = document.getElementById('obWsUrlInput')
  const nameInput = document.getElementById('obBotNameInput')
  const tokenInput = document.getElementById('obTokenInput')
  const ownerInput = document.getElementById('obOwnerQqInput')
  const privateCheck = document.getElementById('obAllowPrivateCheck')
  const groupCheck = document.getElementById('obAllowGroupCheck')
  const atCheck = document.getElementById('obGroupRequireAtCheck')
  const btn = document.getElementById('saveOneBotBtn')

  const wsUrl = wsInput ? wsInput.value.trim() : 'ws://127.0.0.1:3001'
  const botName = nameInput ? nameInput.value.trim() : '大肥鱼'
  const accessToken = tokenInput ? tokenInput.value.trim() : ''
  const ownerQq = ownerInput ? ownerInput.value.trim() : ''
  const allowPrivate = privateCheck ? privateCheck.checked : true
  const allowGroup = groupCheck ? groupCheck.checked : true
  const groupRequireAt = atCheck ? atCheck.checked : true

  if (!wsUrl) {
    showToast('⚠️ 请输入有效的 OneBot WebSocket 地址 (例如 ws://127.0.0.1:3001)', 'warn')
    return
  }

  if (btn) {
    btn.disabled = true
    btn.innerText = '⏳ 正在保存...'
  }

  try {
    const payload = {
      enabled: true,
      wsUrl,
      botName,
      accessToken,
      ownerQq,
      allowPrivate,
      allowGroup,
      groupRequireAt,
    }

    const res = await fetch('/api/config/onebot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await res.json()
    if (data.success) {
      showToast(
        '✅ QQ 网关配置与主人账号 (' + (ownerQq || '未设') + ') 已保存！',
        'success'
      )
      await loadOneBotStatus()
      await refreshApprovals()
    } else {
      showToast('❌ 保存失败: ' + (data.error || '未知错误'), 'error')
    }
  } catch (e) {
    showToast('❌ 请求异常: ' + e.message, 'error')
  } finally {
    if (btn) {
      btn.disabled = false
      btn.innerText = '💾 保存配置并连接 QQ 网关'
    }
  }
}

/**
 * 立即触发 QQ 网关重连 (/api/onebot/reconnect)
 */
async function reconnectOneBot() {
  const btn = document.getElementById('reconnectOneBotBtn')
  if (btn) {
    btn.disabled = true
    btn.innerText = '⏳ 正在重连...'
  }
  try {
    const res = await fetch('/api/onebot/reconnect', { method: 'POST' })
    const data = await res.json()
    await loadOneBotStatus()
    showToast(data.message || '🔄 已触发 QQ 网关重新连接', 'info')
  } catch (e) {
    showToast('❌ 重连请求异常: ' + e.message, 'error')
  } finally {
    if (btn) {
      btn.disabled = false
      btn.innerText = '🔄 立即触发重连'
    }
  }
}

/**
 * 主动向老爸发送测试 QQ 私聊消息 (/api/onebot/send-test)
 */
async function sendOneBotTest() {
  const ownerInput = document.getElementById('obOwnerQqInput')
  const targetQq = ownerInput ? ownerInput.value.trim() : ''
  try {
    const res = await fetch('/api/onebot/send-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetQq }),
    })
    const data = await res.json()
    if (data.success) {
      showToast('📨 测试消息已发送至 QQ: ' + (data.targetQq || targetQq), 'success')
    } else {
      showToast('⚠️ 发送失败: ' + (data.error || '请检查 NapCatQQ 连接与主人 QQ 号'), 'warn')
    }
  } catch (e) {
    showToast('❌ 请求异常: ' + e.message, 'error')
  }
}

// 启动定时轮询同步
setInterval(refreshStatus, 2000)
setInterval(refreshBrainStatus, 3500)
setInterval(refreshMemories, 4500)
setInterval(loadOneBotStatus, 3500)
setInterval(refreshApprovals, 2500)
setInterval(() => {
  if (activeWorkspaceTab === 'memory') {
    refreshContacts()
  }
}, 5000)

// 初次加载同步
refreshStatus()
refreshBrainStatus()
refreshMemories()
refreshContacts()
loadOneBotStatus()
refreshApprovals()
