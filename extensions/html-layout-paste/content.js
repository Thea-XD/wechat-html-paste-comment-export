/* 公众号 HTML 排版粘贴 — 按需注入面板 */
(function installPanel() {
  'use strict';

  if (globalThis.__MP_HTML_PANEL_V2__) {
    globalThis.__MP_HTML_PANEL_V2__.open();
    return;
  }

  const transformer = globalThis.__MP_HTML_TRANSFORMER__;
  if (!transformer) return;

  function findEditor() {
    const selectors = [
      '.rich_media_content.ProseMirror[contenteditable="true"]',
      '.ProseMirror[contenteditable="true"]',
      '.autoTypeSetting24psection[contenteditable="true"]',
      '[contenteditable="true"].rich_media_content',
      '#js_editor_area [contenteditable="true"]',
      '.editor_content[contenteditable="true"]',
      '[contenteditable="true"][data-placeholder*="正文"]',
      '[contenteditable="true"][aria-label*="正文"]',
    ];
    const documents = [document];
    document.querySelectorAll('iframe').forEach(frame => {
      try { if (frame.contentDocument) documents.push(frame.contentDocument); } catch (_) {}
    });
    const candidates = [];
    documents.forEach(doc => selectors.forEach((selector, rank) => {
      doc.querySelectorAll(selector).forEach(el => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 240 && rect.height > 120;
        if (visible) candidates.push({ el, score: (selectors.length - rank) * 100 + rect.width + Math.min(rect.height, 800) });
      });
    }));
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.el || null;
  }

  async function writeClipboard(html, plainText) {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plainText], { type: 'text/plain' }),
      })]);
      return true;
    } catch (_) {}

    try {
      const holder = document.createElement('div');
      holder.contentEditable = 'true';
      holder.innerHTML = html;
      Object.assign(holder.style, {
        position: 'fixed', left: '-10000px', top: '0', width: '677px',
        maxHeight: '1px', overflow: 'hidden', opacity: '0.001',
      });
      document.body.appendChild(holder);
      const range = document.createRange();
      range.selectNodeContents(holder);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const copied = document.execCommand('copy');
      selection.removeAllRanges();
      holder.remove();
      return copied;
    } catch (_) {
      return false;
    }
  }

  async function applyHTMLToEditor(editor, html, plainText, options = {}) {
    const doc = editor.ownerDocument;
    const view = doc.defaultView || window;
    const replaceAll = options.replaceAll !== false;
    editor.focus();

    if (replaceAll) {
      // ProseMirror maintains its own selection state. selectAll plus a render
      // frame synchronizes the DOM selection before replacing the whole article.
      let selected = false;
      try { selected = doc.execCommand('selectAll', false, null); } catch (_) {}
      if (!selected) {
        const range = doc.createRange();
        range.selectNodeContents(editor);
        const fallbackSelection = view.getSelection();
        fallbackSelection.removeAllRanges();
        fallbackSelection.addRange(range);
      }
    } else {
      const insertionSelection = view.getSelection();
      insertionSelection.removeAllRanges();
      const savedRange = options.savedRange;
      const savedNode = savedRange?.commonAncestorContainer;
      if (savedRange && savedRange.startContainer?.ownerDocument === doc && (savedNode === editor || editor.contains(savedNode))) {
        try { insertionSelection.addRange(savedRange.cloneRange()); } catch (_) {}
      }
      if (!insertionSelection.rangeCount) {
        const range = doc.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        insertionSelection.addRange(range);
      }
    }
    try { doc.dispatchEvent(new view.Event('selectionchange')); } catch (_) {}
    await new Promise(resolve => view.requestAnimationFrame(resolve));

    const selection = view.getSelection();
    const anchorInside = selection.anchorNode === editor || editor.contains(selection.anchorNode);
    const focusInside = selection.focusNode === editor || editor.contains(selection.focusNode);
    if (!selection.rangeCount || !anchorInside || !focusInside || (replaceAll && selection.isCollapsed)) {
      selection.removeAllRanges();
      const range = doc.createRange();
      range.selectNodeContents(editor);
      if (!replaceAll) range.collapse(false);
      selection.addRange(range);
      try { doc.dispatchEvent(new view.Event('selectionchange')); } catch (_) {}
      await new Promise(resolve => view.requestAnimationFrame(resolve));
    }

    let pasteEvent;
    try {
      const clipboardData = new view.DataTransfer();
      clipboardData.setData('text/html', html);
      clipboardData.setData('text/plain', plainText || '');
      pasteEvent = new view.ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      });
      if (!pasteEvent.clipboardData) Object.defineProperty(pasteEvent, 'clipboardData', { value: clipboardData });
    } catch (_) { selection.removeAllRanges(); return false; }

    const accepted = !editor.dispatchEvent(pasteEvent) || pasteEvent.defaultPrevented;
    selection.removeAllRanges();
    return accepted;
  }

  const host = document.createElement('div');
  host.id = '__mp-html-paste-host';
  host.style.cssText = 'all:initial;position:fixed;inset:0 0 0 auto;width:min(560px,100vw);height:100vh;z-index:2147483647;display:none;pointer-events:none';
  const shadow = host.attachShadow({ mode: 'open' });
  const panelIconURL = chrome.runtime.getURL('icon32.png');

  shadow.innerHTML = `
    <style>
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      button, textarea { font: inherit; }
      button:focus-visible, textarea:focus-visible { outline: 2px solid #07C160; outline-offset: 2px; }
      .panel { width: 100%; height: 100%; background: #fff; color: #2D3038; font: 13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; display: flex; flex-direction: column; pointer-events: auto; box-shadow: -10px 0 34px rgba(37,45,41,.14); transform: translateX(100%); transition: transform .2s ease; }
      .panel.open { transform: translateX(0); }
      .header { height: 58px; padding: 0 16px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #EDF0EE; }
      .brand { flex: none; width: 32px; height: 32px; border-radius: 9px; display: block; object-fit: cover; box-shadow: 0 0 0 1px rgba(7,193,96,.12); }
      .title { font-size: 15px; font-weight: 650; letter-spacing: -.2px; }
      .connection { margin-left: auto; display: flex; align-items: center; gap: 6px; color: #7C837F; font-size: 12px; }
      .dot { width: 7px; height: 7px; border-radius: 50%; background: #C7CCC9; }
      .dot.ready { background: #07C160; }
      .close { width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: #7C837F; cursor: pointer; font-size: 18px; }
      .close:hover { background: #F3F6F4; color: #2D3038; }
      .tabs { height: 45px; padding: 0 16px; display: flex; gap: 22px; border-bottom: 1px solid #EDF0EE; }
      .tab { position: relative; border: 0; padding: 0 1px; background: transparent; color: #8A9090; cursor: pointer; font-weight: 550; }
      .tab.active { color: #2D3038; }
      .tab.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 3px; border-radius: 3px 3px 0 0; background: #07C160; }
      .view { display: none; flex: 1; min-height: 0; flex-direction: column; }
      .view.active { display: flex; }
      .workspace { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; background: #F5F7F6; }
      .column { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: #fff; }
      .column + .column { border-left: 1px solid #E5E9E7; }
      .column-head { height: 38px; padding: 0 12px; display: flex; align-items: center; color: #747B77; font-size: 11px; border-bottom: 1px solid #EDF0EE; background: #FAFBFA; }
      .source { flex: 1; min-height: 0; width: 100%; border: 0; resize: none; padding: 14px; color: #2D3038; background: #fff; font: 11.5px/1.7 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace; tab-size: 2; }
      .preview { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; }
      .toolbar { height: 42px; padding: 0 12px; display: flex; align-items: center; border-bottom: 1px solid #EDF0EE; background: #fff; }
      .secondary { border: 1px solid #DCE2DE; border-radius: 7px; padding: 5px 10px; background: #fff; color: #4D5551; cursor: pointer; font-size: 12px; }
      .secondary:hover { border-color: #B8C2BC; background: #F8FAF9; }
      .footer { flex: none; padding: 12px 16px 14px; border-top: 1px solid #E5E9E7; background: #fff; }
      .status { min-height: 20px; margin: 0 0 8px; color: #8A9090; font-size: 12px; }
      .status.ready { color: #168B4C; }
      .status.error { color: #C73C3C; }
      .primary { width: 100%; height: 42px; border: 0; border-radius: 9px; background: #07C160; color: #fff; cursor: pointer; font-weight: 650; }
      .primary:hover { background: #06AE56; }
      .primary.success { background: #168B4C; }
      .primary:disabled { background: #CFE8D9; cursor: default; }
      .footer-actions { display: grid; grid-template-columns: .9fr 1.1fr; gap: 10px; }
      .action-secondary { width: 100%; height: 42px; border: 1px solid #BFD8C8; border-radius: 9px; background: #fff; color: #168B4C; cursor: pointer; font-weight: 650; }
      .action-secondary:hover { border-color: #07C160; background: #F2FBF5; }
      .action-secondary.success { border-color: #168B4C; background: #EAF7EF; }
      .action-secondary:disabled { border-color: #E0E6E2; background: #F7F8F7; color: #A7AEAA; cursor: default; }
      .read-card { min-height: 68px; padding: 10px 12px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #DDE8E1; background: #F2FBF5; }
      .read-copy { flex: 1; min-width: 0; }
      .read-title { display: block; color: #2D3038; font-size: 13px; font-weight: 650; }
      .read-help { display: block; margin-top: 2px; color: #6E7872; font-size: 11px; }
      .read-current { flex: none; min-width: 112px; height: 38px; border: 0; border-radius: 9px; padding: 0 14px; background: #07C160; color: #fff; cursor: pointer; font-weight: 650; }
      .read-current:hover { background: #06AE56; }
      .toast { position: absolute; left: 50%; bottom: 78px; transform: translateX(-50%) translateY(8px); padding: 9px 14px; border-radius: 8px; background: #2D3038; color: #fff; opacity: 0; pointer-events: none; transition: .18s ease; white-space: nowrap; }
      .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
      @media (max-width: 520px) { .workspace { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } .column + .column { border-left: 0; border-top: 1px solid #E5E9E7; } }
      @media (prefers-reduced-motion: reduce) { .panel, .toast { transition: none; } }
    </style>
    <section class="panel" role="dialog" aria-label="公众号 HTML 排版粘贴">
      <header class="header">
        <img class="brand" src="${panelIconURL}" alt=""><span class="title">公众号 HTML 排版粘贴</span>
        <span class="connection"><span class="dot"></span><span class="connection-text">未找到正文</span></span>
        <button class="close" type="button" aria-label="关闭">×</button>
      </header>
      <nav class="tabs" aria-label="功能"><button class="tab active" type="button" data-tab="paste">粘贴 HTML</button><button class="tab" type="button" data-tab="edit">编辑正文</button></nav>
      <section class="view active" data-view="paste">
        <div class="workspace">
          <div class="column"><div class="column-head">HTML</div><textarea class="source paste-source" spellcheck="false" placeholder="把 HTML 粘贴到这里"></textarea></div>
          <div class="column"><div class="column-head">预览</div><iframe class="preview paste-preview" sandbox=""></iframe></div>
        </div>
        <footer class="footer"><p class="status paste-status">输入 HTML 后即可准备</p><div class="footer-actions"><button class="action-secondary paste-copy" type="button" disabled>复制结果</button><button class="primary paste-apply" type="button" disabled>插入到正文</button></div></footer>
      </section>
      <section class="view" data-view="edit">
        <div class="read-card"><span class="read-copy"><strong class="read-title">读取当前正文</strong><span class="read-help">读取后可在左侧直接修改 HTML</span></span><button class="read-current" type="button">读取正文</button></div>
        <div class="workspace">
          <div class="column"><div class="column-head">当前正文 HTML</div><textarea class="source edit-source" spellcheck="false" placeholder="读取正文后可在这里修改"></textarea></div>
          <div class="column"><div class="column-head">预览</div><iframe class="preview edit-preview" sandbox=""></iframe></div>
        </div>
        <footer class="footer"><p class="status edit-status">读取正文后即可修改</p><div class="footer-actions"><button class="action-secondary edit-copy" type="button" disabled>复制结果</button><button class="primary edit-apply" type="button" disabled>应用到正文</button></div></footer>
      </section>
      <div class="toast" role="status"></div>
    </section>`;

  document.documentElement.appendChild(host);

  const $ = selector => shadow.querySelector(selector);
  const panel = $('.panel');
  const dot = $('.dot');
  const connectionText = $('.connection-text');
  const tabs = [...shadow.querySelectorAll('.tab')];
  const views = [...shadow.querySelectorAll('.view')];
  const pasteSource = $('.paste-source');
  const pastePreview = $('.paste-preview');
  const pasteStatus = $('.paste-status');
  const pasteCopy = $('.paste-copy');
  const pasteApply = $('.paste-apply');
  const editSource = $('.edit-source');
  const editPreview = $('.edit-preview');
  const editStatus = $('.edit-status');
  const editCopy = $('.edit-copy');
  const editApply = $('.edit-apply');
  const readButton = $('.read-current');
  const toastElement = $('.toast');
  let currentPaste = { html: '', plainText: '', ok: false };
  let currentEdit = { html: '', plainText: '', ok: false };
  let savedInsertionRange = null;
  let activeTab = 'paste';
  let toastTimer;

  function previewDocument(html, frame) {
    const available = Math.max(160, (frame?.clientWidth || 280) - 20);
    const scale = Math.min(1, available / 677);
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline'"><style>html,body{margin:0;overflow-x:hidden}body{box-sizing:border-box;width:677px;padding:16px;font:15px/1.8 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;color:#333;word-break:break-word;zoom:${scale}}img{max-width:100%;height:auto}</style></head><body>${html || '<p style="color:#A2A8A4;text-align:center;margin-top:30px">预览会显示在这里</p>'}</body></html>`;
  }

  function updateConnection() {
    const connected = Boolean(findEditor());
    dot.classList.toggle('ready', connected);
    connectionText.textContent = connected ? '正文已连接' : '未找到正文';
  }

  function setStatus(element, message, type = '') {
    element.textContent = message;
    element.className = `status ${type}`.trim();
  }

  function showToast(message) {
    toastElement.textContent = message;
    toastElement.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastElement.classList.remove('show'), 2600);
  }

  function transformPaste() {
    currentPaste = transformer.transformHTML(pasteSource.value);
    pastePreview.srcdoc = previewDocument(currentPaste.html, pastePreview);
    pasteCopy.disabled = !currentPaste.ok;
    pasteApply.disabled = !currentPaste.ok;
    setStatus(pasteStatus, currentPaste.ok ? '可复制，也可直接插入正文' : '输入 HTML 后即可准备', currentPaste.ok ? 'ready' : '');
  }

  function transformEdit() {
    currentEdit = transformer.transformHTML(editSource.value);
    editPreview.srcdoc = previewDocument(currentEdit.html, editPreview);
    editCopy.disabled = !currentEdit.ok;
    editApply.disabled = !currentEdit.ok;
    setStatus(editStatus, currentEdit.ok ? '修改完成后可直接应用到正文' : '读取正文后即可修改', currentEdit.ok ? 'ready' : '');
  }

  function readCurrentArticle() {
    const editor = findEditor();
    updateConnection();
    if (!editor) {
      editSource.value = '';
      currentEdit = { html: '', plainText: '', ok: false };
      editPreview.srcdoc = previewDocument('', editPreview);
      editCopy.disabled = true;
      editApply.disabled = true;
      setStatus(editStatus, '请先打开公众号正文编辑页面', 'error');
      return;
    }
    editSource.value = editor.innerHTML;
    transformEdit();
    readButton.textContent = '重新读取';
    setStatus(editStatus, '已读取当前正文', 'ready');
  }

  function switchTab(name) {
    activeTab = name;
    tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
    views.forEach(view => view.classList.toggle('active', view.dataset.view === name));
    if (name === 'edit' && !editSource.value) readCurrentArticle();
    requestAnimationFrame(() => (name === 'paste' ? pasteSource : editSource).focus());
  }

  function rememberEditorSelection() {
    const editor = findEditor();
    if (!editor) { savedInsertionRange = null; return; }
    const selection = editor.ownerDocument.defaultView?.getSelection();
    if (!selection?.rangeCount) { savedInsertionRange = null; return; }
    const range = selection.getRangeAt(0);
    const node = range.commonAncestorContainer;
    savedInsertionRange = node === editor || editor.contains(node) ? range.cloneRange() : null;
  }

  function open() {
    rememberEditorSelection();
    host.style.display = 'block';
    updateConnection();
    requestAnimationFrame(() => {
      panel.classList.add('open');
      (activeTab === 'paste' ? pasteSource : editSource).focus();
    });
  }

  function close() {
    panel.classList.remove('open');
    setTimeout(() => { host.style.display = 'none'; }, 210);
  }

  pasteSource.addEventListener('input', transformPaste);
  editSource.addEventListener('input', transformEdit);
  readButton.addEventListener('click', readCurrentArticle);
  $('.close').addEventListener('click', close);
  tabs.forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  pasteCopy.addEventListener('click', async () => {
    if (!currentPaste.ok) return;
    pasteCopy.disabled = true;
    const copied = await writeClipboard(currentPaste.html, currentPaste.plainText);
    if (!copied) { pasteCopy.disabled = false; setStatus(pasteStatus, '复制失败，请检查浏览器权限', 'error'); return; }
    pasteCopy.textContent = '已复制 ✓';
    pasteCopy.classList.add('success');
    setTimeout(() => { pasteCopy.textContent = '复制结果'; pasteCopy.classList.remove('success'); pasteCopy.disabled = false; }, 1800);
    const editor = findEditor();
    if (editor) {
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setStatus(pasteStatus, '已复制，请在正文中粘贴', 'ready');
    showToast('已复制，请按 Cmd/Ctrl + V 粘贴');
  });

  pasteApply.addEventListener('click', async () => {
    if (!currentPaste.ok) return;
    const editor = findEditor();
    updateConnection();
    if (!editor) {
      setStatus(pasteStatus, '未找到正文，请先打开公众号编辑页面', 'error');
      return;
    }
    pasteApply.disabled = true;
    const applied = await applyHTMLToEditor(editor, currentPaste.html, currentPaste.plainText, {
      replaceAll: false,
      savedRange: savedInsertionRange,
    });
    if (!applied) {
      pasteApply.disabled = false;
      const copied = await writeClipboard(currentPaste.html, currentPaste.plainText);
      setStatus(pasteStatus, copied ? '微信未接受自动插入，结果已复制，请手动粘贴' : '微信未接受自动插入，请使用“复制结果”', 'error');
      if (copied) showToast('已复制，请在正文中粘贴');
      return;
    }
    rememberEditorSelection();
    pasteApply.textContent = '已插入 ✓';
    pasteApply.classList.add('success');
    setStatus(pasteStatus, '已插入公众号正文', 'ready');
    showToast('已插入到正文');
    setTimeout(() => {
      pasteApply.textContent = '插入到正文';
      pasteApply.classList.remove('success');
      pasteApply.disabled = false;
    }, 1800);
  });

  editCopy.addEventListener('click', async () => {
    if (!currentEdit.ok) return;
    editCopy.disabled = true;
    const copied = await writeClipboard(currentEdit.html, currentEdit.plainText);
    if (!copied) { editCopy.disabled = false; setStatus(editStatus, '复制失败，请检查浏览器权限', 'error'); return; }
    editCopy.textContent = '已复制 ✓';
    editCopy.classList.add('success');
    setTimeout(() => { editCopy.textContent = '复制结果'; editCopy.classList.remove('success'); editCopy.disabled = false; }, 1800);
    setStatus(editStatus, '已复制结果', 'ready');
    showToast('已复制结果');
  });

  editApply.addEventListener('click', async () => {
    if (!currentEdit.ok) return;
    const editor = findEditor();
    updateConnection();
    if (!editor) {
      setStatus(editStatus, '未找到正文，请重新打开编辑页后读取', 'error');
      return;
    }
    editApply.disabled = true;
    const applied = await applyHTMLToEditor(editor, currentEdit.html, currentEdit.plainText, { replaceAll: true });
    if (!applied) {
      editApply.disabled = false;
      const copied = await writeClipboard(currentEdit.html, currentEdit.plainText);
      setStatus(editStatus, copied ? '微信未接受自动写入，结果已复制，请手动粘贴' : '微信未接受自动写入，请使用“复制结果”', 'error');
      if (copied) showToast('已复制，请在正文中粘贴');
      return;
    }
    editApply.textContent = '已应用 ✓';
    editApply.classList.add('success');
    setStatus(editStatus, '已同步到公众号正文', 'ready');
    showToast('已应用到正文');
    setTimeout(() => {
      editApply.textContent = '应用到正文';
      editApply.classList.remove('success');
      editApply.disabled = false;
    }, 1800);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && host.style.display !== 'none') close();
  });
  chrome.runtime.onMessage.addListener(message => { if (message?.type === 'MP_HTML_SHOW') open(); });

  globalThis.__MP_HTML_PANEL_V2__ = Object.freeze({ open, close });
  pastePreview.srcdoc = previewDocument('', pastePreview);
  editPreview.srcdoc = previewDocument('', editPreview);
  open();
})();
