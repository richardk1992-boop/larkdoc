// 飞书文档读取器 - OAuth Callback Content Script
// 运行在授权回调页面，用于捕获授权码并发送给后台

(function() {
  console.log('[LarkDoc] Callback script loaded');
  
  try {
    const urlObj = new URL(window.location.href);
    const code = urlObj.searchParams.get('code');
    const state = urlObj.searchParams.get('state');
    const error = urlObj.searchParams.get('error');

    if (code || error) {
      console.log('[LarkDoc] Capturing OAuth callback...', { hasCode: !!code, error });
      
      // 发送消息给 background
      chrome.runtime.sendMessage({
        action: 'oauthCallback',
        url: window.location.href,
        code: code,
        state: state,
        error: error
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[LarkDoc] Failed to send message:', chrome.runtime.lastError);
        } else {
          console.log('[LarkDoc] Message sent successfully:', response);
          // 可以在页面上显示处理状态
          const container = document.querySelector('.container') || document.body;
          const statusDiv = document.createElement('div');
          statusDiv.style.marginTop = '20px';
          statusDiv.style.padding = '10px';
          statusDiv.style.borderRadius = '4px';
          statusDiv.style.backgroundColor = '#e6f7ff';
          statusDiv.style.border = '1px solid #91d5ff';
          statusDiv.style.color = '#0050b3';
          statusDiv.textContent = '正在处理授权，请稍候...';
          container.appendChild(statusDiv);
        }
      });
    }
  } catch (e) {
    console.error('[LarkDoc] Error in callback script:', e);
  }
})();