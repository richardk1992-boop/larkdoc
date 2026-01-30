// 飞书文档 AI 助手 - SidePanel Script

// ===== 全局变量 =====
let documentContent = ''; // 存储获取到的完整文档内容（含评论）
let selectedContent = ''; // 存储用户选中的文本
let documentRawData = null; // 存储原始数据（便于下载）
let currentAbortController = null; // 用于中断 AI 输出
let isGenerating = false; // 标记是否正在生成内容

let aiConfig = {
  model: 'zhipu',
  apiKey: '',
  apiKeys: {},
  apiUrl: '', // for custom
  modelName: '', // for custom
  geminiModelName: '',
  prompts: []
};

let downloadConfig = {
  saveFolder: '',
  overwriteExisting: true
};

// 默认 Prompt 配置
const DEFAULT_PROMPTS = [
  { name: "总结文档", template: "请简要总结这篇文档的主要内容。\n\n文档内容：\n{{context}}" },
  { name: "提取待办", template: "请从文档中提取所有待办事项（Todo），并列出负责人（如果有）。\n\n文档内容：\n{{context}}" },
  { name: "分析评论", template: "请分析文档中的评论，总结主要讨论点和未解决的问题。\n\n文档内容：\n{{context}}" },
  { name: "润色文本", template: "请润色以下文本，使其更加专业流畅。\n\n文本：\n{{context}}" },
  { name: "翻译英文", template: "请将以下内容翻译成英文，保持原意。\n\n内容：\n{{context}}" },
  { name: "解释代码", template: "请解释文档中的代码片段，说明其功能和逻辑。\n\n文档内容：\n{{context}}" },
  { name: "撰写邮件", template: "根据文档内容，起草一封相关的邮件。\n\n文档内容：\n{{context}}" },
  { name: "扩写内容", template: "请根据文档内容进行扩写，补充更多细节。\n\n文档内容：\n{{context}}" }
];

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', async () => {
  // 1. 初始化设置与配置
  await loadAIConfig();
  await loadConfig(); // 飞书配置
  await loadDownloadConfig(); // 下载设置
  
  // 2. 绑定事件监听器
  bindEventListeners();
  
  // 3. 检查授权状态
  checkAuthStatus();
  
  // 4. 监听消息
  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  
  // 5. 初始化选中状态
  const storage = await chrome.storage.local.get(['selectedText']);
  if (storage.selectedText) {
      updateSelectionUI(storage.selectedText);
  }

  // 6. 尝试动态注入 selection_listener.js
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && (tab.url.includes('feishu.cn') || tab.url.includes('larksuite.com'))) {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['selection_listener.js']
        });
    }
  } catch (e) {
      console.log('Script injection failed (likely already injected or restricted page):', e);
  }
});

// ===== 事件绑定 =====
function bindEventListeners() {
  // 顶部栏
  document.getElementById('fetchContent').addEventListener('click', fetchDocumentContent);
  document.getElementById('downloadMdBtn').addEventListener('click', downloadMarkdown);
  document.getElementById('openSettings').addEventListener('click', () => toggleModal('settingsModal', true));
  
  // 设置模态框
  document.getElementById('closeSettings').addEventListener('click', () => toggleModal('settingsModal', false));
  document.getElementById('saveSettings').addEventListener('click', saveAISettings);
  document.getElementById('addPromptBtn').addEventListener('click', handleAddPrompt);
  document.getElementById('browseFolder').addEventListener('click', handleBrowseFolder);
  
  // Tab 切换
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => switchTab(e.target.dataset.tab));
  });

  // 飞书配置 (Inside Modal)
  document.getElementById('testConnection').addEventListener('click', testConnection);
  document.getElementById('authorizeBtn').addEventListener('click', startAuthorization);
  document.getElementById('logoutBtn').addEventListener('click', logout);
  
  // AI 配置
  document.getElementById('modelSelect').addEventListener('change', handleModelSelectChange);
  
  // Gemini 测试
  if (document.getElementById('testGeminiConnection')) {
    document.getElementById('testGeminiConnection').addEventListener('click', testGeminiConnection);
  }
  if (document.getElementById('geminiModeToggle')) {
    document.getElementById('geminiModeToggle').addEventListener('click', handleGeminiModeToggle);
  }
  
  document.getElementById('chatMessages').addEventListener('click', handleCopyClick);
  
  // AI 快捷按钮 (Event Delegation)
  document.getElementById('promptBar').addEventListener('click', (e) => {
    if (e.target.classList.contains('prompt-chip')) {
      handleActionClick(e.target.dataset.promptId);
    }
  });
  
  // 聊天
  document.getElementById('sendMessage').addEventListener('click', handleSendOrStop);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendOrStop();
    }
  });
  
  // 清除选中
  document.getElementById('clearSelection').addEventListener('click', clearSelection);

  // 错误提示关闭
  document.querySelector('.close-toast').addEventListener('click', () => {
    document.getElementById('errorSection').classList.add('hidden');
  });
}

// ===== Selection Logic =====
function updateSelectionUI(text) {
  selectedContent = text;
  const preview = document.getElementById('selectionPreview');
  const textEl = document.getElementById('selTextContent');
  
  if (text) {
    preview.classList.remove('hidden');
    textEl.textContent = `📝 已选中 ${text.length} 字`;
  } else {
    preview.classList.add('hidden');
    textEl.textContent = '';
  }
}

function clearSelection() {
  chrome.storage.local.remove(['selectedText']);
  updateSelectionUI('');
}


// ===== Tab 切换逻辑 =====
function switchTab(tabId) {
  // Update Buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  
  // Update Content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === tabId);
  });
}

function getApiKeyForModel(model) {
  const keys = aiConfig.apiKeys || {};
  if (keys[model]) return keys[model];
  if (aiConfig.apiKey && aiConfig.model === model) return aiConfig.apiKey;
  return aiConfig.apiKey || '';
}

function getGeminiModeLabel() {
  const name = (aiConfig.geminiModelName || 'gemini-3-flash-preview').toLowerCase();
  return name.includes('pro') ? 'Pro' : 'Flash';
}

function updateGeminiModeToggle() {
  const toggle = document.getElementById('geminiModeToggle');
  if (!toggle) return;
  const isGemini = aiConfig.model === 'gemini';
  toggle.classList.toggle('hidden', !isGemini);
  if (isGemini) toggle.textContent = getGeminiModeLabel();
}

// ===== 下载设置管理 =====
async function loadDownloadConfig() {
  const data = await chrome.storage.local.get(['downloadConfig']);
  if (data.downloadConfig) {
    downloadConfig = { ...downloadConfig, ...data.downloadConfig };
  }
  
  // 确保默认值
  if (downloadConfig.overwriteExisting === undefined) {
    downloadConfig.overwriteExisting = true;
  }
  
  // 填充 UI
  const saveFolderInput = document.getElementById('saveFolder');
  if (saveFolderInput) {
    saveFolderInput.value = downloadConfig.saveFolder || '';
    saveFolderInput.readOnly = false;
    saveFolderInput.style.backgroundColor = '#ffffff';
    saveFolderInput.style.cursor = 'text';
    
    // 添加change事件监听器，当用户输入路径后自动保存
    saveFolderInput.addEventListener('change', function() {
      const folderPath = this.value.trim();
      if (folderPath) {
        downloadConfig.saveFolder = folderPath;
        chrome.storage.local.set({ downloadConfig });
        showError('保存文件夹已更新: ' + folderPath);
      }
    });
  }
  
  document.getElementById('overwriteExisting').checked = downloadConfig.overwriteExisting;
}

function handleBrowseFolder() {
  // 简化方案：让用户直接在输入框中输入保存路径
  // 点击浏览按钮时，提示用户直接输入路径
  showError('请直接在输入框中输入保存路径，例如: /Users/yourname/Downloads');
  
  // 确保输入框是可编辑的
  const saveFolderInput = document.getElementById('saveFolder');
  if (saveFolderInput) {
    saveFolderInput.readOnly = false;
    saveFolderInput.style.backgroundColor = '#ffffff';
    saveFolderInput.style.cursor = 'text';
  }
}

function setGeminiModelName(name) {
  aiConfig = { ...aiConfig, geminiModelName: name };
  const input = document.getElementById('geminiModelName');
  if (input) input.value = name;
  updateGeminiModeToggle();
  chrome.storage.local.set({ aiConfig });
}

function handleGeminiModeToggle() {
  if (aiConfig.model !== 'gemini') return;
  const current = (aiConfig.geminiModelName || 'gemini-3-flash-preview').toLowerCase();
  const next = current.includes('pro') ? 'gemini-3-flash-preview' : 'gemini-3-pro-preview';
  setGeminiModelName(next);
}

// ===== 配置管理 (AI) =====
async function loadAIConfig() {
  const data = await chrome.storage.local.get(['aiConfig']);
  if (data.aiConfig) {
    aiConfig = { ...aiConfig, ...data.aiConfig };
  }
  if (!aiConfig.apiKeys) {
    aiConfig.apiKeys = {};
  }
  if (aiConfig.apiKey && !aiConfig.apiKeys[aiConfig.model || 'zhipu']) {
    aiConfig.apiKeys[aiConfig.model || 'zhipu'] = aiConfig.apiKey;
  }
  aiConfig.apiKey = getApiKeyForModel(aiConfig.model || 'zhipu');
  
  // 初始化 Prompts
  if (!aiConfig.prompts || aiConfig.prompts.length === 0) {
    aiConfig.prompts = JSON.parse(JSON.stringify(DEFAULT_PROMPTS));
  }
  
  // 填充 UI
  document.getElementById('modelSelect').value = aiConfig.model || 'zhipu';
  document.getElementById('aiApiKey').value = getApiKeyForModel(aiConfig.model || 'zhipu');
  document.getElementById('aiApiUrl').value = aiConfig.apiUrl || '';
  document.getElementById('aiModelName').value = aiConfig.modelName || '';
  document.getElementById('geminiModelName').value = aiConfig.geminiModelName || '';
  
  handleModelSelectChange(); // 触发 UI 更新
  renderPromptSettings(); // 更新 Prompt 输入框
  updateActionButtons(); // 更新首页按钮文本
  updateGeminiModeToggle();
}

function renderPromptSettings() {
  const container = document.getElementById('promptsContainer');
  container.innerHTML = '';
  
  aiConfig.prompts.forEach((prompt, index) => {
    addPromptInput(container, prompt.name, prompt.template);
  });
}

function addPromptInput(container, name = '', template = '') {
    const div = document.createElement('div');
    div.className = 'prompt-config-item';
    div.innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:6px;">
          <input type="text" class="prompt-name" value="${name}" placeholder="按钮名称 (最多4字)" maxlength="4" style="flex:1" />
          <button class="btn btn-danger btn-small delete-prompt" style="padding:4px 8px;">×</button>
      </div>
      <textarea class="prompt-template" placeholder="Prompt 模板">${template}</textarea>
    `;
    container.appendChild(div);
    
    // Bind delete event
    div.querySelector('.delete-prompt').addEventListener('click', () => {
        div.remove();
    });
}

function handleAddPrompt() {
    const container = document.getElementById('promptsContainer');
    if (container.children.length >= 20) {
        alert('最多只能添加 20 个指令');
        return;
    }
    addPromptInput(container, '', '');
    // Scroll to bottom
    const modalBody = document.querySelector('.modal-body');
    modalBody.scrollTop = modalBody.scrollHeight;
}

function updateActionButtons() {
  const container = document.getElementById('promptBar');
  container.innerHTML = ''; // Clear existing
  
  aiConfig.prompts.forEach((prompt, index) => {
    const btn = document.createElement('button');
    btn.className = 'prompt-chip';
    btn.dataset.promptId = index;
    btn.textContent = prompt.name;
    container.appendChild(btn);
  });
}

async function saveAISettings() {
  // 保存 AI 配置
  const model = document.getElementById('modelSelect').value;
  const apiKeyValue = document.getElementById('aiApiKey').value.trim();
  const apiKeys = { ...(aiConfig.apiKeys || {}) };
  apiKeys[model] = apiKeyValue;
  const newConfig = {
    model: model,
    apiKey: apiKeyValue,
    apiKeys: apiKeys,
    apiUrl: document.getElementById('aiApiUrl').value.trim(),
    modelName: document.getElementById('aiModelName').value.trim(),
    geminiModelName: document.getElementById('geminiModelName').value.trim(),
    prompts: []
  };
  
  console.log('[Settings] Saving config:', newConfig); // 打印保存的配置以便排查
  
  // 收集 Prompts
  const promptItems = document.querySelectorAll('#promptsContainer .prompt-config-item');
  promptItems.forEach(item => {
      const name = item.querySelector('.prompt-name').value.trim();
      const template = item.querySelector('.prompt-template').value;
      if (name) {
          newConfig.prompts.push({ name, template });
      }
  });
  
  aiConfig = newConfig;
  await chrome.storage.local.set({ aiConfig });
  
  // 保存飞书配置
  const appId = document.getElementById('appId').value.trim();
  const appSecret = document.getElementById('appSecret').value.trim();
  if (appId && appSecret) {
    await chrome.storage.local.set({ appId, appSecret });
  }
  
  // 保存下载设置
  const newDownloadConfig = {
    saveFolder: document.getElementById('saveFolder').value.trim(),
    overwriteExisting: document.getElementById('overwriteExisting').checked
  };
  downloadConfig = newDownloadConfig;
  await chrome.storage.local.set({ downloadConfig });
  
  updateActionButtons();
  toggleModal('settingsModal', false);
}

function handleModelSelectChange() {
  const model = document.getElementById('modelSelect').value;
  const customEndpointGroup = document.getElementById('customEndpointGroup');
  const customModelGroup = document.getElementById('customModelGroup');
  const geminiModelGroup = document.getElementById('geminiModelGroup');
  const geminiTestGroup = document.getElementById('geminiTestGroup');
  const apiKeyInput = document.getElementById('aiApiKey');
  apiKeyInput.value = getApiKeyForModel(model);
  
  if (model === 'custom') {
    customEndpointGroup.classList.remove('hidden');
    customModelGroup.classList.remove('hidden');
    geminiModelGroup.classList.add('hidden');
    geminiTestGroup.classList.add('hidden');
    apiKeyInput.placeholder = "sk-xxxxxxxx";
  } else if (model === 'zhipu') {
    customEndpointGroup.classList.add('hidden');
    customModelGroup.classList.add('hidden');
    geminiModelGroup.classList.add('hidden');
    geminiTestGroup.classList.add('hidden');
    apiKeyInput.placeholder = "智谱 API Key";
  } else if (model === 'gemini') {
    customEndpointGroup.classList.add('hidden');
    customModelGroup.classList.add('hidden');
    geminiModelGroup.classList.remove('hidden');
    geminiTestGroup.classList.remove('hidden');
    apiKeyInput.placeholder = "Gemini API Key";
  }
  updateGeminiModeToggle();
}

// ===== 飞书文档获取 =====
async function fetchDocumentContent() {
  if (!checkConfig()) return;

  const btn = document.getElementById('fetchContent');
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<span class="loading">⏳</span> 获取中...';
  btn.disabled = true;
  
  // 重置状态
  updateDocStatus('doc', 'loading');
  updateDocStatus('comment', 'loading');
  document.getElementById('docStatusSection').classList.remove('hidden');
  document.getElementById('downloadMdBtn').classList.add('hidden');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const docIdResult = await getDocumentIdFromTab(tab);
    if (!docIdResult) throw new Error('无法从当前页面提取文档 ID');

    const config = await chrome.storage.local.get(['appId', 'appSecret']);
    const response = await chrome.runtime.sendMessage({
      action: 'fetchDocument',
      documentId: docIdResult.documentId,
      docType: docIdResult.type, // 传递文档类型
      appId: config.appId,
      appSecret: config.appSecret,
      domain: tab.url
    });

    if (response.success) {
      documentContent = response.content;
      documentRawData = response;
      
      // 提取并显示文档标题
      let docTitle = '未知文档';
      if (response.title) {
        docTitle = response.title;
      } else if (response.content) {
        // 从内容中提取标题（如果没有直接提供）
        const titleMatch = response.content.match(/^#\s+(.*)$/m);
        if (titleMatch) {
          docTitle = titleMatch[1];
        }
      }
      
      // 显示文档标题，限定前20字
      const docTitleElement = document.getElementById('docTitle');
      const docTitleSection = document.getElementById('docTitleSection');
      if (docTitleElement && docTitleSection) {
        docTitleElement.textContent = docTitle.length > 20 ? docTitle.substring(0, 20) + '...' : docTitle;
        docTitleElement.title = docTitle;
        docTitleSection.classList.remove('hidden');
      }
      
      updateDocStatus('doc', 'success');
      if (response.content.includes('### 📝 文档评论')) {
        updateDocStatus('comment', 'success');
      } else {
        updateDocStatus('comment', 'none');
      }
      
      document.getElementById('downloadMdBtn').classList.remove('hidden');
      appendSystemMessage(`✅ 文档获取成功！共 ${response.content.length} 字。现在可以使用 AI 功能了。`);
    } else {
      updateDocStatus('doc', 'error');
      updateDocStatus('comment', 'error');
      showError(response.error);
    }
  } catch (error) {
    updateDocStatus('doc', 'error');
    updateDocStatus('comment', 'error');
    showError(error.message);
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}

function updateDocStatus(type, status) {
  const iconId = type === 'doc' ? 'docStatusIcon' : 'commentStatusIcon';
  const el = document.getElementById(iconId);
  
  if (status === 'loading') {
    el.textContent = '⏳'; el.className = 'loading';
  } else if (status === 'success') {
    el.textContent = '✅'; el.className = 'success';
  } else if (status === 'error') {
    el.textContent = '❌'; el.className = 'error';
  } else {
    el.textContent = '⚪'; el.className = '';
  }
}

// ===== AI 交互逻辑 =====
async function handleActionClick(promptId) {
  if (!documentContent) {
    showError('请先获取文档内容');
    return;
  }
  
  if (!aiConfig.apiKey) {
    showError('请先在设置中配置 AI 模型 API Key');
    toggleModal('settingsModal', true);
    switchTab('tab-ai');
    return;
  }
  
  const promptConfig = aiConfig.prompts[promptId];
  if (!promptConfig) return;
  
  // Use selectedContent if available, otherwise documentContent
  let rawContext = selectedContent || documentContent;
  let contextLabel = '文档内容';
  if (selectedContent) contextLabel = '选中的内容';

  // Truncate to 150k characters
  const context = rawContext.length > 150000 ? rawContext.substring(0, 150000) + '... (内容已截断)' : rawContext;
  const fullPrompt = promptConfig.template.replace('{{context}}', context);
  
  // Update UI message
  const sourceLabel = selectedContent ? '【选中内容】' : '';
  appendUserMessage(`【${promptConfig.name}】${sourceLabel}`);
  await callAIService(fullPrompt);
}

function handleSendOrStop() {
    if (isGenerating) {
        stopGeneration();
    } else {
        handleSendMessage();
    }
}

function stopGeneration() {
    if (currentAbortController) {
        currentAbortController.abort();
        currentAbortController = null;
        updateUIState(false);
        appendSystemMessage('🚫 已停止生成');
    }
}

function updateUIState(generating) {
    isGenerating = generating;
    const btn = document.getElementById('sendMessage');
    const input = document.getElementById('chatInput');
    
    if (generating) {
        btn.innerHTML = '⏹'; // 停止图标
        btn.classList.add('btn-stop');
        btn.title = "停止生成";
        input.disabled = true;
    } else {
        btn.innerHTML = '➤'; // 发送图标
        btn.classList.remove('btn-stop');
        btn.title = "发送";
        input.disabled = false;
        input.focus();
    }
}

async function handleSendMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  
  if (!aiConfig.apiKey) {
    showError('请先在设置中配置 AI 模型 API Key');
    toggleModal('settingsModal', true);
    switchTab('tab-ai');
    return;
  }

  input.value = '';
  appendUserMessage(text);
  
  let prompt = text;
  
  let rawContext = selectedContent || documentContent;
  let contextLabel = '文档内容';
  if (selectedContent) contextLabel = '选中的内容';
  
  const context = rawContext.length > 150000 ? rawContext.substring(0, 150000) : rawContext;
  
  if (context) {
    const truncationHint = rawContext.length > 150000 ? ' (内容较长已部分截断)' : '';
    prompt = `${contextLabel}${truncationHint}如下：\n${context}\n\n我的问题是：${text}`;
  }
  
  await callAIService(prompt);
}

// 调用 AI 服务
async function callAIService(prompt) {
  // 强制重新加载最新配置，防止内存中的配置滞后
  await loadAIConfig();
  
  const messageId = appendAIMessage('Thinking...');
  const messageEl = document.getElementById(messageId);
  const contentEl = messageEl.querySelector('.message-content');
  let fullResponse = '';
  
  // 创建新的 AbortController
  currentAbortController = new AbortController();
  updateUIState(true);
  
  try {
    const requestBody = {
      model: aiConfig.model,
      apiKey: aiConfig.apiKey,
      messages: [{ role: 'user', content: prompt }],
      signal: currentAbortController.signal // 传入 signal
    };
    
    if (aiConfig.model === 'custom') {
      requestBody.apiUrl = aiConfig.apiUrl;
      requestBody.modelName = aiConfig.modelName;
    }

    const onChunk = (chunk) => {
      if (fullResponse === '') contentEl.innerHTML = '';
      fullResponse += chunk;
      contentEl.innerHTML = simpleMarkdown(fullResponse);
      scrollToBottom();
    };

    if (aiConfig.model === 'zhipu') {
      await streamZhipuAI(requestBody, onChunk);
    } else if (aiConfig.model === 'gemini') {
      await streamGemini(requestBody, onChunk);
    } else {
      await streamOpenAI(requestBody, onChunk);
    }
    
  } catch (error) {
    currentAbortController = null; // 先重置控制器
    updateUIState(false); // 恢复 UI
    
    if (error.name === 'AbortError') {
      console.log('AI generation aborted');
    } else {
      contentEl.innerHTML += `<br><span style="color:red">[错误: ${error.message}]</span>`;
      console.error('AI Error:', error);
    }
  } finally {
    if (isGenerating) {
        currentAbortController = null;
        updateUIState(false);
    }
  }
}

// ===== 简易 Markdown 解析器 =====
function simpleMarkdown(text) {
  if (!text) return '';
  
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const codeBlocks = [];
  html = html.replace(/```(\w*)([\s\S]*?)```/g, (match, lang, code) => {
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');

  html = html.replace(/^> (.*$)/gm, '<blockquote>$1</blockquote>');

  html = html.replace(/^\s*[-*] (.*$)/gm, '<li>$1</li>');
  html = html.replace(/^\s*\d+\. (.*$)/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
  html = html.replace(/_(.*?)_/g, '<em>$1</em>');
  
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  html = html.replace(/^---$/gm, '<hr>');

  const parseTableRow = (line) => {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map(cell => cell.trim());
  };

  const convertTables = (input) => {
    const lines = input.split('\n');
    const output = [];
    const separatorRegex = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const next = lines[i + 1];
      if (line && line.includes('|') && next && separatorRegex.test(next)) {
        const headers = parseTableRow(line);
        const rows = [];
        i += 2;
        for (; i < lines.length; i++) {
          const rowLine = lines[i];
          if (!rowLine || !rowLine.includes('|')) {
            i -= 1;
            break;
          }
          rows.push(parseTableRow(rowLine));
        }
        const thead = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
        const tbody = rows.length
          ? `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`
          : '';
        output.push('', `<table>${thead}${tbody}</table>`, '');
      } else {
        output.push(line);
      }
    }
    return output.join('\n');
  };

  html = convertTables(html);

  html = html.replace(/__CODE_BLOCK_(\d+)__/g, (match, index) => codeBlocks[index]);

  const wrapParagraphs = (input) => {
    const blocks = input.split(/\n{2,}/);
    const wrapped = blocks.map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (/^<(h[1-4]|ul|ol|li|pre|blockquote|table|hr|p)\b/i.test(trimmed)) {
        return trimmed;
      }
      const withBreaks = trimmed.replace(/\n/g, '<br>');
      return `<p>${withBreaks}</p>`;
    });
    return wrapped.filter(Boolean).join('\n\n');
  };

  html = wrapParagraphs(html);

  return `<div class="markdown-body">${html}</div>`;
}

// ... (AI Stream Functions: streamZhipuAI, streamGemini, streamOpenAI, processStream) ...
async function streamZhipuAI({ apiKey, messages, signal }, onChunk) {
  const url = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'glm-4.7', messages: messages, stream: true }),
    signal: signal // 传递信号
  });
  if (!response.ok) throw new Error(`Zhipu API Error: ${response.status}`);
  await processStream(response, onChunk);
}

async function streamGemini({ apiKey, messages, signal }, onChunk) {
  const contents = messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] }));
  const geminiModel = (typeof aiConfig?.geminiModelName === 'string' && aiConfig.geminiModelName.trim())
    ? aiConfig.geminiModelName.trim()
    : 'gemini-3-flash-preview';

  console.log('[Gemini] Configured Model:', geminiModel); // 确认最终使用的模型名

  // 切换回流式调用 (:streamGenerateContent)
  const url = `https://generativelanguage.googleapis.com/v1alpha/models/${geminiModel}:streamGenerateContent?key=${apiKey}`;
  const maskedKey = apiKey ? `****${apiKey.slice(-4)}` : '';
  const safeUrl = `https://generativelanguage.googleapis.com/v1alpha/models/${geminiModel}:streamGenerateContent?key=${maskedKey}`;
  
  console.log('[Gemini] Calling API:', safeUrl);
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: contents }),
      signal: signal
    });

    if (!response.ok) {
      let errorMsg = `Gemini API Error: ${response.status}`;
      try {
        const errorData = await response.json();
        if (errorData.error && errorData.error.message) {
          errorMsg += ` - ${errorData.error.message}`;
        }
        if (errorData.error && errorData.error.code) {
          errorMsg += ` (Code: ${errorData.error.code})`;
        }
        // 特定错误处理
        if (errorData.error && errorData.error.code === 400 && errorData.error.message.includes('User location is not supported')) {
          errorMsg += '\n\n提示: 您的网络位置可能不支持访问 Gemini API，请尝试使用 VPN 或更换网络环境。';
        }
        if (errorData.error && errorData.error.code === 403 && errorData.error.message.includes('API key not valid')) {
          errorMsg += '\n\n提示: 请检查您的 API Key 是否正确配置。';
        }
        if (errorData.error && errorData.error.code === 404 && errorData.error.message.includes('Model not found')) {
          errorMsg += '\n\n提示: 请检查您输入的模型名称是否正确。';
        }
      } catch (e) {
        // 尝试读取原始响应文本
        try {
          const errorText = await response.text();
          errorMsg += ` - ${errorText}`;
        } catch (e2) {}
      }
      throw new Error(errorMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let braceCount = 0;
    let inString = false;
    let escape = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Robust JSON extraction matching { ... } blocks
      // We process the buffer char by char to handle multi-line JSON correctly
      let startIndex = -1;
      
      // We need to restart scanning from the beginning of buffer if we modified it
      // But efficiently, we only need to scan if we are not currently inside a potential block or if we just finished one.
      // However, to keep it simple and robust against buffer shifts, we can scan the whole buffer.
      // Optimization: We only remove processed parts.
      
      let i = 0;
      while (i < buffer.length) {
        const char = buffer[i];
        
        if (!inString) {
          if (char === '{') {
            if (braceCount === 0) startIndex = i;
            braceCount++;
          } else if (char === '}') {
            braceCount--;
            if (braceCount === 0 && startIndex !== -1) {
              // Found a complete JSON object
              const jsonStr = buffer.substring(startIndex, i + 1);
              
              try {
                const json = JSON.parse(jsonStr);
                const candidate = json.candidates?.[0];
                const text = candidate?.content?.parts?.[0]?.text;
                
                if (text) {
                  onChunk(text);
                } else if (candidate?.finishReason === 'STOP' && !text) {
                   // Ignore normal stop
                } else if (candidate?.finishReason) {
                   console.warn('[Gemini Stream] Non-text finish:', candidate.finishReason);
                }
              } catch (e) {
                console.log('[Gemini Stream] Parse error (ignoring):', e);
              }
              
              // Remove processed part from buffer
              buffer = buffer.substring(i + 1);
              i = -1; // Restart loop for new buffer (since indices changed)
              startIndex = -1;
            }
          } else if (char === '"') {
            inString = true;
          }
        } else {
          if (char === '"' && !escape) {
            inString = false;
          } else if (char === '\\') {
            escape = !escape;
          } else {
            escape = false;
          }
        }
        i++;
      }
    }
    
  } catch (error) {
    if (error.name === 'AbortError') {
      throw error;
    }
    throw new Error(`Gemini Request Failed: ${error.message}`);
  }
}

async function streamOpenAI({ apiUrl, apiKey, modelName, messages, signal }, onChunk) {
  const url = apiUrl || 'https://api.openai.com/v1/chat/completions';
  const model = modelName || 'gpt-3.5-turbo';
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model, messages: messages, stream: true }),
    signal: signal // 传递信号
  });
  if (!response.ok) throw new Error(`API Error: ${response.status}`);
  await processStream(response, onChunk, true);
}

async function processStream(response, onChunk, isOpenAI = false) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (trimmed.startsWith('data: ')) {
        try {
          const json = JSON.parse(trimmed.slice(6));
          const content = isOpenAI ? json.choices?.[0]?.delta?.content : json.choices?.[0]?.delta?.content; // Compatible
          if (content) onChunk(content);
        } catch (e) {}
      } else if (!isOpenAI) {
         // Handle Zhipu non-SSE if needed, but Zhipu uses SSE too
      }
    }
  }
}

// ===== UI Helpers =====
function appendUserMessage(text) {
  const div = document.createElement('div');
  div.className = 'message user';
  div.textContent = text;
  document.getElementById('chatMessages').appendChild(div);
  scrollToBottom();
}

function appendAIMessage(text) {
  const id = 'msg-' + Date.now();
  const div = document.createElement('div');
  div.className = 'message ai';
  div.id = id;
  div.innerHTML = `
    <div class="message-content">${text}</div>
    <button class="copy-btn" data-copy-for="${id}">复制</button>
  `;
  document.getElementById('chatMessages').appendChild(div);
  scrollToBottom();
  return id;
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.innerHTML = `<div class="message-content">${text}</div>`;
  document.getElementById('chatMessages').appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  const container = document.getElementById('chatMessages');
  container.scrollTop = container.scrollHeight;
}

function handleCopyClick(e) {
  if (e.target.classList.contains('copy-btn')) {
    const msgId = e.target.dataset.copyFor;
    const msgEl = document.getElementById(msgId);
    if (!msgEl) return;
    const content = msgEl.querySelector('.message-content').innerText;
    
    navigator.clipboard.writeText(content).then(() => {
      const originalText = e.target.textContent;
      e.target.textContent = '已复制';
      setTimeout(() => { e.target.textContent = originalText; }, 2000);
    });
  }
}

function showError(msg) {
  const box = document.getElementById('errorSection');
  document.getElementById('errorContent').textContent = msg;
  box.classList.remove('hidden');
  setTimeout(() => box.classList.add('hidden'), 5000);
}

function checkConfig() {
  const appId = document.getElementById('appId').value;
  if(!appId) { 
    showError('请先在设置中配置 App ID'); 
    toggleModal('settingsModal', true);
    switchTab('tab-feishu');
    return false; 
  }
  return true;
}

// ===== 飞书配置 (复用 loadConfig 等) =====
async function loadConfig() {
  const config = await chrome.storage.local.get(['appId', 'appSecret']);
  if (config.appId) document.getElementById('appId').value = config.appId;
  if (config.appSecret) document.getElementById('appSecret').value = config.appSecret;
}

async function testConnection() {
    const config = await chrome.storage.local.get(['appId', 'appSecret']);
    if (!config.appId) return showError('请先配置 App ID');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const region = tab.url.includes('feishu.cn') ? 'feishu' : 'larksuite';
    const apiEndpoint = region === 'feishu' ? 'https://fsopen.feishu.cn' : 'https://fsopen.bytedance.net';
    
    try {
        const res = await chrome.runtime.sendMessage({
            action: 'testConnection',
            appId: config.appId, appSecret: config.appSecret, region, apiEndpoint
        });
        alert(res.success ? '✅ 连接成功' : '❌ ' + res.error);
    } catch(e) { alert('❌ ' + e.message); }
}

async function testGeminiConnection() {
  const apiKey = document.getElementById('aiApiKey').value.trim();
  const geminiModelName = document.getElementById('geminiModelName').value.trim() || 'gemini-3-flash-preview';
  
  if (!apiKey) {
    alert('请先输入 Gemini API Key');
    return;
  }
  
  const testButton = document.getElementById('testGeminiConnection');
  const originalText = testButton.textContent;
  testButton.textContent = '测试中...';
  testButton.disabled = true;
  
  try {
    // 使用 v1alpha 接口测试连接
    const url = `https://generativelanguage.googleapis.com/v1alpha/models/${geminiModelName}:streamGenerateContent?key=${apiKey}`;
    
    // 使用 AbortController 实现超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }]
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId); // 清除超时
    
    if (response.ok) {
      alert('✅ Gemini 连接成功！\n\n模型: ' + geminiModelName);
    } else {
      let errorMsg = `❌ 连接失败: ${response.status}`;
      try {
        const errorData = await response.json();
        if (errorData.error && errorData.error.message) {
          errorMsg += `\n\n错误信息: ${errorData.error.message}`;
        }
      } catch (e) {}
      alert(errorMsg);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      alert('❌ 连接超时，请检查网络连接后重试');
    } else {
      alert(`❌ 连接失败: ${error.message}`);
    }
  } finally {
    testButton.textContent = originalText;
    testButton.disabled = false;
  }
}

async function getDocumentIdFromTab(tab) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const path = window.location.pathname;
        const pathMatch = path.match(/\/(docx|docs|wiki|note|slides|sheets|bitable)\/([a-zA-Z0-9_-]+)/);
        if (pathMatch) return { type: pathMatch[1], documentId: pathMatch[2] };
        if (window.__doc_id__) return { type: 'docx', documentId: window.__doc_id__ }; // 默认 docx
        return null;
      }
    });
    return results[0]?.result;
}

async function startAuthorization() {
    const config = await chrome.storage.local.get(['appId']);
    if (!config.appId) return alert('请先配置 App ID');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const region = tab.url.includes('feishu.cn') ? 'feishu' : 'larksuite';
    try {
        await chrome.runtime.sendMessage({ action: 'getAuthUrl', region });
    } catch (e) { alert(e.message); }
}

async function logout() {
    await chrome.storage.local.remove(['userToken']);
    checkAuthStatus();
}

async function checkAuthStatus() {
    const storage = await chrome.storage.local.get(['userToken', 'oauthError']);
    
    // UI Elements
    const authorizeBtn = document.getElementById('authorizeBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const authIndicator = document.getElementById('authIndicator');
    const authStatusText = document.getElementById('authStatusText');

    if (storage.oauthError) {
        showError(storage.oauthError);
        // Clear error after showing so it doesn't persist forever
        chrome.storage.local.remove(['oauthError']);
    }

    if (storage.userToken) {
        // 已授权状态
        const userName = storage.userToken.user ? storage.userToken.user.name : '用户';
        
        if (authStatusText) {
            authStatusText.textContent = `已授权 (${userName})`;
            authStatusText.style.color = '#52c41a';
        }
        
        if (authIndicator) {
            authIndicator.classList.add('active');
        }
        
        if (authorizeBtn) {
            authorizeBtn.classList.add('hidden');
        }
        
        if (logoutBtn) {
            logoutBtn.classList.remove('hidden');
        }
    } else {
        // 未授权状态
        if (authStatusText) {
            authStatusText.textContent = '未授权';
            authStatusText.style.color = '#666';
        }
        
        if (authIndicator) {
            authIndicator.classList.remove('active');
        }
        
        if (authorizeBtn) {
            authorizeBtn.classList.remove('hidden');
            authorizeBtn.textContent = '去授权';
            authorizeBtn.disabled = false;
        }
        
        if (logoutBtn) {
            logoutBtn.classList.add('hidden');
        }
    }
}

function toggleModal(id, show) {
  document.getElementById(id).classList.toggle('hidden', !show);
  // Reset tab to AI when opening
  if(show) switchTab('tab-ai');
}

function downloadMarkdown() {
  if (!documentContent) return;
  
  // 获取对话记录并格式化为表格
  const chatTable = generateChatTable();
  
  // 获取文档URL
  let docUrl = '';
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]) {
      docUrl = tabs[0].url;
      
      // 构建文件内容
      let fileContent = '';
      
      // 在顶部添加文档URL
      if (docUrl) {
        fileContent += `# 文档信息\n\n`;
        fileContent += `## 文档链接\n`;
        fileContent += `${docUrl}\n\n`;
      }
      
      // 提取并添加图片URL
      const imageUrls = extractImageUrls(documentContent);
      if (imageUrls.length > 0) {
        fileContent += `## 图片链接\n`;
        imageUrls.forEach((url, index) => {
          fileContent += `${index + 1}. ${url}\n`;
        });
        fileContent += '\n';
      }
      
      // 添加对话记录表格
      fileContent += chatTable + '\n\n';
      
      // 添加文档内容
      fileContent += documentContent;
      
      // 生成文件名，使用文档ID或时间戳确保唯一性
      let fileName = `feishu_doc`;
      if (documentRawData && documentRawData.documentId) {
        fileName = `feishu_doc_${documentRawData.documentId}`;
      } else {
        fileName = `feishu_doc_${Date.now()}`;
      }
      fileName += '.md';
      
      // 创建Blob对象
      const blob = new Blob([fileContent], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      
      // 检查是否设置了保存文件夹
      if (downloadConfig.saveFolder) {
        // 尝试使用Chrome的downloads API直接保存到指定路径
        // 注意：Chrome扩展的downloads API的filename参数只能是相对路径，不能是绝对路径
        // 但是我们可以尝试使用相对路径，并在下载开始后修改路径
        
        // 注册下载文件名确定事件监听器
        chrome.downloads.onDeterminingFilename.addListener(function onDeterminingFilename(item, suggest) {
          if (item.url === url) {
            // 构建完整的文件路径
            const fullPath = downloadConfig.saveFolder + '/' + fileName;
            suggest({
              filename: fullPath,
              conflictAction: downloadConfig.overwriteExisting ? 'overwrite' : 'uniquify'
            });
            // 移除监听器
            chrome.downloads.onDeterminingFilename.removeListener(onDeterminingFilename);
          }
        });
        
        // 开始下载
        chrome.downloads.download({
          url: url,
          filename: fileName, // 只使用文件名，不包含路径
          saveAs: false, // 不显示保存对话框
          conflictAction: downloadConfig.overwriteExisting ? 'overwrite' : 'uniquify'
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error('下载失败:', chrome.runtime.lastError);
            showError('下载失败: ' + chrome.runtime.lastError.message);
          } else {
            console.log('下载开始，ID:', downloadId);
            showError('文件正在下载到: ' + downloadConfig.saveFolder);
          }
        });
      } else {
        // 如果没有设置保存文件夹，显示保存对话框
        chrome.downloads.download({
          url: url,
          filename: fileName, // 只使用文件名，不包含路径
          saveAs: true, // 显示保存对话框，让用户选择保存位置
          conflictAction: downloadConfig.overwriteExisting ? 'overwrite' : 'uniquify'
        }, (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error('下载失败:', chrome.runtime.lastError);
            showError('下载失败: ' + chrome.runtime.lastError.message);
          } else {
            console.log('下载开始，ID:', downloadId);
            showError('下载开始，请在弹出的对话框中选择保存位置');
          }
        });
      }
    }
  });
}

function extractImageUrls(content) {
  if (!content) return [];
  
  // 正则表达式匹配Markdown中的图片格式：![alt text](image url)
  const imageRegex = /!\[.*?\]\((.*?)\)/g;
  const urls = [];
  let match;
  
  while ((match = imageRegex.exec(content)) !== null) {
    urls.push(match[1]);
  }
  
  return urls;
}

function generateChatTable() {
  const messages = document.querySelectorAll('#chatMessages .message');
  if (messages.length <= 1) { // 只有系统欢迎消息
    return `## 对话记录\n\n| 时间 | 角色 | 内容 |\n|------|------|------|\n| ${new Date().toLocaleString()} | 系统 | 无对话记录 |`;
  }
  
  let table = `## 对话记录\n\n| 时间 | 角色 | 内容 |\n|------|------|------|`;
  
  messages.forEach((message, index) => {
    if (index === 0) return; // 跳过系统欢迎消息
    
    const role = message.classList.contains('user') ? '用户' : 'AI';
    // 获取消息内容，优先从message-content元素获取
    const contentElement = message.querySelector('.message-content');
    let content = contentElement ? contentElement.textContent.trim() : message.textContent.trim();
    // 替换换行符为空格，保持表格美观
    content = content.replace(/\n/g, ' ');
    // 限制内容长度，确保表格不会过长
    if (content.length > 200) {
      content = content.substring(0, 200) + '...';
    }
    const time = new Date().toLocaleString();
    
    table += `\n| ${time} | ${role} | ${content} |`;
  });
  
  return table;
}

function handleStorageChange(changes, namespace) {
    if (namespace === 'local') {
        if (changes.userToken) checkAuthStatus();
        if (changes.selectedText) {
            updateSelectionUI(changes.selectedText.newValue);
        }
    }
}

function handleRuntimeMessage(request) {
    if (request.action === 'authSuccess') checkAuthStatus();
}
