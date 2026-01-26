// 飞书 Token 获取助手 - 直接运行版
// 在飞书文档页面的 Console 中运行此代码

(async function() {
  console.clear();
  console.log('%c=== 飞书 Token 获取助手 ===', 'color: #1890ff; font-size: 18px; font-weight: bold;');

  // 方法1: 从 localStorage 查找
  console.log('%c[1/4] 正在搜索 localStorage...', 'color: #666;');
  const foundTokens = [];

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const value = localStorage.getItem(key);

    // 查找包含 token 的值
    if (value && (
      value.includes('access_token') ||
      value.includes('tenant_token') ||
      value.includes('user_token') ||
      value.length > 100 && (value.startsWith('cli_') || value.startsWith('t-'))
    )) {
      try {
        const parsed = JSON.parse(value);
        if (parsed.access_token || parsed.tenant_access_token || parsed.user_access_token) {
          const token = parsed.access_token || parsed.tenant_access_token || parsed.user_access_token;
          foundTokens.push({ source: key, token: token, type: 'localStorage' });
          console.log(`%c✓ 找到 [${key}]:`, 'color: #52c41a;', token.substring(0, 30) + '...');
        }
      } catch {
        if (value.length > 50 && (value.startsWith('cli_') || value.startsWith('t-'))) {
          foundTokens.push({ source: key, token: value, type: 'localStorage' });
          console.log(`%c✓ 找到 [${key}]:`, 'color: #52c41a;', value.substring(0, 30) + '...');
        }
      }
    }
  }

  // 方法2: 从 sessionStorage 查找
  console.log('%c[2/4] 正在搜索 sessionStorage...', 'color: #666;');
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    const value = sessionStorage.getItem(key);

    if (value && value.length > 50) {
      try {
        const parsed = JSON.parse(value);
        if (parsed.access_token || parsed.tenant_access_token || parsed.user_access_token) {
          const token = parsed.access_token || parsed.tenant_access_token || parsed.user_access_token;
          if (!foundTokens.find(t => t.token === token)) {
            foundTokens.push({ source: key + ' (session)', token: token, type: 'sessionStorage' });
            console.log(`%c✓ 找到 [${key}]:`, 'color: #52c41a;', token.substring(0, 30) + '...');
          }
        }
      } catch {}
    }
  }

  // 方法3: 从 Cookie 查找
  console.log('%c[3/4] 正在搜索 Cookie...', 'color: #666;');
  const cookies = document.cookie.split(';');
  cookies.forEach(cookie => {
    const [name, value] = cookie.trim().split('=');
    if (value && value.length > 50 && (value.includes('token') || value.startsWith('cli_') || value.startsWith('t-'))) {
      if (!foundTokens.find(t => t.token === value)) {
        foundTokens.push({ source: name, token: value, type: 'Cookie' });
        console.log(`%c✓ 找到 [${name}]:`, 'color: #52c41a;', value.substring(0, 30) + '...');
      }
    }
  });

  // 方法4: 从 window 对象查找
  console.log('%c[4/4] 正在搜索 window 对象...', 'color: #666;');

  // 查找所有可能的 token 属性
  const searchWindow = (obj, path = 'window', depth = 0) => {
    if (depth > 3) return;
    try {
      for (const key in obj) {
        if (key.toLowerCase().includes('token') && typeof obj[key] === 'string' && obj[key].length > 50) {
          if (!foundTokens.find(t => t.token === obj[key])) {
            foundTokens.push({ source: path + '.' + key, token: obj[key], type: 'window' });
            console.log(`%c✓ 找到 ${path}.${key}:`, 'color: #52c41a;', obj[key].substring(0, 30) + '...');
          }
        }
      }
    } catch (e) {}
  };

  searchWindow(window, 'window');

  // 结果汇总
  console.log('%c\n=== 搜索完成 ===', 'color: #1890ff; font-size: 16px; font-weight: bold;');

  if (foundTokens.length > 0) {
    console.log(`%c共找到 ${foundTokens.length} 个 Token:`, 'color: #52c41a; font-size: 14px; font-weight: bold;');
    foundTokens.forEach((item, index) => {
      console.log(`%c${index + 1}. ${item.source} (${item.type})`, 'color: #666;');
      console.log(`   Token: ${item.token}`);
    });

    // 复制第一个找到的 token
    const bestToken = foundTokens[0].token;
    navigator.clipboard.writeText(bestToken).then(() => {
      console.log('%c\n✅ 第一个 Token 已复制到剪贴板！', 'color: #52c41a; font-size: 16px; font-weight: bold;');
      console.log('%c现在可以到插件中粘贴 Token 了', 'color: #1890ff;');
    });

  } else {
    console.log('%c❌ 未找到 Token', 'color: #ff4d4f; font-size: 14px;');
    console.log('%c\n请尝试以下方法:', 'color: #666;');
    console.log('1. 确保已登录飞书账号');
    console.log('2. 在飞书文档中按 F5 刷新页面');
    console.log('3. 在文档中进行一些操作（输入文字等）');
    console.log('4. 再次运行此脚本');
  }
})();
