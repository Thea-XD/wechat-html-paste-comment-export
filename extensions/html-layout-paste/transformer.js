/* 微信公众号 HTML 本地转换模块
 * Interface: transformHTML(rawHTML) -> { html, plainText, ok }
 */
(function installTransformer() {
  'use strict';

  if (globalThis.__MP_HTML_TRANSFORMER__) return;

  const BLOCKED_TAGS = new Set([
    'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON',
    'SELECT', 'TEXTAREA', 'LINK', 'META', 'BASE', 'NOSCRIPT', 'TEMPLATE',
  ]);

  const ALLOWED_STYLE = new Set([
    'box-sizing', 'display', 'float', 'clear',
    'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'color', 'background', 'background-color', 'background-image',
    'background-size', 'background-position', 'background-repeat',
    'border', 'border-width', 'border-style', 'border-color',
    'border-top', 'border-right', 'border-bottom', 'border-left', 'border-radius',
    'box-shadow', 'opacity',
    'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
    'text-align', 'text-decoration', 'text-indent', 'text-transform',
    'white-space', 'word-break', 'overflow', 'overflow-x', 'overflow-y',
    'vertical-align', 'pointer-events', 'user-select',
  ]);

  const SAFE_URL_ATTRS = new Set(['href', 'src', 'data-src', 'poster', 'xlink:href']);
  const WECHAT_PROTECTED = 'svg,mp-common-miniprogram,[data-miniprogram-appid],a.weapp_text_link,.js_weapp_entry,.weapp_text_link';

  function specificity(selector) {
    const clean = selector.replace(/:not\(([^)]*)\)/g, ' $1 ');
    const ids = (clean.match(/#[\w-]+/g) || []).length;
    const classes = (clean.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) || []).length;
    const types = (clean
      .replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g, ' ')
      .match(/(^|[\s>+~,(])(?:[a-zA-Z][\w-]*|\*)/g) || []).filter(x => !x.includes('*')).length;
    return [ids, classes, types];
  }

  function compareCandidate(a, b) {
    if (!a) return -1;
    if (a.important !== b.important) return a.important ? 1 : -1;
    for (let i = 0; i < 3; i++) {
      if (a.spec[i] !== b.spec[i]) return a.spec[i] > b.spec[i] ? 1 : -1;
    }
    return a.order === b.order ? 0 : (a.order > b.order ? 1 : -1);
  }

  function collectRules(cssText) {
    if (!cssText.trim() || typeof CSSStyleSheet === 'undefined') return [];
    const sheet = new CSSStyleSheet();
    try { sheet.replaceSync(cssText); } catch (_) { return []; }
    const result = [];
    let order = 0;

    function visit(rules) {
      for (const rule of rules) {
        if (rule.type === CSSRule.STYLE_RULE) {
          const selectors = rule.selectorText.split(',').map(s => s.trim()).filter(Boolean);
          selectors.forEach(selector => result.push({
            selector,
            spec: specificity(selector),
            style: rule.style,
            order: order++,
          }));
        } else if (rule.type === CSSRule.MEDIA_RULE) {
          // The destination is a WeChat article canvas (up to 677px), not the
          // desktop width of the page where the extension happens to run.
          const max = rule.conditionText.match(/max-width\s*:\s*([\d.]+)px/i);
          const min = rule.conditionText.match(/min-width\s*:\s*([\d.]+)px/i);
          const applies = (!max || 677 <= Number(max[1])) && (!min || 677 >= Number(min[1]));
          if (applies) visit(rule.cssRules);
        } else if (rule.cssRules) {
          visit(rule.cssRules);
        }
      }
    }

    visit(sheet.cssRules);
    return result;
  }

  function resolveVars(value, vars, depth = 0) {
    if (!value || depth > 8) return value;
    return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]+))?\)/g, (_, name, fallback = '') => {
      const replacement = vars.get(name) || fallback.trim();
      return resolveVars(replacement, vars, depth + 1);
    });
  }

  function inlineStyleRules(root, cssText) {
    const rules = collectRules(cssText);
    const inheritedVars = new WeakMap();
    const globalVars = new Map();

    rules.forEach(rule => {
      if (!/(^|\s|,)(:root|html|body)(?:\s|,|$)/i.test(rule.selector)) return;
      for (const prop of rule.style) {
        if (prop.startsWith('--')) globalVars.set(prop, rule.style.getPropertyValue(prop).trim());
      }
    });

    [root, ...root.querySelectorAll('*')].forEach(el => {
      const candidates = new Map();
      const parentVars = el.parentElement ? inheritedVars.get(el.parentElement) : null;
      const vars = new Map(parentVars || globalVars);

      for (const rule of rules) {
        let matches = false;
        try { matches = el.matches(rule.selector); } catch (_) {}
        if (!matches) continue;

        for (const prop of rule.style) {
          const candidate = {
            value: rule.style.getPropertyValue(prop).trim(),
            important: rule.style.getPropertyPriority(prop) === 'important',
            spec: rule.spec,
            order: rule.order,
          };
          const current = candidates.get(prop);
          if (!current || compareCandidate(current, candidate) < 0) candidates.set(prop, candidate);
        }
      }

      for (const prop of el.style) {
        candidates.set(prop, {
          value: el.style.getPropertyValue(prop).trim(),
          important: el.style.getPropertyPriority(prop) === 'important',
          spec: [1000, 0, 0],
          order: Number.MAX_SAFE_INTEGER,
        });
      }

      for (const [prop, candidate] of candidates) {
        if (prop.startsWith('--')) vars.set(prop, resolveVars(candidate.value, vars));
      }
      inheritedVars.set(el, vars);

      const output = [];
      for (const [prop, candidate] of candidates) {
        if (!ALLOWED_STYLE.has(prop)) continue;
        const value = resolveVars(candidate.value, vars).replace(/\s*!important\s*/gi, '').trim();
        if (value && !/expression\s*\(|javascript\s*:/i.test(value)) output.push(`${prop}:${value}`);
      }
      if (output.length) el.setAttribute('style', output.join(';'));
      else el.removeAttribute('style');
    });
  }

  function sanitize(root) {
    root.querySelectorAll('*').forEach(el => {
      if (BLOCKED_TAGS.has(el.tagName)) {
        el.remove();
        return;
      }

      [...el.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'nonce') {
          el.removeAttribute(attr.name);
        } else if (SAFE_URL_ATTRS.has(name) && /^\s*(?:javascript|vbscript|data:text\/html)\s*:/i.test(value)) {
          el.removeAttribute(attr.name);
        }
      });
    });

    root.querySelectorAll('.ProseMirror-separator').forEach(el => el.remove());
    root.querySelectorAll('.ProseMirror-trailingBreak').forEach(el => el.remove());

    root.querySelectorAll('img').forEach(img => {
      if (img.closest(WECHAT_PROTECTED)) return;
      img.removeAttribute('width');
      img.removeAttribute('height');
      const style = img.getAttribute('style') || '';
      const suffix = 'max-width:100%;height:auto';
      img.setAttribute('style', `${style}${style && !style.endsWith(';') ? ';' : ''}${suffix}`);
    });
  }

  function pxNumber(value) {
    const match = String(value || '').trim().match(/^(-?[\d.]+)px$/i);
    return match ? Number(match[1]) : null;
  }

  function hasReadableText(el) {
    return Boolean((el.textContent || '').replace(/\s+/g, ' ').trim());
  }

  function replaceTag(el, tagName) {
    const replacement = el.ownerDocument.createElement(tagName);
    [...el.attributes].forEach(attr => replacement.setAttribute(attr.name, attr.value));
    while (el.firstChild) replacement.appendChild(el.firstChild);
    el.replaceWith(replacement);
    return replacement;
  }

  function appendStyle(el, declarations) {
    Object.entries(declarations).forEach(([prop, value]) => {
      if (!el.style.getPropertyValue(prop)) el.style.setProperty(prop, value);
    });
  }

  function convertWebLayoutToArticle(root) {
    root.querySelectorAll('main,article,header,footer,aside,nav,div').forEach(el => replaceTag(el, 'section'));

    [root, ...root.querySelectorAll('*')].forEach(el => {
      if (el.closest(WECHAT_PROTECTED)) return;
      const style = el.style;
      const display = style.display;
      if (display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid') {
        style.display = display.startsWith('inline') ? 'inline-block' : 'block';
      }

      ['flex', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap',
       'justify-content', 'align-items', 'align-content', 'align-self', 'gap', 'row-gap',
       'column-gap', 'grid', 'grid-template-columns', 'grid-template-rows', 'grid-area',
       'grid-column', 'grid-row'].forEach(prop => style.removeProperty(prop));

      if (/^(absolute|fixed|sticky)$/.test(style.position)) {
        style.position = 'static';
        ['inset', 'top', 'right', 'bottom', 'left', 'z-index'].forEach(prop => style.removeProperty(prop));
      }
      style.removeProperty('transform');
      style.removeProperty('transform-origin');

      if (hasReadableText(el) && !/^(SVG|IMG)$/.test(el.tagName)) {
        style.removeProperty('min-height');
        style.removeProperty('max-height');
        if (style.height) style.removeProperty('height');
        if (style.overflow === 'hidden' || style.overflowY === 'hidden') {
          style.removeProperty('overflow');
          style.removeProperty('overflow-y');
        }
      }
    });

    root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(heading => {
      const level = Number(heading.tagName.slice(1));
      const paragraph = replaceTag(heading, 'p');
      if (level <= 2) appendStyle(paragraph, {
        'font-size': '24px', 'font-weight': '700', 'line-height': '1.4',
        'margin': '30px 0 18px', 'padding-left': '10px', 'border-left': '4px solid #07C160',
      });
      else appendStyle(paragraph, {
        'font-size': '19px', 'font-weight': '700', 'line-height': '1.5', 'margin': '22px 0 12px',
      });
    });

    root.querySelectorAll('p').forEach(p => appendStyle(p, {
      'margin': '0 0 14px', 'line-height': '1.8', 'white-space': 'normal', 'word-break': 'break-word',
    }));
    root.querySelectorAll('ul,ol').forEach(list => appendStyle(list, {
      'margin': '0 0 14px', 'padding-left': '1.4em', 'line-height': '1.8',
    }));
    root.querySelectorAll('li').forEach(li => appendStyle(li, { 'margin-bottom': '6px' }));
    root.querySelectorAll('blockquote').forEach(quote => appendStyle(quote, {
      'margin': '18px 0', 'padding': '10px 14px', 'border-left': '3px solid #AEB8B2',
      'background-color': '#F6F8F7', 'color': '#555555', 'line-height': '1.8',
    }));
    root.querySelectorAll('table').forEach(table => appendStyle(table, {
      'width': '100%', 'max-width': '100%', 'border-collapse': 'collapse', 'table-layout': 'fixed',
    }));
  }

  function normalizeForWechat(root) {
    root.querySelectorAll('pre').forEach(pre => {
      if (pre.querySelector('code')) {
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.wordBreak = 'break-word';
        pre.style.overflowWrap = 'anywhere';
        return;
      }
      const paragraph = root.ownerDocument.createElement('p');
      paragraph.innerHTML = pre.innerHTML;
      paragraph.setAttribute('style', pre.getAttribute('style') || '');
      paragraph.style.whiteSpace = 'normal';
      pre.replaceWith(paragraph);
    });

    root.querySelectorAll('*').forEach(el => {
      if (el.closest(WECHAT_PROTECTED)) return;
      const style = el.style;
      if (!style) return;

      if (style.textAlign === 'start') style.textAlign = 'left';
      if (style.textAlign === 'end') style.textAlign = 'right';

      const width = pxNumber(style.width);
      if (width && width > 320 && !el.hasAttribute('data-ignore-width')) {
        style.maxWidth = `${width}px`;
        style.width = '100%';
        if (!style.marginLeft) style.marginLeft = 'auto';
        if (!style.marginRight) style.marginRight = 'auto';
      }

      const marginLeft = pxNumber(style.marginLeft);
      const marginRight = pxNumber(style.marginRight);
      if (marginLeft && Math.abs(marginLeft) > 80) style.marginLeft = '0px';
      if (marginRight && Math.abs(marginRight) > 80) style.marginRight = '0px';

      if (hasReadableText(el)) {
        const fontSize = pxNumber(style.fontSize) || 16;
        const lineHeight = pxNumber(style.lineHeight);
        if (lineHeight !== null && lineHeight < fontSize) style.lineHeight = '1.5';

        const height = pxNumber(style.height);
        if (height !== null && (height === 0 || style.overflow === 'hidden')) {
          style.removeProperty('height');
          if (style.overflow === 'hidden') style.removeProperty('overflow');
        }
      }

      if (el.tagName === 'IMG' && Number(style.opacity) === 0) style.opacity = '1';
    });

    convertWebLayoutToArticle(root);

    root.querySelectorAll('span[leaf]').forEach(span => {
      if ([...span.children].some(child => /^(SECTION|DIV|P|ARTICLE|HEADER|FOOTER|TABLE|UL|OL|LI)$/.test(child.tagName))) {
        span.removeAttribute('leaf');
      }
    });
    root.querySelectorAll('section[nodeleaf]').forEach(section => {
      if ([...section.children].some(child => !/^(IMG|MP-COMMON-MINIPROGRAM)$/.test(child.tagName))) {
        section.removeAttribute('nodeleaf');
      }
    });

    let changed = true;
    let passes = 0;
    while (changed && passes++ < 12) {
      changed = false;
      root.querySelectorAll('section,div,span').forEach(el => {
        if (el.children.length !== 1 || [...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) return;
        const child = el.firstElementChild;
        if (!child || child.tagName !== el.tagName || child.getAttribute('style') !== el.getAttribute('style')) return;
        el.replaceWith(child);
        changed = true;
      });
    }
  }

  function transformHTML(rawHTML) {
    if (typeof rawHTML !== 'string' || !rawHTML.trim()) {
      return { html: '', plainText: '', ok: false };
    }

    // Parse the complete document. Wrapping a full <html>/<head>/<body> document in
    // another body loses its <style> rules, which is why rich layouts used to paste
    // as unstyled text in the WeChat editor.
    const parsed = new DOMParser().parseFromString(rawHTML, 'text/html');
    const root = parsed.body;
    const cssText = [...parsed.querySelectorAll('style')].map(el => el.textContent || '').join('\n');
    parsed.querySelectorAll('style').forEach(el => el.remove());

    sanitize(root);
    inlineStyleRules(root, cssText);
    normalizeForWechat(root);
    sanitize(root);

    const wrapper = parsed.createElement('section');
    const bodyStyle = root.getAttribute('style') || '';
    wrapper.setAttribute('style', bodyStyle);
    while (root.firstChild) wrapper.appendChild(root.firstChild);
    root.appendChild(wrapper);
    appendStyle(wrapper, {
      'box-sizing': 'border-box', 'width': '100%', 'max-width': '100%', 'margin': '0 auto',
      'padding': '8px 4px 28px', 'font-size': '16px', 'line-height': '1.8',
      'color': '#3E3E3E', 'word-break': 'break-word',
    });

    root.querySelectorAll('*').forEach(el => {
      if (el.closest(WECHAT_PROTECTED)) return;
      el.removeAttribute('id');
      if (el.matches('img.rich_pages,img.wxw-img')) {
        const allowed = [...el.classList].filter(name => name === 'rich_pages' || name === 'wxw-img');
        if (allowed.length) el.className = allowed.join(' ');
        else el.removeAttribute('class');
      } else {
        el.removeAttribute('class');
      }
    });

    const plainText = (root.innerText || root.textContent || '').trim();
    const hasMedia = Boolean(root.querySelector('img,svg,mp-common-miniprogram'));
    return {
      html: wrapper.outerHTML.trim(),
      plainText,
      ok: Boolean(plainText || hasMedia),
    };
  }

  globalThis.__MP_HTML_TRANSFORMER__ = Object.freeze({ transformHTML });
})();
