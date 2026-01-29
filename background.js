// 飞书文档读取器 - Background Service Worker
// 修复：使用正确的 docs API

// ===== 初始化 =====
chrome.runtime.onInstalled.addListener(() => {
  // 设置点击图标打开侧边栏
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
});

// ===== API 配置 =====
const API_ENDPOINTS = {
  'feishu.cn': 'https://fsopen.feishu.cn',           // 使用 fsopen
  'larksuite.com': 'https://fsopen.bytedance.net',    // 字节跳动的统一域名
  'larkoffice.com': 'https://fsopen.bytedance.net'   // 字节跳动的统一域名
};

// 重定向 URL 配置 - 必须与飞书开放平台后台配置一致
const REDIRECT_URI = 'https://forlark.zeabur.app/callback.html';
// 如果您在飞书后台配置的是 localhost，请取消注释下一行并注释掉上一行
// const REDIRECT_URI = 'http://localhost:8080/callback';

// ===== Token 缓存 =====
const tenantTokens = {};
const tokenExpireTimes = {};
const processingOauthTabs = new Set(); // 防止重复处理

// ===== 监听消息 =====
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Background] 收到消息:', request.action);

  if (request.action === 'oauthCallback') {
    handleContentScriptCallback(request, sender).then(sendResponse);
    return true;
  }

  if (request.action === 'testConnection') {
    testConnection(request).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === 'getAuthUrl') {
    getAuthUrl(request).then(sendResponse).catch(e => sendResponse({ error: e.message }));
    return true;
  }

  if (request.action === 'fetchDocument') {
    fetchDocumentContent(request).then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  return false;
});

async function handleContentScriptCallback(request, sender) {
  const { code, state, error } = request;
  const tabId = sender.tab?.id;
  
  // 防止重复处理
  if (tabId && processingOauthTabs.has(tabId)) return { success: true, message: 'Processing' };
  if (tabId) processingOauthTabs.add(tabId);
  
  // 停止轮询（既然 Content Script 已经触发了）
  stopPolling();

  try {
    if (error) {
      console.error('[OAuth] 授权过程返回错误 (ContentScript):', error);
      await chrome.storage.local.set({ oauthError: `授权被拒绝: ${error}` });
      if (tabId) processingOauthTabs.delete(tabId);
      return { success: false, error };
    }

    if (code) {
      console.log('[OAuth] ContentScript 捕获授权码:', code.substring(0, 10) + '...');
      
      // 清除之前的错误
      await chrome.storage.local.remove(['oauthError']);

      const storedData = await chrome.storage.local.get(['oauthRegion']);
      const region = storedData.oauthRegion || 'larksuite';
      
      console.log('[OAuth] 开始交换 Token (ContentScript触发)，区域:', region);
      
      // 异步执行 Token 交换
      handleOAuthCallback({ code, state, region })
        .then(() => {
          console.log('[OAuth] 流程完成，关闭授权页面');
          if (tabId) chrome.tabs.remove(tabId).catch(() => {});
          chrome.runtime.sendMessage({ action: 'authSuccess' }).catch(() => {});
        })
        .catch(async (err) => {
          console.error('[OAuth] Token 交换失败:', err);
          await chrome.storage.local.set({ oauthError: `Token 交换失败: ${err.message}` });
          if (tabId) chrome.tabs.remove(tabId).catch(() => {});
        })
        .finally(() => {
          if (tabId) processingOauthTabs.delete(tabId);
        });
      
      return { success: true, message: 'Token exchange started' };
    }
  } catch (e) {
    console.error('[OAuth] 处理 ContentScript 回调出错:', e);
    if (tabId) processingOauthTabs.delete(tabId);
    return { success: false, error: e.message };
  }
}

// ===== 监听 OAuth 回调 =====
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 检查 URL 是否包含我们的重定向地址
  if (tab.url && (tab.url.includes('forlark.zeabur.app/callback.html') || tab.url.includes('localhost:8080/callback') || (tab.url.includes('github.io') && tab.url.includes('/callback.html')))) {
    console.log('[OAuth] onUpdated 检测到回调 URL:', tab.url);
    // 使用统一的处理逻辑
    handleCallbackTab(tabId, tab.url);
  }
});

// ===== 测试连接 =====
async function testConnection(request) {
  const { appId, appSecret, apiEndpoint } = request;

  try {
    const response = await fetch(`${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret })
    });

    const data = await response.json();

    if (data.code !== 0) {
      return { success: false, error: `认证失败: ${data.msg} (code: ${data.code})` };
    }

    return { success: true, message: '连接成功' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ===== OAuth 授权 =====
function generateState() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// ===== 全局变量 =====
let pollingInterval = null;
const POLLING_TIMEOUT = 300000; // 5分钟超时

async function getAuthUrl(request) {
  const { region } = request;
  const config = await chrome.storage.local.get(['appId']);

  if (!config.appId) {
    throw new Error('请先配置 App ID');
  }

  const apiEndpoint = API_ENDPOINTS[region === 'feishu' ? 'feishu.cn' : 'larksuite.com'];
  const state = generateState();

  await chrome.storage.local.set({ oauthState: state, oauthRegion: region });

  const authUrl = `${apiEndpoint}/open-apis/authen/v1/authorize` +
    `?app_id=${config.appId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent('docs:document.content:read docs:document.comment:read')}` +
    `&state=${state}`;

  console.log('[OAuth] 生成授权 URL:', authUrl);
  console.log('[OAuth] 使用重定向 URI:', REDIRECT_URI);
  
  chrome.tabs.create({ url: authUrl });

  // 启动轮询检查
  startPolling();

  return { success: true, message: '请在打开的窗口中完成授权' };
}

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  console.log('[OAuth] 启动轮询检查...');
  
  const startTime = Date.now();
  
  pollingInterval = setInterval(async () => {
    if (Date.now() - startTime > POLLING_TIMEOUT) {
      stopPolling();
      console.log('[OAuth] 轮询超时，停止检查');
      return;
    }

    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.url && (tab.url.includes('forlark.zeabur.app/callback.html') || tab.url.includes('localhost:8080/callback') || (tab.url.includes('github.io') && tab.url.includes('/callback.html')))) {
          console.log('[OAuth] 轮询发现回调 Tab:', tab.id, tab.url);
          // 触发处理逻辑
          handleCallbackTab(tab.id, tab.url);
        }
      }
    } catch (e) {
      console.error('[OAuth] 轮询出错:', e);
    }
  }, 1000); // 每秒检查一次
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('[OAuth] 停止轮询');
  }
}

// 提取公共处理逻辑
async function handleCallbackTab(tabId, url) {
  // 防止重复处理
  if (processingOauthTabs.has(tabId)) return;
  processingOauthTabs.add(tabId);
  
  // 找到后立即停止轮询
  stopPolling();

  try {
    const urlObj = new URL(url);
    const code = urlObj.searchParams.get('code');
    const state = urlObj.searchParams.get('state');
    const error = urlObj.searchParams.get('error');

    if (error) {
      console.error('[OAuth] 授权过程返回错误:', error);
      await chrome.storage.local.set({ oauthError: `授权被拒绝: ${error}` });
      processingOauthTabs.delete(tabId);
      return;
    }

    if (code) {
      console.log('[OAuth] 成功获取授权码 (Code):', code.substring(0, 10) + '...');
      
      // 清除之前的错误
      await chrome.storage.local.remove(['oauthError']);

      const storedData = await chrome.storage.local.get(['oauthRegion']);
      const region = storedData.oauthRegion || 'larksuite';
      
      console.log('[OAuth] 开始交换 Token，区域:', region);
      try {
        await handleOAuthCallback({ code, state, region });
        // 授权成功后再关闭页面
        console.log('[OAuth] 流程完成，关闭授权页面');
        chrome.tabs.remove(tabId).catch(() => {});
        
        // 发送通知给 popup（如果它是打开的）
        chrome.runtime.sendMessage({ action: 'authSuccess' }).catch(() => {});
      } catch (error) {
        console.error('[OAuth] Token 交换失败:', error);
        await chrome.storage.local.set({ oauthError: `Token 交换失败: ${error.message}` });
        chrome.tabs.remove(tabId).catch(() => {});
      } finally {
        processingOauthTabs.delete(tabId);
      }
    }
  } catch (e) {
    console.error('[OAuth] 处理回调逻辑出错:', e);
    await chrome.storage.local.set({ oauthError: `处理回调出错: ${e.message}` });
    processingOauthTabs.delete(tabId);
  }
}

async function handleOAuthCallback(request) {
  const { code, state, region } = request;

  const storedData = await chrome.storage.local.get(['oauthState', 'appId', 'appSecret']);
  
  console.log('[OAuth] 验证 State...');
  if (state !== storedData.oauthState) {
    console.error('[OAuth] State 不匹配:', { received: state, stored: storedData.oauthState });
    throw new Error('State 验证失败');
  }

  const apiEndpoint = API_ENDPOINTS[region === 'feishu' ? 'feishu.cn' : 'larksuite.com'];

  // 获取 tenant token
  console.log('[OAuth] 1. 获取 Tenant Access Token...');
  const tenantRes = await fetch(`${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: storedData.appId,
      app_secret: storedData.appSecret
    })
  });
  const tenantData = await tenantRes.json();
  if (tenantData.code !== 0) {
    console.error('[OAuth] 获取 Tenant Token 失败:', tenantData);
    throw new Error(`获取应用令牌失败: ${tenantData.msg}`);
  }

  // 获取 user token
  console.log('[OAuth] 2. 交换 User Access Token...');
  console.log('[OAuth] 交换参数:', {
    grant_type: 'authorization_code',
    client_id: storedData.appId,
    redirect_uri: REDIRECT_URI,
    code: code.substring(0, 5) + '...'
  });

  const userRes = await fetch(`${apiEndpoint}/open-apis/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tenantData.tenant_access_token}`
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: storedData.appId,
      client_secret: storedData.appSecret,
      code: code,
      redirect_uri: REDIRECT_URI
    })
  });
  
  const userData = await userRes.json();
  if (userData.code !== 0) {
    console.error('[OAuth] 获取 User Token 失败:', userData);
    throw new Error(`获取用户令牌失败: ${userData.msg} (Code: ${userData.code})`);
  }

  // 获取用户信息
  console.log('[OAuth] 3. 获取用户信息...');
  // 注意：userData.data 才是包含 token 的对象
  const tokenInfo = userData.data;
  
  const infoRes = await fetch(`${apiEndpoint}/open-apis/authen/v1/user_info`, {
    headers: { 'Authorization': `Bearer ${tokenInfo.access_token}` }
  });
  const infoData = await infoRes.json();
  
  if (infoData.code !== 0) {
    console.warn('[OAuth] 获取用户信息失败 (非致命):', infoData.msg);
  }

  // 存储用户令牌
  console.log('[OAuth] 4. 存储 Token 到本地存储...');
  const expiresAt = Date.now() + (tokenInfo.expires_in || 7200) * 1000;
  
  await chrome.storage.local.set({
    userToken: {
      accessToken: tokenInfo.access_token,
      refreshToken: tokenInfo.refresh_token,
      expiresAt: expiresAt,
      region: region,
      tokenType: 'user',
      user: infoData.code === 0 && infoData.data ? {
        name: infoData.data.name,
        email: infoData.data.email,
        userId: infoData.data.user_id
      } : null
    }
  });

  console.log('[OAuth] 授权流程全部完成！');
}

// ===== 刷新用户 Token =====
async function refreshTokenUserToken(appId, appSecret, refreshToken, region) {
  const apiEndpoint = API_ENDPOINTS[region] || API_ENDPOINTS['feishu.cn'];
  console.log('[Refresh] 正在刷新 User Token...');
  
  const response = await fetch(`${apiEndpoint}/open-apis/authen/v1/refresh_access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${await getTenantAccessToken(appId, appSecret, region)}`
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });
  
  const data = await response.json();
  if (data.code !== 0) {
    console.error('[Refresh] 刷新失败:', data);
    throw new Error(`刷新 Token 失败: ${data.msg}`);
  }
  
  // 更新存储
  const tokenData = data.data;
  const expiresAt = Date.now() + (tokenData.expires_in || 7200) * 1000;
  
  // 获取现有用户信息
  const stored = await chrome.storage.local.get(['userToken']);
  const currentUser = stored.userToken?.user;
  
  const newTokenInfo = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: expiresAt,
    region: region,
    tokenType: 'user',
    user: currentUser
  };
  
  await chrome.storage.local.set({ userToken: newTokenInfo });
  console.log('[Refresh] 刷新成功，新 Token 已保存');
  
  return tokenData.access_token;
}

// ===== 获取应用令牌 =====
async function getTenantAccessToken(appId, appSecret, region) {
  const cacheKey = region;
  if (tenantTokens[cacheKey] && tokenExpireTimes[cacheKey] && Date.now() < tokenExpireTimes[cacheKey]) {
    return tenantTokens[cacheKey];
  }

  // 使用正确的 fsopen 域名
  const apiEndpoint = API_ENDPOINTS[region];

  const response = await fetch(`${apiEndpoint}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`获取应用令牌失败: ${data.msg}`);
  }

  tenantTokens[cacheKey] = data.tenant_access_token;
  tokenExpireTimes[cacheKey] = Date.now() + (data.expire - 300) * 1000;

  return data.tenant_access_token;
}

// ===== 获取 Wiki 文档的真实 token =====
async function getWikiDocToken(nodeToken, spaceId, token, apiEndpoint) {
  try {
    // 调用 Wiki API 获取节点信息（使用飞书文档推荐的端点）
    const wikiUrl = `${apiEndpoint}/open-apis/wiki/v2/spaces/get_node`;
    const params = new URLSearchParams({
      token: nodeToken
    });
    console.log('[Wiki] 请求:', wikiUrl, '参数:', params.toString());

    const response = await fetch(`${wikiUrl}?${params}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    console.log('[Wiki] 响应:', data);

    if (data.code === 0 && data.data) {
      // 飞书 Wiki API get_node 的返回结构是 data.node
      const node = data.data.node || data.data;
      return {
        objToken: node.obj_token,
        objType: node.obj_type,
        title: node.title
      };
    }

    throw new Error(`获取 Wiki 节点失败: ${data.msg}`);
  } catch (error) {
    console.error('[Wiki] 错误:', error);
    throw error;
  }
}

// 解析富文本内容
function parseRichText(content) {
  if (!content) return '';
  
  // 1. 处理 JSON 字符串的情况
  let contentObj = content;
  if (typeof content === 'string') {
    // 如果是纯文本且不以 { 开头，可能就是普通文本
    if (!content.trim().startsWith('{')) {
        return content;
    }
    try {
      contentObj = JSON.parse(content);
    } catch (e) {
      // 解析失败，直接返回原字符串
      return content;
    }
  }

  // 2. 检查 elements 数组
  if (!contentObj || !contentObj.elements) {
      // 尝试直接获取 text 字段（某些旧接口）
      if (contentObj.text) return contentObj.text;
      return '';
  }
  
  return contentObj.elements.map(el => {
    switch (el.type) {
      case 'text_run':
        return el.text_run?.text || '';
      case 'person':
        return `@${el.person?.name || 'User'} `; // @某人
      case 'docs_link':
        return `[${el.docs_link?.title || 'Link'}](${el.docs_link?.url}) `; // 文档链接
      case 'img': // 图片
        return '[图片] ';
      case 'file': // 文件附件
        return `[文件: ${el.file?.title || 'Attachment'}] `;
      case 'media': // 媒体
        return '[媒体] ';
      case 'equation': // 公式
        return '[公式] ';
      case 'reminder': // 提醒
        return `[提醒: ${el.reminder?.create_time || ''}] `;
      default:
        // 尝试兜底获取 text 属性
        return el.text_run?.text || '';
    }
  }).join('');
}

// ===== 获取文档评论 =====
async function fetchComments(fileToken, fileType, token, apiEndpoint) {
  try {
    console.log('[Comments] 开始获取评论:', fileToken, fileType);
    
    let allComments = [];
    let pageToken = '';
    let hasMore = true;
    
    // 循环分页获取
    while (hasMore) {
      // 构建请求 URL
      const url = `${apiEndpoint}/open-apis/drive/v1/files/${fileToken}/comments`;
      const params = new URLSearchParams({
        file_type: fileType,
        page_size: 100 // 每次获取100条
      });
      
      if (pageToken) {
        params.append('page_token', pageToken);
      }

      const response = await fetch(`${url}?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      
      if (data.code !== 0) {
        console.warn('[Comments] 获取评论失败:', data.msg);
        break; // 出错则停止
      }

      const items = data.data?.items || [];
      allComments = allComments.concat(items);
      
      hasMore = data.data?.has_more;
      pageToken = data.data?.page_token;
      
      console.log(`[Comments] 本页获取 ${items.length} 条，总计 ${allComments.length} 条`);
      
      // 安全限制：防止无限循环或内存过大
      if (allComments.length >= 1000) {
        console.warn('[Comments] 达到评论数限制 (1000)，停止获取');
        break;
      }
    }

    // 增加调试日志
    console.log('[Comments] 获取完成，共:', allComments.length);
    if (allComments.length > 0) {
        console.log('[Comments] 第一条评论示例:', JSON.stringify(allComments[0]));
    }
    return allComments;
  } catch (error) {
    console.error('[Comments] 请求出错:', error);
    return [];
  }
}

// 格式化评论为 Markdown
function formatComments(comments) {
  if (!comments || comments.length === 0) return '';

  let md = '\n\n---\n### 📝 文档评论\n\n';
  
  comments.forEach((comment, index) => {
    // 获取引用文本 (quote)
    const quote = comment.quote || '（无引用文本）';
    
    // 获取评论者 ID
    const userId = comment.user_id || '未知ID';
    
    // 解析评论内容
    // 注意：顶层评论可能没有 content，只有 reply_list（第一条回复即为主评论内容）
    let content = '';
    const replies = comment.reply_list?.replies || comment.replies || [];
    
    // 尝试从顶层 content 获取（如果有）
    if (comment.content) {
        content = parseRichText(comment.content);
    } 
    // 如果顶层没有 content，尝试使用第一条回复作为主评论内容
    else if (replies.length > 0) {
        content = parseRichText(replies[0].content);
    }

    if (!content) content = '（无内容）';
    
    md += `> **引用**: ${quote}\n\n`;
    md += `**评论 ${index + 1} (用户: ${userId})**: ${content}\n`;
    
    // 处理回复（从第二条开始，或者全部列出）
    let replyStartIndex = 0;
    if (!comment.content && replies.length > 0) {
        replyStartIndex = 1;
    }
    
    if (replies.length > replyStartIndex) {
      md += `\n*回复 (${replies.length - replyStartIndex})*:\n`;
      for (let i = replyStartIndex; i < replies.length; i++) {
        const reply = replies[i];
        let replyContent = parseRichText(reply.content);
        const replyUserId = reply.user_id || '未知ID';
        
        if (!replyContent) replyContent = '（无内容）';
        md += `- **用户 ${replyUserId}**: ${replyContent}\n`;
      }
    }
    md += '\n---\n';
  });

  return md;
}

// ===== 获取文档内容 - 智能判断文档类型 =====
async function fetchDocumentContent(request) {
  const { documentId, appId, appSecret, domain, docType: requestDocType } = request;

  try {
    // 判断区域和API端点
    let region = 'feishu';
    let apiEndpoint = API_ENDPOINTS['feishu.cn'];

    if (domain && domain.includes('larksuite.com')) {
      region = 'larksuite';
      apiEndpoint = API_ENDPOINTS['larksuite.com'];
    } else if (domain && domain.includes('larkoffice.com')) {
      region = 'larkoffice';
      apiEndpoint = API_ENDPOINTS['larkoffice.com'];
    }

    console.log('[Fetch] 区域:', region, 'API:', apiEndpoint);
    console.log('[Fetch] 原始文档ID:', documentId);

    // 选择令牌：优先用户令牌
    let token;
    let tokenType = 'tenant';

    const tokenInfo = await chrome.storage.local.get(['userToken']);
    if (tokenInfo.userToken && tokenInfo.userToken.accessToken) {
      const isExpired = Date.now() >= (tokenInfo.userToken.expiresAt || 0) - 60000;
      
      if (!isExpired) {
        // 未过期，直接使用
        token = tokenInfo.userToken.accessToken;
        tokenType = 'user';
        console.log('[Fetch] 使用用户令牌');
      } else if (tokenInfo.userToken.refreshToken) {
        // 已过期但有 refresh_token，尝试刷新
        try {
          console.log('[Fetch] 用户令牌已过期，尝试刷新...');
          token = await refreshTokenUserToken(appId, appSecret, tokenInfo.userToken.refreshToken, region);
          tokenType = 'user';
          console.log('[Fetch] 刷新成功，使用新用户令牌');
        } catch (e) {
          console.warn('[Fetch] 刷新用户令牌失败:', e.message);
          // 刷新失败，降级到应用令牌
        }
      }
    }

    if (!token) {
      token = await getTenantAccessToken(appId, appSecret, region);
      console.log('[Fetch] 使用应用令牌');
    }

    // ===== 判断文档类型 =====
    let finalDocId = documentId;
    let docType = 'docx';

    // 优先使用前端传入的类型（如果有）
    if (requestDocType) {
        // 映射 URL 类型到 API 类型
        if (requestDocType === 'docs') docType = 'doc';
        else if (requestDocType === 'sheets') docType = 'sheet';
        else if (requestDocType === 'bitable') docType = 'bitable'; // 注意：API 可能不支持
        else docType = requestDocType;
    }

    // 检查是否是 Wiki 文档
    if (domain && domain.includes('/wiki/')) {
      console.log('[Fetch] 检测到 Wiki 文档，需要获取真实 token');

      // 获取 Wiki 节点信息（使用飞书文档推荐的 API）
      const wikiInfo = await getWikiDocToken(documentId, null, token, apiEndpoint);
      finalDocId = wikiInfo.objToken;
      docType = wikiInfo.objType || 'docx';

      console.log('[Fetch] Wiki 转换结果:');
      console.log('  node_token:', documentId);
      console.log('  obj_token:', finalDocId);
      console.log('  obj_type:', docType);
    }

    // ===== 使用 docs API 获取内容 =====
    const contentUrl = `${apiEndpoint}/open-apis/docs/v1/content`;

    const params = new URLSearchParams({
      content_type: 'markdown',
      doc_token: finalDocId,
      doc_type: docType
    });

    console.log('[Fetch] 最终请求:', contentUrl);
    console.log('[Fetch] 参数:', {
      content_type: 'markdown',
      doc_token: finalDocId.substring(0, 20) + '...',
      doc_type: docType
    });

    const response = await fetch(`${contentUrl}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    console.log('[Fetch] 响应码:', data.code);

    if (data.code !== 0) {
      let errorMsg = `获取文档失败: ${data.msg} (code: ${data.code})`;

      if (data.code === 1770032 || data.code === 99991663) {
        errorMsg += '\n\n【权限不足】\n\n';
        errorMsg += '解决方案：\n';
        errorMsg += '1. 确认应用已添加权限: docs:document.content:read\n';
        errorMsg += '2. 使用用户令牌（tenant_access_token 只能访问公开文档）\n';
        errorMsg += '3. 在文档中添加应用权限：「...」→「...更多」→「添加文档应用」';
      } else if (data.code === 1770002) {
        errorMsg += '\n\n【文档不存在】\n\n';
        if (domain && domain.includes('/wiki/')) {
          errorMsg += 'Wiki 文档说明：\n';
          errorMsg += '• 确认 Wiki 文档存在\n';
          errorMsg += '• 确认应用有 Wiki 节点阅读权限\n';
          errorMsg += '• 确认 space_id 正确\n';
        } else {
          errorMsg += `提取的 doc_token: ${finalDocId}\n`;
        }
      }

      throw new Error(errorMsg);
    }

    console.log('[Fetch] 获取成功');

    // ===== 并行获取评论 =====
    let fullContent = data.data?.content || '文档内容为空';
    
    // 只有当文档内容获取成功时，才尝试获取评论
    // 注意：评论 API 需要单独的权限，如果没有权限，fetchComments 会优雅地返回空数组
    const comments = await fetchComments(finalDocId, docType, token, apiEndpoint);
    
    if (comments.length > 0) {
      const commentsMd = formatComments(comments);
      console.log('[Fetch] 格式化后的评论 MD:', commentsMd);
      // 将评论插入到文档头部
      fullContent = commentsMd + fullContent;
      console.log('[Fetch] 已合并评论到文档头部');
    } else {
      console.log('[Fetch] 无评论或获取评论失败');
    }

    // 关键修复：确保返回的是合并后的 fullContent
    return {
      success: true,
      documentId: finalDocId,
      content: fullContent, // 确保这里使用的是合并了评论的 fullContent
      region: region,
      tokenType: tokenType,
      docType: docType
    };

  } catch (error) {
    console.error('[Fetch] 失败:', error);
    return { success: false, error: error.message };
  }
}

console.log('[Background] 飞书文档读取器已加载 - 支持 Wiki 文档');

