chrome.action.onClicked.addListener(async tab => {
  if (!tab.id) return;

  if (!tab.url?.startsWith('https://mp.weixin.qq.com/')) {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#2D3038' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: '请先打开微信公众号编辑页面' });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {});
      chrome.action.setTitle({ tabId: tab.id, title: '打开公众号 HTML 排版粘贴' }).catch(() => {});
    }, 2500);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'MP_HTML_SHOW' });
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['transformer.js', 'content.js'],
    });
  }
});
