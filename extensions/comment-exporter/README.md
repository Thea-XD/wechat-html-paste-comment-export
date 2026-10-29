# 微信公众号留言导出工具（Manifest V3）

最小可用版。它把已在 Chrome DevTools Console 验证成功的分页请求直接封装为扩展按钮：在当前留言管理页的 `MAIN` world 中，基于 `location.href` 构造 `action=list_comment` 请求并导出 CSV。

版本：`1.0.0`　最低 Chrome：`95`

## 项目结构

```text
wechat-comment-exporter/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── icons/icon-source.png  # 与 HTML 排版粘贴插件统一的图标母版
├── icons/icon16.png
├── icons/icon32.png
├── icons/icon48.png
├── icons/icon128.png
└── README.md
```

没有 `content.js`、没有 service worker、没有后端。请求和下载逻辑都由 popup 发起；抓取函数只在当前微信页面的 `MAIN` world 运行。

## 请求逻辑

点击“导出全部留言”后，扩展在当前标签执行与已验证 Console 版一致的逻辑：

```js
const u = new URL(location.href);
u.searchParams.set('action', 'list_comment');
u.searchParams.set('count', '20');
u.searchParams.set('begin', String(begin));
u.searchParams.set('f', 'json');
u.searchParams.set('ajax', '1');

const r = await fetch(u.toString(), { credentials: 'include' });
```

- 优先复用当前页面刚加载留言时的完整 `list_comment` 请求 URL（含微信动态参数），再按 `begin=0/20/40...` 变更分页参数；找不到该记录时才回退到 `location.href`。页与页之间等待 300ms。
- 若公众号后台把留言页放在同源子 frame 中，扩展会在所有同源 frame 的 `MAIN` world 执行该逻辑，并使用实际返回留言的结果。
- `comment_list` 为字符串时会 `JSON.parse` 后读取 `data.comment`。
- 空页或少于 20 条时结束；`begin > 5000` 时强制停止，防止异常循环。
- 按 `content_id` 去重；缺失时按“昵称 + 时间 + 内容”去重。
- 文件名为 `文章标题_留言_XXX条.csv`，使用 UTF-8 BOM，Excel/WPS 可正常打开中文。

## 安装 / 更新

1. 打开 Chrome：`chrome://extensions`。
2. 打开右上角的**开发者模式**。
3. 如果已加载旧版本，请先删除旧版，或在其卡片上点击“重新加载”。
4. 点击**加载已解压的扩展程序**。
5. 选择本文件夹 `wechat-comment-exporter`；选中后应直接能看到 `manifest.json`。
6. 扩展卡片与弹窗右上角都应显示 `1.0.0`。
7. 刷新已打开的微信公众号留言管理页。

## 测试

1. 使用同一个 Chrome 用户配置登录微信公众号后台。
2. 打开一篇文章的留言管理页，地址必须以以下内容开头：

   ```text
   https://mp.weixin.qq.com/misc/appmsgcomment
   ```

3. 点击扩展图标，确认弹窗显示“已识别留言管理页”。
4. 点击**导出全部留言**，等待“正在导出，请稍候…”结束；不要在导出时关闭弹窗。
5. 成功后在 Chrome 下载列表（`chrome://downloads`）中查看 CSV。

## 排错

- **弹窗版本不是 1.0.0**：Chrome 仍在运行旧目录。删除旧版后重新选择新版文件夹。
- **提示 `ret=-1 system error`**：先刷新该文章留言页，等待留言列表实际显示出来，再点击导出。本版本会同时检查顶层页面与同源子 frame，并自动复用页面刚才成功加载留言的完整请求参数；如果仍失败，请发送新的完整报错截图，不要发送 token 值。
- **提示登录失效或非 JSON**：刷新后台并重新登录后再试。
- **找不到下载文件**：打开 `chrome://downloads`，确认 Chrome 没有拦截下载。

## 权限与隐私

- `activeTab`：用户点击扩展后，临时允许扩展访问当前标签；关闭或切换标签后不会保留这项访问权。
- `scripting`：在当前标签的 `MAIN` world 执行已验证的页面请求函数。

扩展没有声明持久化的站点权限；代码仍会严格校验当前地址必须是
`https://mp.weixin.qq.com/misc/appmsgcomment`，因此在其他页面不会执行留言请求。

扩展不请求 `cookies`、`webRequest`、`downloads` 权限；不读取/保存 Cookie 或 token，不上传留言数据，不使用第三方 SDK、远程代码或服务器。

为复用微信后台刚刚发出的、可能包含动态参数的 `list_comment` 请求，页面脚本会在内存中读取
`performance` 的资源 URL，并只保留同源的请求地址用于本次分页。该地址（包括动态参数）不会写入存储、日志或网络上报；导出的留言也只在本地生成 CSV。

`allFrames: true` 是为了兼容留言列表位于同源 frame 的页面版本；扩展只使用返回留言的同源 frame 结果，不保存 frame 内容。

## 图标

图标与“公众号 HTML 排版粘贴”插件采用同一套绿色工具视觉：圆润剪贴板角色、薄荷色背景与右下角下载标记。中央的留言气泡用于区分“留言导出”功能。Manifest 分别使用 16、32、48、128 像素文件，避免由浏览器临时缩放导致工具栏图标发糊。
