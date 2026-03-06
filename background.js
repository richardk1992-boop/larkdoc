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

// ===== Blocks API 辅助函数 =====

// 根据 block_type 获取块的内容对象（不同类型块的内容字段名不同）
function getBlockContent(block) {
  switch (block.block_type) {
    case 1:  return block.page;
    case 2:  return block.text;
    case 3:  return block.heading1;
    case 4:  return block.heading2;
    case 5:  return block.heading3;
    case 6:  return block.heading4;
    case 7:  return block.heading5;
    case 8:  return block.heading6;
    case 9:  return block.heading7;
    case 10: return block.heading8;
    case 11: return block.heading9;
    case 12: return block.bullet;
    case 13: return block.ordered;
    case 14: return block.code;
    case 15: return block.quote;
    case 16: return block.equation;
    case 17: return block.todo;
    case 18: return block.bitable;
    case 19: return block.callout;
    case 27: return block.image;
    case 30: return block.sheet;
    case 31: return block.table;
    case 32: return block.table_cell;
    default: return block.text; // 兜底尝试 text
  }
}

// 代码块语言枚举映射
const CODE_LANGUAGES = {
  1: 'plaintext', 2: 'abap', 3: 'ada', 4: 'apache', 5: 'apex',
  6: 'assembly', 7: 'bash', 8: 'basic', 9: 'bnf', 10: 'c',
  11: 'clojure', 12: 'cmake', 13: 'coffeescript', 14: 'cpp', 15: 'csharp',
  16: 'css', 17: 'dart', 18: 'd', 19: 'delphi', 20: 'django',
  21: 'dockerfile', 22: 'elixir', 23: 'elm', 24: 'erlang', 25: 'excel',
  26: 'fortran', 27: 'fsharp', 28: 'gherkin', 29: 'glsl', 30: 'go',
  31: 'graphql', 32: 'groovy', 33: 'haskell', 34: 'html', 35: 'http',
  36: 'ini', 37: 'java', 38: 'javascript', 39: 'json', 40: 'julia',
  41: 'kotlin', 42: 'latex', 43: 'less', 44: 'lisp', 45: 'logo',
  46: 'lua', 47: 'makefile', 48: 'markdown', 49: 'matlab', 50: 'nginx',
  51: 'nim', 52: 'objectivec', 53: 'ocaml', 54: 'pascal', 55: 'perl',
  56: 'php', 57: 'powershell', 58: 'prolog', 59: 'protobuf', 60: 'python',
  61: 'r', 62: 'ruby', 63: 'rust', 64: 'scala', 65: 'scheme',
  66: 'scss', 67: 'shell', 68: 'sql', 69: 'swift', 70: 'tcl',
  71: 'thrift', 72: 'typescript', 73: 'vbnet', 74: 'verilog', 75: 'vhdl',
  76: 'visual-basic', 77: 'vue', 78: 'wasm', 79: 'xml', 80: 'yaml',
  81: 'zig'
};

// 获取代码语言名称
function getCodeLanguageName(langId) {
  return CODE_LANGUAGES[langId] || '';
}

// 将文本元素数组转换为带格式的 Markdown 文本
function renderTextElements(elements) {
  if (!elements || elements.length === 0) return '';

  return elements.map(el => {
    // 文本运行（带样式）
    if (el.text_run) {
      let text = el.text_run.content || '';
      if (!text) return '';
      const style = el.text_run.text_element_style || {};

      // inline_code 优先且互斥
      if (style.inline_code) {
        text = '`' + text + '`';
      } else {
        // 按嵌套顺序应用样式：strikethrough → bold → italic
        if (style.strikethrough) text = '~~' + text + '~~';
        if (style.bold) text = '**' + text + '**';
        if (style.italic) text = '*' + text + '*';
        // underline 无标准 markdown，使用 HTML
        if (style.underline) text = '<u>' + text + '</u>';
      }

      // 链接包裹最外层
      if (style.link && style.link.url) {
        let url = style.link.url;
        try { url = decodeURIComponent(url); } catch (e) { /* keep original */ }
        text = '[' + text + '](' + url + ')';
      }

      return text;
    }

    // 文档提及
    if (el.mention_doc) {
      const title = el.mention_doc.title || '文档';
      const url = el.mention_doc.url || '';
      return url ? `[${title}](${url})` : title;
    }

    // 用户提及
    if (el.mention_user) {
      return `@${el.mention_user.user_id || 'user'}`;
    }

    // 公式（LaTeX）
    if (el.equation) {
      return '$' + (el.equation.content || '') + '$';
    }

    // 文件
    if (el.file) {
      return `[文件: ${el.file.name || '附件'}]`;
    }

    // 提醒
    if (el.reminder) {
      return '[提醒]';
    }

    return '';
  }).join('');
}

// 递归收集某个块的所有子孙 block_id
function collectDescendantIds(blockId, blockMap, ids) {
  ids.add(blockId);
  const block = blockMap.get(blockId);
  if (block && block.children) {
    block.children.forEach(childId => {
      collectDescendantIds(childId, blockMap, ids);
    });
  }
}

// 递归渲染一个块及其所有子孙的文本内容（用于表格单元格等场景）
function renderBlockRecursive(block, blockMap) {
  if (!block) return '';
  const content = getBlockContent(block);
  let text = renderTextElements(content?.elements) || '';

  // 递归渲染子块
  if (block.children && block.children.length > 0) {
    const childTexts = block.children.map(childId => {
      const child = blockMap.get(childId);
      return child ? renderBlockRecursive(child, blockMap) : '';
    }).filter(Boolean);
    if (childTexts.length > 0) {
      text += (text ? ' ' : '') + childTexts.join(' ');
    }
  }

  return text;
}

// 将 Table 块渲染为 Markdown 表格
function renderTable(tableBlock, blockMap) {
  // 获取表格维度 - 兼容不同 API 版本的字段路径
  let rowCount = tableBlock.table?.property?.row_size
    || tableBlock.table?.row_size || 0;
  let colCount = tableBlock.table?.property?.column_size
    || tableBlock.table?.column_size || 0;

  // 获取单元格 ID - 优先使用 table.cells（保证行优先顺序），兜底使用 children
  const cellIds = tableBlock.table?.cells || tableBlock.children || [];

  // 如果缺少维度信息但有单元格数据，尝试推断
  if ((rowCount === 0 || colCount === 0) && cellIds.length > 0) {
    console.warn('[Table] 表格缺少维度信息, block_id:', tableBlock.block_id,
      'cellIds:', cellIds.length, 'table:', JSON.stringify(tableBlock.table));
    if (rowCount > 0 && colCount === 0) {
      colCount = Math.ceil(cellIds.length / rowCount);
    } else if (colCount > 0 && rowCount === 0) {
      rowCount = Math.ceil(cellIds.length / colCount);
    } else {
      // 两个维度都未知，渲染为单列表格（至少展示内容）
      colCount = 1;
      rowCount = cellIds.length;
    }
  }

  if (cellIds.length === 0) {
    console.warn('[Table] 空表格, block_id:', tableBlock.block_id,
      'table:', JSON.stringify(tableBlock.table),
      'children:', JSON.stringify(tableBlock.children));
    return '[空表格]';
  }

  // 构建二维单元格内容网格
  const grid = [];
  for (let r = 0; r < rowCount; r++) {
    const row = [];
    for (let c = 0; c < colCount; c++) {
      const cellIndex = r * colCount + c;
      if (cellIndex >= cellIds.length) {
        row.push(' ');
        continue;
      }
      const cellId = cellIds[cellIndex];
      const cellBlock = cellId ? blockMap.get(cellId) : null;

      // 递归渲染单元格内所有内容
      let cellContent = '';
      if (cellBlock) {
        if (cellBlock.children && cellBlock.children.length > 0) {
          const parts = cellBlock.children.map(childId => {
            const child = blockMap.get(childId);
            return child ? renderBlockRecursive(child, blockMap) : '';
          }).filter(Boolean);
          cellContent = parts.join(' ');
        } else {
          // 单元格可能直接包含文本内容（无 children）
          const cellBlockContent = getBlockContent(cellBlock);
          cellContent = renderTextElements(cellBlockContent?.elements) || '';
        }
      }

      // 清理单元格内容（转义管道符，去除所有换行符）
      cellContent = cellContent.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
      row.push(cellContent || ' ');
    }
    grid.push(row);
  }

  // 确保至少有一行数据
  if (grid.length === 0) return '[空表格]';

  // 构建 Markdown 表格
  let md = '';
  // 表头
  md += '| ' + grid[0].join(' | ') + ' |\n';
  // 分隔行
  md += '| ' + grid[0].map(() => '---').join(' | ') + ' |\n';
  // 数据行
  for (let r = 1; r < grid.length; r++) {
    md += '| ' + grid[r].join(' | ') + ' |\n';
  }

  return md;
}

// 核心转换器：将扁平块数组转换为 Markdown 字符串
// sheetDataMap: 预获取的电子表格内容 Map<block_id, markdown_content>（可选）
function blocksToMarkdown(allBlocks, sheetDataMap) {
  if (!allBlocks || allBlocks.length === 0) return { markdown: '', title: '' };

  // 构建 block_id → block 对象的查找表
  const blockMap = new Map();
  allBlocks.forEach(b => blockMap.set(b.block_id, b));

  // 需要在主循环中跳过的块 ID（由 table 和 callout 内部处理）
  const skipIds = new Set();

  // 预扫描：递归标记 table 和 callout 的所有子孙块（在主循环中跳过）
  allBlocks.forEach(b => {
    if (b.block_type === 31) { // Table 普通表格 - 递归跳过所有子孙
      const tableCellIds = b.table?.cells || b.children || [];
      tableCellIds.forEach(cellId => {
        collectDescendantIds(cellId, blockMap, skipIds);
      });
    }
    if (b.block_type === 19 && b.children) { // Callout - 递归跳过所有子孙
      b.children.forEach(childId => {
        collectDescendantIds(childId, blockMap, skipIds);
      });
    }
  });

  // 有序列表计数器：parent_id → 当前计数
  const orderedCounters = new Map();
  let markdown = '';
  let title = '';

  for (const block of allBlocks) {
    // 跳过被 table/callout 内部管理的块
    if (skipIds.has(block.block_id)) continue;

    const blockContent = getBlockContent(block);
    const textContent = renderTextElements(blockContent?.elements);
    const blockType = block.block_type;

    // 计算列表缩进深度
    let indent = '';
    if (blockType === 12 || blockType === 13) {
      let depth = 0;
      let parentId = block.parent_id;
      while (parentId) {
        const parent = blockMap.get(parentId);
        if (parent && (parent.block_type === 12 || parent.block_type === 13)) {
          depth++;
          parentId = parent.parent_id;
        } else {
          break;
        }
      }
      indent = '  '.repeat(depth);
    }

    switch (blockType) {
      case 1: // Page（文档根节点）
        if (textContent) {
          title = textContent;
          markdown += '# ' + textContent + '\n\n';
        }
        break;

      case 2: // Text
        markdown += textContent + '\n\n';
        break;

      case 3: // Heading 1
        markdown += '# ' + textContent + '\n\n';
        break;
      case 4: // Heading 2
        markdown += '## ' + textContent + '\n\n';
        break;
      case 5: // Heading 3
        markdown += '### ' + textContent + '\n\n';
        break;
      case 6: // Heading 4
        markdown += '#### ' + textContent + '\n\n';
        break;
      case 7: // Heading 5
        markdown += '##### ' + textContent + '\n\n';
        break;
      case 8: // Heading 6
        markdown += '###### ' + textContent + '\n\n';
        break;
      case 9: case 10: case 11: // Heading 7-9（无对应 markdown，使用 H6）
        markdown += '###### ' + textContent + '\n\n';
        break;

      case 12: // Bullet 无序列表
        markdown += indent + '- ' + textContent + '\n';
        break;

      case 13: { // Ordered 有序列表
        const counterKey = block.parent_id || '__root__';
        if (!orderedCounters.has(counterKey)) {
          orderedCounters.set(counterKey, 1);
        }
        const num = orderedCounters.get(counterKey);
        orderedCounters.set(counterKey, num + 1);
        markdown += indent + num + '. ' + textContent + '\n';
        break;
      }

      case 14: { // Code 代码块
        const lang = getCodeLanguageName(blockContent?.style?.language);
        markdown += '```' + lang + '\n' + textContent + '\n```\n\n';
        break;
      }

      case 15: // Quote 引用
        markdown += textContent.split('\n').map(l => '> ' + l).join('\n') + '\n\n';
        break;

      case 16: { // Equation 公式块
        const eqContent = block.equation?.content || textContent || '';
        if (eqContent) {
          markdown += '$$\n' + eqContent + '\n$$\n\n';
        }
        break;
      }

      case 17: { // Todo 待办
        const done = blockContent?.style?.done ? 'x' : ' ';
        markdown += '- [' + done + '] ' + textContent + '\n';
        break;
      }

      case 19: { // Callout 高亮块
        markdown += '> ' + textContent + '\n';
        if (block.children) {
          for (const childId of block.children) {
            const child = blockMap.get(childId);
            if (child) {
              const childContent = getBlockContent(child);
              const childText = renderTextElements(childContent?.elements);
              if (childText) {
                markdown += '> ' + childText + '\n';
              }
            }
          }
        }
        markdown += '\n';
        break;
      }

      case 22: // Divider 分割线
        markdown += '---\n\n';
        break;

      case 23: // File 文件
        markdown += '[文件: ' + (block.file?.name || '附件') + ']\n\n';
        break;

      case 27: { // Image 图片
        const imageToken = block.image?.token || '';
        markdown += '![image](' + imageToken + ')\n\n';
        break;
      }

      case 18: // Bitable 多维表格（引用外部数据表，需单独 API 获取）
        markdown += '[多维表格]\n\n';
        break;

      case 20: // ChatCard 会话卡片
        markdown += '[会话卡片]\n\n';
        break;

      case 21: // Diagram / UML 画图
        markdown += '[画图]\n\n';
        break;

      case 24: // Grid 分栏容器
        // 分栏容器本身不输出内容，其子块（GridColumn）及内容会在主循环中渲染
        break;

      case 25: // GridColumn 分栏列
        // 分栏列容器本身不输出内容，其子块会在主循环中渲染
        break;

      case 26: // Iframe 内嵌网页
        markdown += '[嵌入网页]\n\n';
        break;

      case 28: // ISV 三方应用块
        markdown += '[三方应用]\n\n';
        break;

      case 29: // Mindnote 思维笔记
        markdown += '[思维笔记]\n\n';
        break;

      case 30: { // Sheet 电子表格
        const sheetContent = sheetDataMap?.get(block.block_id);
        if (sheetContent) {
          markdown += sheetContent + '\n\n';
        } else {
          markdown += '[电子表格]\n\n';
        }
        break;
      }

      case 31: // Table 普通表格
        markdown += renderTable(block, blockMap) + '\n\n';
        break;

      case 32: // TableCell 表格单元格（由 renderTable 内部处理，不应单独出现）
        break;

      case 33: // View 视图
        markdown += '[视图]\n\n';
        break;

      case 34: // QuoteContainer 引用容器
        // 引用容器的子块会在主循环中渲染
        break;

      case 35: // Task 任务
        markdown += '[任务]\n\n';
        break;

      case 36: case 37: case 38: case 39: // OKR 相关
        markdown += '[OKR]\n\n';
        break;

      case 43: // Board 画板
        markdown += '[画板]\n\n';
        break;

      default:
        // 未知块类型，尝试渲染文本（如有）
        if (textContent) {
          markdown += textContent + '\n\n';
        } else if (block.block_type) {
          console.warn('[Blocks] 未处理的块类型:', block.block_type, 'block_id:', block.block_id);
        }
        break;
    }

    // 遇到非有序列表块时重置计数器
    if (blockType !== 13) {
      const counterKey = block.parent_id || '__root__';
      orderedCounters.delete(counterKey);
    }
  }

  return { markdown: markdown.trim(), title };
}

// ===== 电子表格内容获取 =====

// 格式化电子表格单元格的值
function formatSheetCell(cellValue) {
  if (cellValue === null || cellValue === undefined) return '';
  if (typeof cellValue === 'string') {
    return cellValue.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
  }
  if (typeof cellValue === 'number' || typeof cellValue === 'boolean') {
    return String(cellValue);
  }
  if (Array.isArray(cellValue)) {
    // 富文本单元格：多段内容拼接
    return cellValue.map(seg => {
      if (typeof seg === 'string') return seg;
      if (seg && typeof seg === 'object') {
        return seg.text || seg.content || seg.value || '';
      }
      return String(seg);
    }).join('').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
  }
  if (typeof cellValue === 'object') {
    // 对象类型（链接、@提及等）
    const text = cellValue.text || cellValue.content || cellValue.value || '';
    return String(text).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
  }
  return String(cellValue);
}

// 将二维数组转换为 Markdown 表格
function valuesToMarkdownTable(values) {
  if (!values || values.length === 0) return '[空表]\n';

  // 过滤掉末尾全空行
  let lastNonEmptyRow = values.length - 1;
  while (lastNonEmptyRow > 0) {
    const row = values[lastNonEmptyRow];
    if (Array.isArray(row) && row.some(cell => cell !== null && cell !== undefined && cell !== '')) {
      break;
    }
    lastNonEmptyRow--;
  }
  const trimmedValues = values.slice(0, lastNonEmptyRow + 1);
  if (trimmedValues.length === 0) return '[空表]\n';

  // 计算最大列数
  let maxCols = 0;
  for (const row of trimmedValues) {
    if (Array.isArray(row) && row.length > maxCols) {
      maxCols = row.length;
    }
  }
  if (maxCols === 0) return '[空表]\n';

  // 构建 Markdown 表格
  let md = '';

  // 表头
  const headerRow = trimmedValues[0] || [];
  const header = [];
  for (let c = 0; c < maxCols; c++) {
    header.push(formatSheetCell(headerRow[c]) || ' ');
  }
  md += '| ' + header.join(' | ') + ' |\n';
  md += '| ' + header.map(() => '---').join(' | ') + ' |\n';

  // 数据行
  for (let r = 1; r < trimmedValues.length; r++) {
    const row = trimmedValues[r] || [];
    const cells = [];
    for (let c = 0; c < maxCols; c++) {
      cells.push(formatSheetCell(row[c]) || ' ');
    }
    md += '| ' + cells.join(' | ') + ' |\n';
  }

  return md;
}

// 获取电子表格内容并转换为 Markdown
async function fetchSheetContent(spreadsheetToken, token, apiEndpoint) {
  console.log('[Sheet] 开始获取电子表格:', spreadsheetToken);

  // 第一步：获取元信息（所有 sheet 的 ID 和维度）
  const metaUrl = `${apiEndpoint}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/metainfo`;
  const metaResponse = await fetch(metaUrl, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  const metaData = await metaResponse.json();

  if (metaData.code !== 0) {
    console.warn('[Sheet] 获取元信息失败:', metaData.msg, '(code:', metaData.code, ')');
    throw new Error(`获取表格元信息失败: ${metaData.msg} (code: ${metaData.code})`);
  }

  const sheets = metaData.data?.sheets || [];
  if (sheets.length === 0) {
    return '[空电子表格]';
  }

  console.log(`[Sheet] 发现 ${sheets.length} 个工作表`);

  // 第二步：逐个读取每个 sheet 的内容（限制最多 5 个 sheet）
  const maxSheets = Math.min(sheets.length, 5);
  let allContent = '';

  for (let i = 0; i < maxSheets; i++) {
    const sheet = sheets[i];
    const sheetId = sheet.sheetId;
    const title = sheet.title || `Sheet${(sheet.index || i) + 1}`;
    const rowCount = Math.min(sheet.rowCount || 100, 200); // 最多 200 行
    const colCount = Math.min(Math.max(sheet.columnCount || 10, 1), 26); // 最多 26 列 (A-Z)

    // 列数转字母 (1=A, 2=B, ..., 26=Z)
    const endCol = String.fromCharCode(64 + colCount);
    const range = `${sheetId}!A1:${endCol}${rowCount}`;

    console.log(`[Sheet] 读取工作表 "${title}": ${range}`);

    try {
      const valuesUrl = `${apiEndpoint}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${range}?valueRenderOption=ToString`;
      const valuesResponse = await fetch(valuesUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      const valuesData = await valuesResponse.json();

      if (valuesData.code !== 0) {
        console.warn(`[Sheet] 读取 "${title}" 失败:`, valuesData.msg);
        allContent += `**${title}**: [获取失败: ${valuesData.msg}]\n\n`;
        continue;
      }

      const values = valuesData.data?.valueRange?.values || [];
      if (values.length === 0) {
        allContent += `**${title}**: [空表]\n\n`;
        continue;
      }

      console.log(`[Sheet] "${title}" 获取到 ${values.length} 行数据`);

      // 多个 sheet 时显示标题
      if (maxSheets > 1) {
        allContent += `**${title}**\n\n`;
      }
      allContent += valuesToMarkdownTable(values);
      allContent += '\n';
    } catch (e) {
      console.warn(`[Sheet] 读取 "${title}" 异常:`, e.message);
      allContent += `**${title}**: [获取失败: ${e.message}]\n\n`;
    }
  }

  if (sheets.length > maxSheets) {
    allContent += `> 还有 ${sheets.length - maxSheets} 个工作表未显示\n\n`;
  }

  return allContent.trim();
}

// 批量预获取文档中所有电子表格的内容
async function prefetchSheetData(allBlocks, token, apiEndpoint) {
  const sheetDataMap = new Map();
  const sheetBlocks = allBlocks.filter(b => b.block_type === 30 && b.sheet?.token);

  if (sheetBlocks.length === 0) return sheetDataMap;

  console.log(`[Sheet] 发现 ${sheetBlocks.length} 个嵌入式电子表格，开始获取内容...`);

  for (const sb of sheetBlocks) {
    try {
      const content = await fetchSheetContent(sb.sheet.token, token, apiEndpoint);
      sheetDataMap.set(sb.block_id, content);
    } catch (e) {
      console.warn('[Sheet] 获取电子表格失败:', sb.sheet.token, e.message);
      sheetDataMap.set(sb.block_id, `[电子表格: 获取失败 - ${e.message}]`);
    }
  }

  console.log(`[Sheet] 电子表格内容获取完成`);
  return sheetDataMap;
}

// 分页获取文档所有块
async function fetchAllDocBlocks(documentId, token, apiEndpoint) {
  const allBlocks = [];
  let pageToken = null;
  let hasMore = true;
  let pageCount = 0;
  const MAX_PAGES = 100; // 安全上限：100 页 × 500 块 = 50,000 块

  while (hasMore && pageCount < MAX_PAGES) {
    const url = `${apiEndpoint}/open-apis/docx/v1/documents/${documentId}/blocks`;
    const params = new URLSearchParams({
      page_size: '500',
      document_revision_id: '-1'
    });
    if (pageToken) {
      params.append('page_token', pageToken);
    }

    console.log(`[Blocks] 获取第 ${pageCount + 1} 页:`, url);

    const response = await fetch(`${url}?${params}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (data.code !== 0) {
      throw new Error(`获取文档块失败: ${data.msg} (code: ${data.code})`);
    }

    const items = data.data?.items || [];
    allBlocks.push(...items);

    hasMore = data.data?.has_more || false;
    pageToken = data.data?.page_token || null;
    pageCount++;

    console.log(`[Blocks] 第 ${pageCount} 页: ${items.length} 块, 总计: ${allBlocks.length}, 还有更多: ${hasMore}`);
  }

  if (pageCount >= MAX_PAGES) {
    console.warn('[Blocks] 达到页数上限，文档可能被截断');
  }

  return allBlocks;
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
    let wikiInfo = null;

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
      wikiInfo = await getWikiDocToken(documentId, null, token, apiEndpoint);
      finalDocId = wikiInfo.objToken;
      docType = wikiInfo.objType || 'docx';

      console.log('[Fetch] Wiki 转换结果:');
      console.log('  node_token:', documentId);
      console.log('  obj_token:', finalDocId);
      console.log('  obj_type:', docType);
    }

    // ===== 获取文档内容 =====
    // 新的 docx/v1/blocks API 仅支持 docx 类型，其他类型降级到旧 API
    const useNewBlocksAPI = (docType === 'docx');
    let fullContent = '';
    let title = '';

    if (useNewBlocksAPI) {
      // ===== 新 API：docx/v1/documents/:id/blocks =====
      console.log('[Fetch] 使用新 docx/v1/blocks API');
      console.log('[Fetch] 文档ID:', finalDocId);

      try {
        const allBlocks = await fetchAllDocBlocks(finalDocId, token, apiEndpoint);
        console.log('[Fetch] 获取到块总数:', allBlocks.length);

        // 预获取嵌入式电子表格内容
        const sheetDataMap = await prefetchSheetData(allBlocks, token, apiEndpoint);

        const result = blocksToMarkdown(allBlocks, sheetDataMap);
        fullContent = result.markdown || '文档内容为空';
        title = result.title || '';

        console.log('[Fetch] Markdown 生成完成, 长度:', fullContent.length);
      } catch (blockError) {
        // 处理新 API 的错误码
        let errorMsg = blockError.message;

        if (errorMsg.includes('99991663') || errorMsg.toLowerCase().includes('forbidden')) {
          errorMsg += '\n\n【权限不足】\n\n';
          errorMsg += '解决方案：\n';
          errorMsg += '1. 确认应用已添加权限: docx:document:readonly\n';
          errorMsg += '2. 使用用户令牌（tenant_access_token 只能访问公开文档）\n';
          errorMsg += '3. 在文档中添加应用权限：「...」→「...更多」→「添加文档应用」';
        } else if (errorMsg.includes('99991664') || errorMsg.includes('99991668')) {
          errorMsg += '\n\n【文档不存在】\n\n';
          errorMsg += `文档 ID: ${finalDocId}\n`;
          if (domain && domain.includes('/wiki/')) {
            errorMsg += 'Wiki 文档说明：确认 Wiki 文档存在且有访问权限\n';
          }
        }

        throw new Error(errorMsg);
      }
    } else {
      // ===== 降级：使用旧 docs/v1/content API（doc, sheet, bitable 等类型）=====
      console.log('[Fetch] 使用旧 docs/v1/content API，文档类型:', docType);

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
      console.log('[Fetch] 响应数据:', data);

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

      fullContent = data.data?.content || '文档内容为空';
    }

    console.log('[Fetch] 获取成功');

    // ===== 获取评论 =====
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

    // ===== 提取文档标题 =====
    // 优先级：blocksToMarkdown 提取的 title → wikiInfo.title → 正则匹配
    if (!title && wikiInfo && wikiInfo.title) {
      title = wikiInfo.title;
    }
    if (!title && fullContent) {
      const titleMatch = fullContent.match(/^#\s+(.*)$/m);
      if (titleMatch) {
        title = titleMatch[1].trim();
      } else {
        const h2Match = fullContent.match(/^##\s+(.*)$/m);
        if (h2Match) {
          title = h2Match[1].trim();
        }
      }
    }
    console.log('[Fetch] 提取的文档标题:', title);
    
    // 构建文档的真实URL
    let docUrl = domain;
    // 如果是Wiki文档，尝试构建更准确的URL
    if (domain && domain.includes('/wiki/') && finalDocId) {
      // 保留原始的Wiki URL
      docUrl = domain;
    }
    
    return {
      success: true,
      documentId: finalDocId,
      content: fullContent, // 确保这里使用的是合并了评论的 fullContent
      region: region,
      tokenType: tokenType,
      docType: docType,
      title: title,
      url: docUrl
    };

  } catch (error) {
    console.error('[Fetch] 失败:', error);
    return { success: false, error: error.message };
  }
}

console.log('[Background] 飞书文档读取器已加载 - 支持 Wiki 文档');

