(function() {
    // 防止重复注入
    if (window.__larkdoc_selection_listener_injected) return;
    window.__larkdoc_selection_listener_injected = true;

    console.log('[LarkDoc] Selection Listener Injected in:', window.location.href);

    let debounceTimer = null;

    function handleSelection() {
        if (debounceTimer) clearTimeout(debounceTimer);
        
        debounceTimer = setTimeout(() => {
            const selection = window.getSelection();
            const text = selection.toString().trim();
            
            // Debug log
            // if (text) console.log('[LarkDoc] Selection detected:', text.substring(0, 20) + '...');
            
            // 只有当文本非空时才更新
            if (text) {
                chrome.storage.local.set({ selectedText: text });
            }
        }, 500); // 500ms debounce
    }

    document.addEventListener('selectionchange', handleSelection);
    
    // 辅助：mouseup 时也尝试立即触发
    document.addEventListener('mouseup', () => {
        const selection = window.getSelection();
        const text = selection.toString().trim();
        if (text) {
            console.log('[LarkDoc] MouseUp Selection:', text.substring(0, 20) + '...');
            chrome.storage.local.set({ selectedText: text });
        }
    });
})();
