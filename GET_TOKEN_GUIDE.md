# 如何获取飞书 Access Token

## 方法2：浏览器开发者工具（推荐）

### 步骤：

1. **打开飞书文档并登录**
   - 在浏览器中打开任意飞书文档
   - 确保已登录飞书账号

2. **打开开发者工具**
   - Mac: `Cmd + Option + I`
   - Windows: `Ctrl + Shift + I`

3. **切换到 Network（网络）标签**
   - 点击顶部的 "Network" 或 "网络" 标签

4. **刷新页面或执行操作**
   - 按 `F5` 刷新页面
   - 或在文档中进行任何操作（输入文字等）

5. **搜索 API 请求**
   - 在过滤器中输入: `open-apis`
   - 查找包含 `user_info` 或 `authen` 的请求

6. **查看请求头**
   - 点击任意一个 `open-apis` 请求
   - 在右侧找到 "Headers" 或 "标头"
   - 查找 `Authorization: Bearer xxxxx`

7. **复制 Token**
   - 复制 `Bearer ` 后面的长字符串
   - 这就是你的 `user_access_token`

### 示例图：
```
Request Headers:
Authorization: Bearer cli_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
                ↑↑↑↑ 复制这部分 ↑↑↑↑
```

---

## 方法3：从浏览器 Application/Storage 获取

### 步骤：

1. **打开开发者工具** (`F12`)

2. **切换到 Application（应用程序）标签**

3. **查找 Local Storage**
   - 左侧展开 "Application" 或 "应用程序"
   - 点击 "Local Storage" → "https://feishu.cn" 或 "https://larksuite.com"

4. **查找 Token**
   - 查找键值对中包含 `token`、`access_token`、`user_access_token` 的项
   - 复制对应的值

---

## 方法4：使用 Console 直接获取

### 步骤：

1. **打开飞书文档并登录**

2. **打开开发者工具** (`F12`)

3. **切换到 Console（控制台）标签**

4. **粘贴以下代码并回车**：

```javascript
// 方法 A: 从 localStorage 获取
Object.keys(localStorage)
  .filter(key => key.includes('token') || key.includes('auth'))
  .forEach(key => console.log(key, '=', localStorage[key]));

// 方法 B: 从 sessionStorage 获取
Object.keys(sessionStorage)
  .filter(key => key.includes('token') || key.includes('auth'))
  .forEach(key => console.log(key, '=', sessionStorage[key]));

// 方法 C: 查找 window 对象中的 token
Object.keys(window).filter(key => key.toLowerCase().includes('token')).forEach(key => console.log(key, '=', window[key]));
```

5. **查看输出**
   - 控制台会显示所有包含 token 的键值对
   - 找到类似 `access_token` 或 `user_access_token` 的项

---

## 方法5：拦截 OAuth 回调（调试用）

### 步骤：

1. **点击插件的"用户登录授权"按钮**

2. **在飞书授权页面点击同意后**

3. **立即打开开发者工具** (`F12`)

4. **切换到 Network 标签**

5. **查找回调 URL**
   - 会看到跳转到 `forlark.zeabur.app/callback.html?code=xxxxx`
   - 复制 URL 中 `code=` 后面的授权码

6. **使用 Postman 或 curl 换取 Token**：

```bash
curl -X POST 'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer tenant_access_token_here' \
  -d '{
    "grant_type": "authorization_code",
    "client_id": "cli_xxxxxxxxx",
    "client_secret": "xxxxxxxxxxxxxxxx",
    "code": "从URL中复制的授权码",
    "redirect_uri": "https://forlark.zeabur.app/callback.html"
  }'
```

---

## 注意事项

⚠️ **Token 有效期**
- user_access_token 通常有效期为 **2小时**
- 过期后需要重新获取

⚠️ **Token 区域匹配**
- 中国版文档 (feishu.cn) → 使用中国版 API
- 国际版文档 (larksuite.com) → 使用国际版 API

⚠️ **安全性**
- 不要将 token 分享给他人
- Token 相当于你的账号密码
- 仅用于个人调试和学习

---

## 快速测试

### 测试 Token 是否有效

在浏览器 Console 中运行：

```javascript
// 替换 YOUR_TOKEN_HERE 为你的 token
fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
  headers: {
    'Authorization': 'Bearer YOUR_TOKEN_HERE'
  }
})
.then(r => r.json())
.then(d => console.log('Token 有效，用户信息:', d))
.catch(e => console.error('Token 无效:', e));
```

如果返回用户信息，说明 Token 有效！
