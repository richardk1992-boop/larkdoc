// 飞书文档读取器 - Content Script
// 简化版

console.log('[Content] 飞书文档读取器已加载');

// 从页面获取文档 ID
function getDocumentId() {
  // 从 URL 获取 - 支持多种格式
  const pathMatch = window.location.pathname.match(/\/(docx|docs|wiki|note|slides|sheets|bitable)\/([a-zA-Z0-9_-]+)/);
  if (pathMatch) return pathMatch[2];

  // 从其他方式获取
  if (window.__doc_id__) return window.__doc_id__;

  const docElement = document.querySelector('[data-doc-id]');
  if (docElement) return docElement.getAttribute('data-doc-id');

  const metaTag = document.querySelector('meta[name="doc-id"]');
  if (metaTag) return metaTag.getAttribute('content');

  return null;
}

// 页面加载完成后通知
function notifyDocumentLoaded() {
  const docId = getDocumentId();
  if (docId) {
    console.log('[Content] 文档 ID:', docId);
    chrome.runtime.sendMessage({
      action: 'documentLoaded',
      documentId: docId,
      url: window.location.href
    });
  }
}

// 初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', notifyDocumentLoaded);
} else {
  notifyDocumentLoaded();
}

// 监听 URL 变化（单页应用）
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    notifyDocumentLoaded();
  }
}).observe(document, { subtree: true, childList: true });
