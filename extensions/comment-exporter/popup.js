const articleTitle = document.getElementById("articleTitle");
const exportButton = document.getElementById("exportButton");
const status = document.getElementById("status");
const progress = document.getElementById("progress");
const version = document.getElementById("version");
const buttonText = document.getElementById("buttonText");

version.textContent = `v${chrome.runtime.getManifest().version}`;

let currentTabId = null;

function isCommentPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://mp.weixin.qq.com" && /^\/misc\/appmsgcomment\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function showStatus(message, kind = "") {
  status.textContent = message;
  status.className = `status ${kind}`;
  document.body.classList.remove("is-success", "is-error");
  if (kind === "success") document.body.classList.add("is-success");
  if (kind === "error") document.body.classList.add("is-error");
}

function setTitle(title) {
  const text = String(title || "当前文章");
  articleTitle.textContent = text;
  articleTitle.title = text;
}

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function formatTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

function csvCell(value) {
  return `"${text(value).replace(/"/g, '""')}"`;
}

function getReplies(comment) {
  const first = comment?.new_reply?.reply_list;
  if (Array.isArray(first)) return first;
  const fallback = comment?.reply?.reply_list;
  return Array.isArray(fallback) ? fallback : [];
}

function makeCsv(comments) {
  const headers = [
    "序号", "昵称", "留言内容", "留言时间", "点赞数", "IP地区", "是否精选", "是否置顶",
    "历史留言", "关注信息", "回复数量", "公众号回复"
  ];

  const rows = comments.map((comment, index) => {
    const replies = getReplies(comment);
    const replyText = replies.map((reply) => {
      const content = reply?.rich_content?.rich_text || reply?.content || "";
      return `${text(reply?.nick_name)}：${text(content)}`;
    }).join(" | ");

    const replyCount = comment?.new_reply?.reply_total_cnt ?? replies.length;
    return [
      index + 1,
      comment?.nick_name,
      comment?.rich_content?.rich_text || comment?.content,
      formatTime(comment?.post_time),
      comment?.like_num ?? 0,
      comment?.ip_wording,
      Number(comment?.is_elected) === 1 ? "是" : "否",
      Boolean(Number(comment?.is_top)) ? "是" : "否",
      comment?.tag_info?.first_tag,
      comment?.tag_info?.second_tag,
      replyCount,
      replyText
    ].map(csvCell).join(",");
  });

  return `\uFEFF${[headers.map(csvCell).join(","), ...rows].join("\r\n")}`;
}

function safeFileTitle(title) {
  return text(title)
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 60) || "公众号留言";
}

function downloadCsv(comments, title) {
  const url = URL.createObjectURL(new Blob([makeCsv(comments)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileTitle(title)}_留言_${comments.length}条.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// 此函数会被序列化并在 mp.weixin.qq.com 的 MAIN world 运行。
// 函数体不引用 popup 的任何变量，刻意复刻已经验证过的 Console 请求方式。
async function fetchAllCommentsInPage() {
  const pageSize = 20;
  const maxBegin = 5000;
  const allComments = [];
  let begin = 0;
  let title = "";

  // 页面地址可能不包含微信实际 list_comment 请求所需的全部动态参数。
  // 仅在本次页面内存中短暂复用最近的同源请求 URL，只改分页参数；不存储、不上报该 URL。
  let baseHref = location.href;
  try {
    const entries = performance.getEntriesByType("resource");
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const candidate = new URL(entries[index].name);
      if (
        candidate.origin === location.origin &&
        candidate.searchParams.get("action") === "list_comment"
      ) {
        baseHref = candidate.toString();
        break;
      }
    }
  } catch {
    // Resource Timing 不可用时，回退到 location.href 方案。
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  while (true) {
    const u = new URL(baseHref);
    u.searchParams.set("action", "list_comment");
    u.searchParams.set("count", String(pageSize));
    u.searchParams.set("begin", String(begin));
    u.searchParams.set("f", "json");
    u.searchParams.set("ajax", "1");

    let response;
    try {
      response = await fetch(u.toString(), { credentials: "include" });
    } catch (error) {
      return { ok: false, error: `请求留言接口失败：${error?.message || "网络错误"}` };
    }

    if (!response.ok) {
      return { ok: false, error: `请求留言接口失败：HTTP ${response.status} ${response.statusText || ""}`.trim() };
    }

    let raw;
    try {
      raw = await response.json();
    } catch {
      return { ok: false, error: "接口返回不是 JSON。登录态可能已失效，请重新登录公众号后台。" };
    }

    const ret = raw?.base_resp?.ret;
    if (ret !== undefined && ret !== null && Number(ret) !== 0) {
      return {
        ok: false,
        error: `接口返回错误（ret=${ret}）：${raw.base_resp?.err_msg || raw.base_resp?.msg || "未知错误"}。请刷新留言页后重试。`
      };
    }

    if (!title && raw?.title) title = String(raw.title);

    let data = raw;
    if (typeof raw?.comment_list === "string") {
      try {
        data = JSON.parse(raw.comment_list);
      } catch {
        return { ok: false, error: "comment_list JSON 解析失败。请刷新留言管理页后重试。" };
      }
    }

    const comments = Array.isArray(data?.comment) ? data.comment : [];
    if (comments.length === 0) break;
    allComments.push(...comments);

    if (comments.length < pageSize) break;
    begin += pageSize;
    if (begin > maxBegin) break;
    await wait(300);
  }

  const seen = new Set();
  const comments = allComments.filter((comment) => {
    const content = comment?.rich_content?.rich_text || comment?.content || "";
    const key = comment?.content_id || `${comment?.nick_name || ""}\u0000${comment?.post_time || ""}\u0000${content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { ok: true, title, comments };
}

async function preparePopup() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isCommentPage(tab.url || tab.pendingUrl)) {
    setTitle("未检测到留言管理页");
    showStatus("请先打开微信公众号后台的文章留言管理页。", "error");
    return;
  }

  currentTabId = tab.id;
  setTitle(tab.title || "当前文章");
  showStatus("已识别留言管理页。点击按钮后读取文章标题与全部留言。", "");
  exportButton.disabled = false;
}

exportButton.addEventListener("click", async () => {
  if (currentTabId === null || exportButton.disabled) return;
  exportButton.disabled = true;
  document.body.classList.add("is-loading");
  buttonText.textContent = "正在整理留言…";
  progress.textContent = "正在导出，请稍候…";
  showStatus("");

  try {
    const results = await chrome.scripting.executeScript({
      // Console 中的 <other> 可能对应页面内的同源 frame；逐个尝试后使用真正返回留言的结果。
      target: { tabId: currentTabId, allFrames: true },
      world: "MAIN",
      func: fetchAllCommentsInPage
    });
    const frameResults = results.map((item) => item.result).filter(Boolean);
    const result = frameResults.find((item) => item.ok && Array.isArray(item.comments) && item.comments.length > 0)
      || frameResults.find((item) => item.ok);
    if (!result) {
      const errors = frameResults
        .filter((item) => item?.error)
        .map((item) => item.error);
      throw new Error(errors[0] || "页面没有返回结果。请刷新留言管理页后重试。");
    }
    if (!result.ok) throw new Error(result.error || "读取留言失败。");

    const comments = Array.isArray(result.comments) ? result.comments : [];
    if (result.title) setTitle(result.title);
    downloadCsv(comments, result.title || articleTitle.textContent);
    progress.textContent = `已获取 ${comments.length} 条`;
    showStatus(`导出成功：${comments.length} 条主留言已下载。`, "success");
  } catch (error) {
    progress.textContent = "";
    showStatus(error?.message || "导出失败。", "error");
  } finally {
    exportButton.disabled = false;
    document.body.classList.remove("is-loading");
    buttonText.textContent = "导出全部留言";
  }
});

preparePopup().catch((error) => {
  setTitle("无法读取当前页面");
  showStatus(error?.message || "请重新打开留言管理页。", "error");
});
