/* Pi Agent Client — 前端主逻辑 */
(function () {
  "use strict";

  /* ================= IPC 桥 ================= */
  var pending = new Map(), seq = 0, listeners = new Map();
  function hasBridge() { return !!(window.chrome && window.chrome.webview); }
  function send(verb, args) {
    if (!hasBridge()) return Promise.reject(new Error("WebView2 桥不可用"));
    var id = "r" + ++seq;
    return new Promise(function (res, rej) {
      pending.set(id, { res: res, rej: rej });
      window.chrome.webview.postMessage({ id: id, verb: verb, args: args || {} });
    });
  }
  function on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, []);
    listeners.get(ev).push(fn);
  }
  /* 自检用：把一条假的 pi 事件直接喂给监听器。
     WebView2 的 chrome.webview 不是标准 EventTarget，dispatchEvent 不一定生效，所以走 listeners。 */
  function emitEvent(ev, data) {
    var ls = listeners.get(ev) || [];
    for (var i = 0; i < ls.length; i++) { try { ls[i](data); } catch (err) { console.error(err); } }
  }
  if (hasBridge()) {
    window.chrome.webview.addEventListener("message", function (e) {
      var m = e.data;
      if (!m || typeof m !== "object") return;
      if (m.id != null && pending.has(m.id)) {
        var p = pending.get(m.id); pending.delete(m.id);
        if (m.ok) p.res(m.data); else p.rej(new Error((m.data && m.data.error) || "调用失败"));
        return;
      }
      if (m.event) {
        var ls = listeners.get(m.event) || [];
        for (var i = 0; i < ls.length; i++) { try { ls[i](m.data); } catch (err) { console.error(err); } }
      }
    });
  }

  /* ================= 工具函数 ================= */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    // null/undefined 不填文本；0、"" 这类 falsy 但是合法内容要填。
    // 以前写的是 txt != null 判断，但调用方常写 `x || "—"`，
    // 遇到空数组/0 会在某些分支里被吞掉，这里显式只挡 null/undefined。
    if (txt !== null && txt !== undefined && txt !== false) d.textContent = String(txt);
    return d;
  }
  var SVGNS = "http://www.w3.org/2000/svg";
  /* 内联 SVG 图标，避免 emoji 在 Windows 上渲染成方框 */
  function icon(id) {
    var s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("class", "i");
    var u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", "#" + id);
    s.appendChild(u);
    return s;
  }
  function iconEl(cls, id, host) {
    var d = el("span", cls);
    if (id) d.appendChild(icon(id));
    if (host) host.appendChild(d);
    return d;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function fmtNum(n) {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }
  function relTime(ts) {
    var d = typeof ts === "number" ? ts : Date.parse(ts);
    if (!d) return "";
    var s = Math.max(0, (Date.now() - d) / 1000);
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + "分钟前";
    if (s < 86400) return Math.floor(s / 3600) + "小时前";
    if (s < 2592000) return Math.floor(s / 86400) + "天前";
    return new Date(d).toLocaleDateString("zh-CN");
  }
  /* ---- 通知条（照 pi-web 的 NoticeShelf 行为） ----
     常量化都取 pi-web hooks/useAgentSession.ts 的原值，便于跟上游对齐。
     叠卡上限 5、每条可见 5s（悬停/聚焦时暂停并保留剩余时间）、
     超出上限排队、最老的先 0.18s 退场后新生效。 */
  var MAX_NOTICES = 5, NOTICE_VISIBLE_MS = 5000, NOTICE_EXIT_MS = 180;
  var noticeQueue = [];          // 超过上限时排队等位
  var noticeSeq = 0;
  var noticeOldest = null;       // 当前在倒计时的那条
  var noticeRemainMs = NOTICE_VISIBLE_MS;
  var noticeStartedAt = null;    // 本轮计时起点，用于暂停时结算剩余时间
  var noticeTimerH = null;
  var noticePausedId = null;     // 鼠标悬停 / 键盘聚焦就暂停

  function noticeList() { return [].slice.call($("toasts").children); }
  function noticeLive() {
    return noticeList().filter(function (n) { return !n.classList.contains("out"); });
  }
  function noticeKind(k) {
    return k === "error" ? "error" : (k === "warn" || k === "warning") ? "warn" : "";
  }
  // 暂停就是真暂停：把已过去的毫秒从剩余时间里扣掉，恢复时接着走，
  // 而不是重新计 5 秒（否则悬停一下就永远不消失）。
  function noticeCancelTimer() {
    if (noticeTimerH) { clearTimeout(noticeTimerH); noticeTimerH = null; }
    if (noticeStartedAt !== null) {
      noticeRemainMs = Math.max(0, noticeRemainMs - (Date.now() - noticeStartedAt));
      noticeStartedAt = null;
    }
  }
  function noticeFlush() {
    var live = noticeLive();
    while (noticeQueue.length && live.length < MAX_NOTICES) {
      var n = noticeQueue.shift();
      $("toasts").appendChild(n);
      live.push(n);
    }
  }
  // 只有最老那条在倒计时；它走了才轮到下一条重新计 5s。
  function noticeTick() {
    noticeCancelTimer();
    var all = noticeList();
    if (!all.length) { noticeOldest = null; noticeRemainMs = NOTICE_VISIBLE_MS; noticeFlush(); return; }
    var out = null;
    for (var i = 0; i < all.length; i++) if (all[i].classList.contains("out")) { out = all[i]; break; }
    if (out) {
      noticeTimerH = setTimeout(function () {
        out.remove(); noticeOldest = null; noticeTick();
      }, NOTICE_EXIT_MS);
      return;
    }
    var oldest = all[0];
    if (noticeOldest !== oldest) { noticeOldest = oldest; noticeRemainMs = NOTICE_VISIBLE_MS; }
    if (noticePausedId) return;                 // 悬停/聚焦中，倒计时冻结
    noticeStartedAt = Date.now();
    noticeTimerH = setTimeout(function () {
      noticeTimerH = null; noticeStartedAt = null;
      oldest.classList.add("out");
      noticeTick();
    }, noticeRemainMs);
  }
  function noticeClose(n) {
    noticeCancelTimer();
    n.remove(); noticeOldest = null; noticeTick();
  }
  function noticeBuild(msg, k) {
    var n = el("div", "toast" + (k ? " " + k : ""));
    n.id = "notice" + (++noticeSeq);
    n.dataset.msg = msg; n.dataset.kind = k;
    n.appendChild(el("span", "dot"));
    n.appendChild(el("span", "tx", msg));
    var acts = el("div", "acts");
    // 长提示（pi 扩展的兼容性建议动辄十几行）默认只露 3 行，
    // 否则一条通知就把右下角铺满，这正是用户截图里那个问题。
    if (msg.split("\n").length > 3 || msg.length > 200) {
      n.classList.add("clamp");
      var tg = el("button", "", "展开全文");
      tg.onclick = function () {
        var on = n.classList.toggle("clamp");
        tg.textContent = on ? "展开全文" : "收起";
      };
      acts.appendChild(tg);
    }
    var cl = el("button", "", "关闭");
    cl.title = "关闭通知";
    cl.onclick = function () { noticeClose(n); };
    acts.appendChild(cl);
    n.appendChild(acts);
    n.addEventListener("mouseenter", function () { noticePausedId = n.id; noticeCancelTimer(); });
    n.addEventListener("mouseleave", function () { if (noticePausedId === n.id) noticePausedId = null; noticeTick(); });
    n.addEventListener("focusin", function () { noticePausedId = n.id; noticeCancelTimer(); });
    n.addEventListener("focusout", function () { if (noticePausedId === n.id) noticePausedId = null; noticeTick(); });
    return n;
  }
  function toasts(msg, kind) {
    msg = String(msg == null ? "" : msg);
    var k = noticeKind(kind);
    var live = noticeLive();
    // 去重：同文同色的提示已经在屏上（比如反复切到同一个模型），
    // 只把倒计时续满，不再叠一张卡片。
    for (var i = 0; i < live.length; i++) {
      if (live[i].dataset.msg === msg && live[i].dataset.kind === k) {
        if (live[i] === live[0]) { noticeRemainMs = NOTICE_VISIBLE_MS; noticeTick(); }
        return;
      }
    }
    // 队列里排队的也算「已在屏上」：满屏时同一条提示会被排进队列两次，
    // 等前面退场后一次冒出两张同文的卡。
    for (var q = 0; q < noticeQueue.length; q++) {
      if (noticeQueue[q].dataset.msg === msg && noticeQueue[q].dataset.kind === k) return;
    }
    var n = noticeBuild(msg, k);
    if (live.length >= MAX_NOTICES) {
      if (!noticeList().some(function (x) { return x.classList.contains("out"); })) {
        live[0].classList.add("out");     // 腾位：最老的先退场，新来的排队
      }
      noticeQueue.push(n);
      noticeTick();
      return;
    }
    $("toasts").appendChild(n);
    noticeTick();
  }

  /* ---- 代码高亮（离线 highlight.js；库缺失/语言未知时降级为纯文本） ---- */
  var HL_AUTOSET = ["javascript", "json", "bash", "powershell", "python", "css", "xml",
    "yaml", "ini", "diff", "rust", "sql", "markdown", "typescript"];
  var HL_EXT = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript",
    tsx: "typescript", json: "json", jsonc: "json", jsonl: "json", css: "css", scss: "scss",
    less: "less", html: "xml", htm: "xml", xml: "xml", svg: "xml", md: "markdown",
    markdown: "markdown", rs: "rust", py: "python", ps1: "powershell", psm1: "powershell",
    psd1: "powershell", bat: "dos", cmd: "dos", sh: "bash", bash: "bash", zsh: "bash",
    toml: "ini", ini: "ini", cfg: "ini", conf: "ini", env: "ini", properties: "ini",
    yml: "yaml", yaml: "yaml", sql: "sql", go: "go", java: "java", c: "c", h: "c",
    cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php", rb: "ruby", lua: "lua",
    kt: "kotlin", diff: "diff", patch: "diff", makefile: "makefile"
  };
  var HL_ALIAS = { ps: "powershell", console: "bash", text: "", txt: "", plain: "", plaintext: "" };
  // 这些工具入参里的 command 是脚本，按对应解释器上色
  var HL_SHELL = { powershell: "powershell", pwsh: "powershell", bash: "bash", sh: "bash",
    shell: "bash", zsh: "bash", cmd: "dos", exec: "bash" };

  /* ---------- 中文文案：工具名 / 参数键 / 工具结果套话 ---------- */
  // 工具名按语义翻中文，卡片标题显示「中文名 + 原名」，查不到就显示原名
  var TOOL_ZH = {
    read: "读取文件", write: "写入文件", edit: "编辑文件", cat: "读取文件", view: "读取文件",
    powershell: "执行命令", pwsh: "执行命令", bash: "执行命令", sh: "执行命令",
    cmd: "执行命令", shell: "执行命令", exec: "执行命令", zsh: "执行命令",
    grep: "搜索内容", find: "查找文件", ls: "列目录", glob: "匹配文件",
    compress: "压缩上下文", decompress: "还原上下文", search_context: "检索上下文",
    acp_status: "上下文用量", acp_cache: "缓存账本",
    acp_delegate: "派子任务", acp_delegate_wait: "等待子任务", acp_delegate_cancel: "取消子任务",
    subagent: "派子任务", subagent_supervisor: "子任务管理",
    web_search: "联网搜索", fetch_content: "抓取网页", get_search_content: "取网页内容",
    source_check: "核查来源", ask_user_question: "向用户提问",
    todo: "待办", task: "任务", image: "图片", screenshot: "截图", notebook: "笔记本",
    mcp: "MCP 工具", mcp_script: "MCP 脚本", mcp_scripting: "MCP 脚本",
    // 各家扩展 / MCP 常见的装饰名（下标表后缀最长匹配）
    read_file: "读取文件", read_text_file: "读取文件", write_file: "写入文件",
    edit_file: "编辑文件", create_file: "写入文件", apply_patch: "打补丁",
    list_dir: "列目录", list_directory: "列目录", list_files: "列目录",
    search_files: "搜索内容", find_files: "查找文件",
    run_command: "执行命令", execute_command: "执行命令", execute_bash: "执行命令"
  };
  // 参数键 -> 中文。查不到就显示原名（自定义工具 / MCP 的键不可能穷举）
  var ARG_ZH = {
    path: "文件", filePath: "文件", file_path: "文件", filepath: "文件", file: "文件",
    filename: "文件", notebook_path: "文件", target: "目标", dir: "目录", cwd: "工作目录",
    offset: "起始行", limit: "行数", startLine: "起始行", endLine: "结束行",
    command: "命令", timeout: "超时(毫秒)", timeoutMs: "超时(毫秒)", description: "说明",
    oldText: "原内容", old_string: "原内容", newText: "新内容", new_string: "新内容",
    edits: "编辑块", replaceAll: "全部替换", content: "内容", text: "文本",
    query: "查询", queries: "查询", pattern: "匹配模式", glob: "文件名匹配",
    url: "网址", urls: "网址", responseId: "响应号", urlIndex: "结果序号", findText: "查找文本",
    blockId: "块号", inline: "内联返回", scope: "范围", view: "视图", sort: "排序",
    numResults: "结果数", workflow: "模式", includeContent: "取全文",
    level: "级别", agent: "角色", task: "任务", runId: "任务号", preset: "预设",
    questions: "问题", topic: "主题", startId: "起始消息", endId: "结束消息", summary: "摘要",
    id: "编号", name: "名称", headers: "请求头", recursive: "递归", all: "全部",
    force: "强制", mode: "方式", type: "类型", format: "格式", source: "来源"
  };
  function toolPath(input) {
    if (!input || typeof input !== "object") return "";
    var keys = ["path", "filePath", "file_path", "filepath", "file", "filename", "notebook_path"];
    for (var i = 0; i < keys.length; i++) {
      var v = input[keys[i]];
      if (typeof v === "string" && v) return v;
    }
    return "";
  }

  function toolZh(name) {
    var k = String(name == null ? "" : name).trim();
    var low = k.toLowerCase();
    if (TOOL_ZH[low]) return TOOL_ZH[low];
    // MCP / 扩展常见的装饰名：mcp__fs__read_file、read_file、read-files
    // 从最长的后缀（最多 3 段）开始试，最后才退到单个词根。
    var parts = low.replace(/[-.\s]+/g, "_").split("_").filter(function (x) { return x; });
    for (var n = 3; n >= 1; n--) {
      if (parts.length >= n) {
        var cand = parts.slice(-n).join("_");
        if (TOOL_ZH[cand]) return TOOL_ZH[cand];
      }
    }
    return k || "工具";
  }
  // 卡片按类别走不同排版：编辑→diff、读取/写入→行号视图、shell→脚本、其余→中文键值表
  function toolKind(raw) {
    var n = String(raw == null ? "" : raw).toLowerCase();
    if (n === "edit" || n.indexOf("str_replace") >= 0 || n.indexOf("replace_editor") >= 0 ||
        /(^|[_.-])edit$/.test(n) || /^edit[_.-]/.test(n)) return "edit";
    if (n === "write" || n.indexOf("create_file") >= 0 ||
        /(^|[_.-])write$/.test(n) || /^write[_.-]/.test(n)) return "write";
    if (n === "read" || n === "cat" || n === "view" ||
        /(^|[_.-])read$/.test(n) || /^read[_.-]/.test(n)) return "read";
    if (HL_SHELL[n]) return "shell";
    return "other";
  }

  function hlReady() { return typeof window.hljs !== "undefined" && !!window.hljs.highlight; }
  function hlLang(name) {
    if (name == null) return "";
    var n = String(name).toLowerCase().replace(/^language-/, "").replace(/^\./, "").trim();
    if (!n) return "";
    n = HL_ALIAS[n] !== undefined ? HL_ALIAS[n] : (HL_EXT[n] !== undefined ? HL_EXT[n] : n);
    if (!n) return "";
    return hlReady() && window.hljs.getLanguage(n) ? n : "";
  }
  function hlLangOfPath(p) {
    var s = String(p || "").replace(/\\/g, "/");
    var base = s.split("/").pop().toLowerCase().trim();
    if (base === "makefile") return hlLang("makefile");
    var i = base.lastIndexOf(".");
    return i < 0 ? "" : hlLang(base.slice(i + 1));
  }
  // 返回可直接塞 innerHTML 的内容（已转义 + 上色）
  function hlCode(text, lang) {
    var s = String(text == null ? "" : text);
    if (!s) return "";
    if (!hlReady()) return esc(s);
    var L = hlLang(lang);
    try {
      if (L) return window.hljs.highlight(s, { language: L, ignoreIllegals: true }).value;
      var r = window.hljs.highlightAuto(s, HL_AUTOSET);
      return (r.relevance || 0) >= 7 ? r.value : esc(s);
    } catch (e) {
      return esc(s);
    }
  }
  // 先整段上色再按行切开，跨行的注释/字符串也不会掉色；行数与原文对不上就返回 null
  function hlSplit(html, expectLines) {
    if (!html) return null;
    var lines = [], cur = "", stack = [], pos = 0;
    function openTags() { var s = ""; for (var i = 0; i < stack.length; i++) s += '<span class="' + stack[i] + '">'; return s; }
    function closeTags() { var s = ""; for (var i = 0; i < stack.length; i++) s += "</span>"; return s; }
    while (pos < html.length) {
      if (html.charAt(pos) === "<") {
        var gt = html.indexOf(">", pos);
        if (gt < 0) { cur += html.slice(pos); break; }
        var tag = html.slice(pos, gt + 1);
        if (tag.indexOf("</span") === 0) { if (stack.length) stack.pop(); }
        else if (tag.indexOf("<span") === 0) {
          var m = /class="([^"]*)"/.exec(tag);
          stack.push(m ? m[1] : "");
        }
        cur += tag;
        pos = gt + 1;
      } else if (html.charAt(pos) === "\n") {
        lines.push(cur + closeTags());
        cur = openTags();
        pos++;
      } else {
        var nx = html.indexOf("<", pos), nl = html.indexOf("\n", pos);
        var end = (nx < 0 || (nl >= 0 && nl < nx)) ? nl : nx;
        if (end < 0) end = html.length;
        cur += html.slice(pos, end);
        pos = end;
      }
    }
    lines.push(cur + closeTags());
    return lines.length === expectLines ? lines : null;
  }

  /* ---- 极简 Markdown ---- */
  function md(src) {
    if (!src) return "";
    var s = String(src);
    var blocks = [];
    var codes = [];
    /* 行内元素：图片 / 链接 / 删除线 / 粗体 / 斜体。表格单元格与正文共用同一份实现，
       必须在 esc() 之后调用（正文此时已转义，链接里的 & 是 &amp;，正好合法）。 */
    function inlineMd(x) {
      return String(x)
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    }
    // 围栏代码块
    s = s.replace(/```([\w+-]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      var c = code.replace(/\n$/, "");
      var L = hlLang(lang);
      blocks.push('<pre><code' + (L ? ' class="language-' + L + '"' : "") + ">" + hlCode(c, lang) + "</code></pre>");
      return "\u0000B" + (blocks.length - 1) + "\u0000";
    });
    // 行内代码（先占位：里面的 * [ ] 不能被后面的行内规则吃掉）
    s = s.replace(/`([^`\n]+)`/g, function (_, c) {
      codes.push("<code>" + esc(c) + "</code>");
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });
    s = esc(s);
    // 引用块：esc() 之后 > 变成 &gt;，所以按 &gt; 匹配；连续多行合成一个 blockquote
    s = s.replace(/(?:^|\n)((?:[ \t]*&gt;[^\n]*(?:\n|$))+)/g, function (_, blk) {
      var lines = blk.replace(/\n$/, "").split("\n").map(function (l) {
        return l.replace(/^[ \t]*&gt; ?/, "");
      });
      return "\n<blockquote>" + lines.join("<br>") + "</blockquote>\n";
    });
    // 水平线
    s = s.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "<hr>");
    // 标题
    s = s.replace(/^###### (.*)$/gm, "<h6>$1</h6>")
         .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
         .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
         .replace(/^### (.*)$/gm, "<h3>$1</h3>")
         .replace(/^## (.*)$/gm, "<h2>$1</h2>")
         .replace(/^# (.*)$/gm, "<h1>$1</h1>");
    // 行内：粗体 / 斜体 / 删除线 / 链接 / 图片
    s = inlineMd(s);
    // 表格（GFM）：表头行 + |---| 分隔行 + 连续数据行。分隔行决定每列对齐。
    // 必须在列表规则之前做：表格单元格里以 "- " 开头的会被列表规则抢掉。
    s = s.replace(/(^|\n)([ \t]*\|[^\n]*\|[ \t]*)\n([ \t]*\|[ \t:|-]*-[ \t:|-]*\|[ \t]*)\n((?:[ \t]*\|[^\n]*\|[ \t]*(?:\n|$))*)/g,
      function (_, lead, head, delim, body) {
        function cells(line) {
          return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
        }
        var aligns = cells(delim).map(function (c) {
          var l = c.charAt(0) === ":", r = c.charAt(c.length - 1) === ":";
          return l && r ? "center" : r ? "right" : l ? "left" : "";
        });
        function cell(tag, c, i) {
          var a = aligns[i];
          return "<" + tag + (a ? ' style="text-align:' + a + '"' : "") + ">" + inlineMd(c) + "</" + tag + ">";
        }
        var hs = cells(head).map(function (c, i) { return cell("th", c, i); }).join("");
        var rows = body.trim()
          ? body.replace(/[ \t]*\n$/, "").split("\n").map(function (l) {
              return "<tr>" + cells(l).map(function (c, i) { return cell("td", c, i); }).join("") + "</tr>";
            }).join("")
          : "";
        blocks.push('<div class="md-table-wrap"><table class="md-table"><thead><tr>' + hs + "</tr></thead><tbody>" + rows + "</tbody></table></div>");
        return lead + "\u0000B" + (blocks.length - 1) + "\u0000";
      });
    // 列表：无序 - * + 与有序 1. / 1)，连续同类行包成一个 ul / ol
    s = s.replace(/^[ \t]*[-*+] (.*)$/gm, "<li>$1</li>")
         .replace(/^[ \t]*\d+[.)] (.*)$/gm, '<li data-o="1">$1</li>');
    s = s.replace(/(?:^|\n)((?:[ \t]*<li(?: data-o="1")?>[^\n]*<\/li>[ \t]*(?:\n|$))+)/g, function (_, blk) {
      var items = blk.replace(/\n$/, "").split("\n").map(function (l) { return l.trim(); });
      var ordered = items[0].indexOf('data-o="1"') > -1;
      var out = items.map(function (l) { return l.replace(' data-o="1"', ""); }).join("");
      return "\n<" + (ordered ? "ol" : "ul") + ">" + out + "</" + (ordered ? "ol" : "ul") + ">\n";
    });
    // 段落
    s = s.split(/\n{2,}/).map(function (p) {
      p = p.trim();
      if (!p) return "";
      if (/^\u0000B\d+\u0000$/.test(p) || /^<(h\d|ul|ol|pre|blockquote|hr|div|table)/.test(p)) return p;
      return "<p>" + p.replace(/\n/g, "<br>") + "</p>";
    }).join("");
    // 还原代码块与行内代码
    s = s.replace(/\u0000B(\d+)\u0000/g, function (_, i) { return blocks[+i]; });
    s = s.replace(/\u0000C(\d+)\u0000/g, function (_, i) { return codes[+i]; });
    return s;
  }

  /* ================= 状态 ================= */
  var S = {
    model: null,
    models: [],
    thinkLevel: "medium",
    thinkLevels: [],
    toolPreset: "default",   // 输入区「工具预设」胶囊，与 ipc.rs Config.tool_preset 同值
    expandThinking: true,    // 思考块默认展开（与 ipc.rs Config.expand_thinking 同值）
    sound: true,             // 回合结束提示音
    images: [],
    sessions: [],
    activeSession: null,
    // pi 子进程此刻真正跑着的那条会话（由 get_state 回报，也在每次切换成功后自己记账）。
    // 和 activeSession 分开：activeSession 是「用户点开在看的那条」，pi 没切过去也照样是它。
    // 用它来跳过重复的 switch_session（大会话实测 15–32s，白等）。
    liveSession: null,
    streaming: false,
    act: null,            // 输入框上方那行「现在在干什么」的状态
    cwd: "",
    home: "",
    nodeId: 0,
    msgIndex: Object.create(null),
    stats: null,
    queue: { steering: [], followUp: [] },
    uiStatus: {},
    uiWidgets: {},
    pendingPrompts: 0
  };

  /* ================= 消息流渲染 ================= */
  var streamInner = $("stream-inner");
  var streamBox = $("stream");
  /* 历史分页时的渲染宿主：非空表示这一页先渲染进一个游离容器，再整体插到消息流最前面
     （见 rebuildFromMessages 的 mode="prepend"）。为 null 就是直接渲染进消息流（实时消息）。 */
  var MSG_HOST = null;
  function msgHost() { return MSG_HOST || streamInner; }

  /* 滚动跟随：用户没主动往上翻就一直贴底。
     以前是「离底 <80px 才跟随」，但用户往上翻之后新消息到达时，滚动位置可能刚好落在
     80px 以内，就会被硬拽到底部——这正是「翻页后自动下拉」的来源。改成显式的粘底标志：
     只有滚动事件证明用户在底部时才继续跟随；离开底部则停手，并浮出「回到底部」按钮。 */
  var SCROLL = { stick: true, unread: 0, raf: 0 };
  function bottomGap() {
    return streamBox.scrollHeight - streamBox.scrollTop - streamBox.clientHeight;
  }
  function atBottom() { return bottomGap() < 80; }
  function scrollDown(force) {
    if (!force && !SCROLL.stick) return;
    SCROLL.stick = true;
    SCROLL.unread = 0;
    streamBox.scrollTop = streamBox.scrollHeight;
  }
  function updateJumpBtn() {
    var btn = $("jump-bottom");
    if (!btn) return;
    btn.hidden = bottomGap() <= 200;
    var cnt = $("jb-count");
    if (cnt) {
      cnt.textContent = SCROLL.unread > 99 ? "99+" : String(SCROLL.unread);
      cnt.hidden = !SCROLL.unread;
    }
  }
  function onStreamScroll() {
    if (SCROLL.raf) return;
    SCROLL.raf = requestAnimationFrame(function () {
      SCROLL.raf = 0;
      var stick = atBottom();
      if (stick !== SCROLL.stick) {
        SCROLL.stick = stick;
        if (stick) SCROLL.unread = 0;
      }
      updateJumpBtn();
    });
  }
  function bumpUnread() {
    if (SCROLL.stick) return;
    SCROLL.unread++;
    updateJumpBtn();
  }
  function bindScrollFollow() {
    var btn = $("jump-bottom");
    streamBox.addEventListener("scroll", onStreamScroll);
    window.addEventListener("resize", updateJumpBtn);
    if (btn) {
      btn.addEventListener("click", function () {
        SCROLL.stick = true;
        SCROLL.unread = 0;
        updateJumpBtn();
        streamBox.scrollTo({ top: streamBox.scrollHeight, behavior: "smooth" });
      });
    }
    updateJumpBtn();
  }

  function newMessageEl(role, key) {
    var wrap = el("div", "msg " + role);
    var node = { el: wrap, role: role, body: null, usage: null, tools: Object.create(null), texts: [] };
    if (role === "assistant") {
      var head = el("div", "head", (S.model ? S.model.name : "助手"));
      wrap.appendChild(head);
      node.body = el("div", "body user-selectable");
      wrap.appendChild(node.body);
    } else {
      node.body = el("div", "bubble user-selectable");
      wrap.appendChild(node.body);
    }
    msgHost().appendChild(wrap);
    if (key) S.msgIndex[key] = node;
    // 分页渲染时不能滚到底（会把用户刚才看的位置顶掉），插完整页再统一补偿。
    // 实时消息：自己发的强制贴底；助手回复只在用户还在底部时跟随，否则记未读。
    if (!MSG_HOST) {
      if (role === "user") scrollDown(true);
      else if (SCROLL.stick) scrollDown();
      else bumpUnread();
    }
    return node;
  }

  // 摘要压成一行：换行与连续空白折叠，超长用省略号收尾
  function oneLine(s, max) {
    var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  // 工具入参摘要：一行、够用，绝不出现 [object Object]、半截 JSON 或换行。
  // 所有工具走同一个岔口：powershell 给命令、read/edit 给路径、grep 给 pattern、compress 给压缩的段。
  function toolPreview(input) {
    if (input == null) return "";
    if (typeof input !== "object") return oneLine(input, 120);
    if (Array.isArray(input)) return input.length ? input.length + " 项" : "";
    var pick = ["command", "pattern", "query", "file_path", "filePath", "path", "url", "task", "prompt", "name", "id"];
    for (var i = 0; i < pick.length; i++) {
      var v = input[pick[i]];
      if (v != null && typeof v !== "object") return oneLine(v, 120);
    }
    // compress 这类 {content:[{startId,endId,summary}]}：讲清压了哪几段，而不是 [object Object]
    if (Array.isArray(input.content)) {
      var objs = input.content.filter(function (x) { return x && typeof x === "object"; });
      var ids = objs.map(function (x) { return x.startId ? x.startId + "–" + (x.endId || "?") : null; })
                    .filter(Boolean);
      if (ids.length) return oneLine((input.topic ? input.topic + " · " : "") + ids.length + " 段 " + ids.join(" "), 140);
      if (objs.length) return objs.length + " 段";
    }
    var keys = Object.keys(input);
    for (var j = 0; j < keys.length; j++) {
      var w = input[keys[j]];
      if (w == null) continue;
      if (typeof w !== "object") return (ARG_ZH[keys[j]] || keys[j]) + "：" + oneLine(w, 100);
      if (Array.isArray(w)) return (ARG_ZH[keys[j]] || keys[j]) + "：" + w.length + " 项";
    }
    return oneLine(JSON.stringify(input), 120);
  }

  /* ---------- 卡片正文：编辑给 diff、读写给行号、其余给中文键值表 ---------- */
  // 行级 diff（LCS）。编辑工具只给 oldText/newText、拿不到真实行号，
  // 所以行号是「块内序号」；超出行数上限就退化成整块删除 + 整块新增。
  function diffRows(A, B) {
    var n = A.length, m = B.length, rows = [], i, j;
    if (n * m > 200000 || n > 1200 || m > 1200) {
      for (i = 0; i < n; i++) rows.push({ t: "del", o: i + 1, n: null, text: A[i] });
      for (j = 0; j < m; j++) rows.push({ t: "add", o: null, n: j + 1, text: B[j] });
      return rows;
    }
    var W = m + 1, L = new Int32Array((n + 1) * W);
    for (i = n - 1; i >= 0; i--) {
      for (j = m - 1; j >= 0; j--) {
        L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1
          : (L[(i + 1) * W + j] >= L[i * W + j + 1] ? L[(i + 1) * W + j] : L[i * W + j + 1]);
      }
    }
    i = 0; j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { rows.push({ t: "same", o: i + 1, n: j + 1, text: A[i] }); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { rows.push({ t: "del", o: i + 1, n: null, text: A[i] }); i++; }
      else { rows.push({ t: "add", o: null, n: j + 1, text: B[j] }); j++; }
    }
    while (i < n) { rows.push({ t: "del", o: i + 1, n: null, text: A[i] }); i++; }
    while (j < m) { rows.push({ t: "add", o: null, n: j + 1, text: B[j] }); j++; }
    return rows;
  }
  function splitLines(s) {
    var t = String(s == null ? "" : s);
    return t === "" ? [] : t.split("\n");
  }
  function diffBlock(oldText, newText) {
    var rows = diffRows(splitLines(oldText), splitLines(newText));
    var box = el("div", "diff");
    var add = 0, del = 0;
    rows.forEach(function (r) {
      var line = el("div", "dline " + r.t);
      line.appendChild(el("span", "dno", r.o == null ? "" : String(r.o)));
      line.appendChild(el("span", "dno", r.n == null ? "" : String(r.n)));
      line.appendChild(el("span", "dsg", r.t === "del" ? "-" : (r.t === "add" ? "+" : " ")));
      line.appendChild(el("span", "dtx", r.text));
      box.appendChild(line);
      if (r.t === "add") add++;
      if (r.t === "del") del++;
    });
    box._stat = "+" + add + " −" + del;
    return box;
  }
  // 键值表：对象按「中文键 : 值」排，数组逐项展开，长文本换行
  function kvValue(v) {
    if (v == null) return el("div", "kvv", "—");
    if (Array.isArray(v)) {
      var w = el("div", "kvv");
      if (!v.length) { w.textContent = "（空）"; return w; }
      v.forEach(function (it, i) {
        if (it && typeof it === "object") {
          var sub = el("div", "kvsub");
          sub.appendChild(el("div", "kvh", (i + 1) + "）"));
          sub.appendChild(kvTable(it));
          w.appendChild(sub);
        } else {
          w.appendChild(el("div", "kvitem", String(it)));
        }
      });
      return w;
    }
    if (typeof v === "object") { var d = el("div", "kvv"); d.appendChild(kvTable(v)); return d; }
    var s = String(v);
    var n = el("div", "kvv" + (s.indexOf("\n") >= 0 || s.length > 80 ? " multi" : ""));
    n.textContent = s;
    return n;
  }
  function kvTable(obj) {
    var box = el("div", "kv");
    Object.keys(obj || {}).forEach(function (k) {
      box.appendChild(el("div", "kvk", ARG_ZH[k] || k));
      box.appendChild(kvValue(obj[k]));
    });
    if (!box.childElementCount) box.appendChild(el("div", "kvk", "（无参数）"));
    return box;
  }
  // 编辑：一行概要 + 每块一份 diff
  function editArgsView(input) {
    var box = el("div", "tstruct");
    var path = input.path || input.filePath || input.file_path || input.filepath || "";
    var edits = Array.isArray(input.edits) && input.edits.length
      ? input.edits
      : [{ oldText: input.oldText || input.old_string || "", newText: input.newText || input.new_string || "" }];
    var blocks = edits.map(function (e) {
      return diffBlock(e.oldText || e.old_string || "", e.newText || e.new_string || "");
    });
    var stat = blocks.map(function (b) { return b._stat; }).join(" ");
    box.appendChild(el("div", "tmeta", (path ? "文件 " + path + " · " : "") +
      edits.length + " 块编辑 " + stat + "（行号为块内序号）"));
    blocks.forEach(function (b, i) {
      if (blocks.length > 1) box.appendChild(el("div", "dsep", "第 " + (i + 1) + " 块"));
      box.appendChild(b);
    });
    return box;
  }
  // 带行号的代码块：行号列不参与复制，上色同样懒执行
  function codeBlock(text, lang, start) {
    var wrap = el("div", "codewrap");
    var gut = el("div", "gut");
    var pre = el("pre", "tool-res nowrap");
    pre._raw = String(text == null ? "" : text);
    pre._lang = lang || "";
    pre._start = start || 1;
    pre._gut = gut;
    pre._done = false;
    wrap.appendChild(gut);
    wrap.appendChild(pre);
    return wrap;
  }
  // 读取 / 写入：概要行 +（写入时）内容行号视图
  function fileArgsView(rec, input, kind) {
    var box = el("div", "tstruct");
    var path = input.path || input.filePath || input.file_path || input.filepath || "";
    var bits = [];
    if (path) bits.push("文件 " + path);
    rec.lang = hlLangOfPath(path);
    if (kind === "write") {
      var body = String(input.content != null ? input.content : (input.text || ""));
      bits.push("写入 " + splitLines(body).length + " 行");
      box.appendChild(el("div", "tmeta", bits.join(" · ")));
      if (body) box.appendChild(codeBlock(body, rec.lang, 1));
    } else {
      var off = Number(input.offset) || 0;
      var lim = Number(input.limit) || 0;
      rec.start = off > 0 ? off : 1;
      if (lim > 0) bits.push("读 " + lim + " 行");
      else if (off > 0) bits.push("从第 " + off + " 行起");
      else bits.push("读全文");
      box.appendChild(el("div", "tmeta", bits.join(" · ")));
    }
    return box;
  }
  // 工具结果里的英文套话换中文。只动编辑/写入这两种固定短语，
  // 命令输出一个字都不改（否则日志、报错原文就不可信了）。
  function zhResult(rec, text) {
    var t = text == null ? "" : String(text);
    var s = t.trim(), m;
    if (s === "(no output)") return "（无输出）";
    var k = rec && rec.kind;
    if (k !== "edit" && k !== "write") return t;
    m = /^Successfully replaced (\d+) block\(s\) in (.+?)\.?$/.exec(s);
    if (m) return "已在 " + m[2] + " 替换 " + m[1] + " 处";
    m = /^Successfully (?:wrote to|created) (.+?)\.?$/.exec(s);
    if (m) return "已写入 " + m[1];
    m = /^No changes made to (.+?)\.?$/.exec(s);
    if (m) return m[1] + " 没有变化";
    return t;
  }

  // 高亮是懒执行的：展开卡片（或出错自动展开）时才真正上色，长结果不会拖慢首屏
  function hlApplyPre(pre) {
    if (!pre || pre._done) return;
    pre._done = true;
    pre.innerHTML = hlCode(pre._raw || "", pre._lang || "");
    if (pre._gut) {
      var n = splitLines(pre._raw).length, out = [];
      for (var i = 0; i < n; i++) out.push(String((pre._start || 1) + i));
      pre._gut.textContent = out.join("\n");
      pre._gut.hidden = n === 0;
    }
  }
  function setRes(pre, rec, text) {
    if (!pre) return;
    var t = zhResult(rec, text);
    pre._raw = t;
    pre._lang = resLang(rec, t);
    pre._done = false;
    pre.innerHTML = "";
    pre.hidden = !t;
  }
  // 结果的语言：JSON / diff 一眼能认出来，其余沿用入参推断的语言
  function resLang(rec, text) {
    var t = String(text || "").trim();
    if (t.charAt(0) === "{" || t.charAt(0) === "[") {
      if (/[\]}]$/.test(t)) { try { JSON.parse(t); return "json"; } catch (e) { void e; } }
    }
    if (/(^|\n)(@@ |--- |\+\+\+ |diff --git)/.test(t)) return "diff";
    return (rec && rec.lang) || "";
  }

  // 入参只出现在两处：标题上的一行摘要（悬浮看全）、展开区里按类别排好的正文
  function setToolInput(rec, input) {
    if (!rec) return;
    var data = input && typeof input === "object" ? input : {};
    var pv = toolPreview(data);
    rec.arg.textContent = pv;
    rec.arg.title = pv;
    rec.input = data;
    rec.kind = toolKind(rec.name);
    // 语言先按文件扩展名认（编辑/写入/读取都靠它），shell 下面再覆盖成脚本语言
    rec.lang = hlLangOfPath(toolPath(data));
    rec.start = 1;
    rec.meta.innerHTML = "";
    var shell = rec.kind === "shell" ? (HL_SHELL[String(rec.name || "").toLowerCase()] || "bash") : "";
    var cmd = typeof data.command === "string" ? data.command : "";
    if (shell && cmd) {
      // shell：直接把原始脚本摊开，按对应解释器上色
      rec.lang = shell;
      rec.preArgs._raw = cmd;
      rec.preArgs._lang = shell;
      rec.preArgs._done = true;
      rec.preArgs.innerHTML = hlCode(cmd, shell);
      rec.preArgs.hidden = false;
      rec.meta.hidden = true;
      return;
    }
    rec.preArgs.hidden = true;
    rec.meta.hidden = false;
    if (rec.kind === "edit") rec.meta.appendChild(editArgsView(data));
    else if (rec.kind === "read" || rec.kind === "write") rec.meta.appendChild(fileArgsView(rec, data, rec.kind));
    else rec.meta.appendChild(kvTable(data));
    // 读取类的结果配行号列（行号从 offset 起），其他工具不要行号
    var isRead = rec.kind === "read";
    rec.pre._gut = isRead ? rec.gut : null;
    rec.pre._start = rec.start;
    rec.gut.hidden = true;
    rec.pre.classList.toggle("nowrap", isRead);
  }

  // 活着的工具卡（setInterval 计时中）。finishTool 会摘掉；endStream/actClear 做兵底，
  // 防止中途 abort / 切会话后旧卡的 500ms 定时器一直跑（白耗 CPU 且改已拆下的 DOM）。
  var LIVE_TOOLS = [];

  function stopLiveTools() {
    for (var i = 0; i < LIVE_TOOLS.length; i++) clearInterval(LIVE_TOOLS[i].timer);
    LIVE_TOOLS.length = 0;
  }

  function toolCard(node, callId, toolName) {
    var card = el("div", "tool-card");
    var head = el("div", "tool-head");
    var zh = toolZh(toolName);
    var name = el("span", "tool-name", zh);
    if (zh !== String(toolName || "")) name.appendChild(el("span", "tool-name-en", String(toolName || "")));
    var arg = el("span", "tool-arg", "");
    var dur = el("span", "tool-dur", "…");
    var caret = iconEl("tl-caret closed", "i-chevron-down", head);
    head.appendChild(name);
    head.appendChild(arg);
    head.appendChild(dur);
    var body = el("div", "tool-body");
    body.hidden = true;
    var meta = el("div", "tstruct");
    var preArgs = el("pre", "tool-args", "");
    preArgs._raw = "";
    preArgs._done = true;
    var resWrap = el("div", "codewrap");
    var gut = el("div", "gut");
    gut.hidden = true;
    var pre = el("pre", "tool-res", "");
    pre.hidden = true;
    resWrap.appendChild(gut);
    resWrap.appendChild(pre);
    body.appendChild(meta);
    body.appendChild(preArgs);
    body.appendChild(resWrap);
    card.appendChild(head);
    card.appendChild(body);
    head.addEventListener("click", function () {
      body.hidden = !body.hidden;
      caret.classList.toggle("closed", body.hidden);
      if (!body.hidden) {
        var pres = body.querySelectorAll("pre");
        for (var i = 0; i < pres.length; i++) hlApplyPre(pres[i]);
      }
    });
    node.el.appendChild(card);
    var rec = { card: card, body: body, meta: meta, gut: gut, pre: pre, preArgs: preArgs, dur: dur,
      arg: arg, t0: Date.now(), timer: null, head: head, caret: caret, name: toolName || "",
      kind: toolKind(toolName), lang: "", start: 1 };
    card._rec = rec;
    rec.timer = setInterval(function () {
      rec.dur.textContent = ((Date.now() - rec.t0) / 1000).toFixed(0) + "s";
    }, 500);
    LIVE_TOOLS.push(rec);
    node.tools[callId] = rec;
    return rec;
  }

  function finishTool(rec, text, isError) {
    if (!rec) return;
    clearInterval(rec.timer);
    var li = LIVE_TOOLS.indexOf(rec);
    if (li >= 0) LIVE_TOOLS.splice(li, 1);
    rec.dur.textContent = Math.max(1, Math.round((Date.now() - rec.t0) / 1000)) + "s";
    setRes(rec.pre, rec, text);
    if (isError) {
      rec.card.classList.add("err");
      rec.body.hidden = false;
      rec.caret.classList.remove("closed");
      hlApplyPre(rec.pre);
    } else {
      rec.body.hidden = true;
      rec.caret.classList.add("closed");
    }
    scrollDown();
  }

  function usageLine(node, usage) {
    if (!usage) return;
    if (!node.usage) {
      node.usage = el("div", "usage-line");
      node.el.appendChild(node.usage);
    }
    var p = [];
    // 用量行也中文：入/出/缓存读（原来是英文 in/out/cache R）。
    // 排成「标签-数值」小表格而不是一串「A · B · C」：数值等宽右对齐后量级一眼可比。
    if (usage.input != null) p.push(["入", fmtNum(usage.input)]);
    if (usage.output != null) p.push(["出", fmtNum(usage.output)]);
    if (usage.cacheRead) p.push(["缓存读", fmtNum(usage.cacheRead)]);
    var tr = el("tr", "");
    p.forEach(function (kv) {
      tr.appendChild(el("th", "", kv[0]));
      tr.appendChild(el("td", "", kv[1]));
    });
    var tb = el("table", "usage-tbl");
    tb.appendChild(tr);
    node.usage.textContent = "";
    node.usage.appendChild(tb);
    scrollDown();
  }

  /* 流式正文单独放进 .md-live 容器里刷新：以前是 node.body.innerHTML = md(buf)，
     会把同级的思考块一起从 DOM 里抹掉（思考块是真实节点、挂了展开事件，
     一旦被 innerHTML 序列化重排，事件就没了，点「展开」没反应）。 */
  function streamFor(node) {
    if (!node._live) {
      var mdBox = el("div", "md-live");
      node._live = { buf: "", think: null, md: mdBox, cursor: el("span", "cursor") };
      node.body.appendChild(mdBox);
      node.body.appendChild(node._live.cursor);
    }
    return node._live;
  }

  function appendText(node, delta) {
    var L = streamFor(node);
    L.buf += delta;
    L.md.innerHTML = md(L.buf);
    scrollDown();
  }

  function appendThinking(node, delta) {
    var L = streamFor(node);
    if (!L.think) {
      L.think = thinkBlock("", S.expandThinking !== false);
      // 思考块恒定排在正文之前（和历史消息里的顺序一致）
      node.body.insertBefore(L.think, L.md);
    }
    L.think._body.textContent += delta;
    // 思考块展开着就继续跟随到底部（用户手动往上翻就不抢滚动条）
    var tb = L.think._body;
    if (!tb.hidden && tb.scrollHeight - tb.scrollTop - tb.clientHeight < 40) tb.scrollTop = tb.scrollHeight;
    scrollDown();
  }

  /* 把包裹元素拆掉，子节点原地顶上（流式结束后让 DOM 与历史渲染保持一致） */
  function unwrapEl(w) {
    if (!w || !w.parentNode) return;
    var p = w.parentNode;
    while (w.firstChild) p.insertBefore(w.firstChild, w);
    p.removeChild(w);
  }

  // 思考块：一行「思考」标题（可折叠）+ 正文（保留换行、小字灰字）
  function thinkBlock(text, expanded) {
    var open = expanded !== false;
    var w = el("div", "think" + (open ? "" : " closed"));
    var head = el("div", "think-head");
    var caret = iconEl("tl-caret" + (open ? "" : " closed"), "i-chevron-down", head);
    head.appendChild(el("span", "think-title", "思考"));
    var hint = el("span", "think-hint", open ? "点击收起" : "点击展开");
    head.appendChild(hint);
    w.appendChild(head);
    var body = el("div", "think-body");
    body.textContent = String(text == null ? "" : text);
    body.hidden = !open;
    w.appendChild(body);
    w._body = body;
    head.tabIndex = 0;
    head.setAttribute("role", "button");
    var toggle = function () {
      body.hidden = !body.hidden;
      w.classList.toggle("closed", body.hidden);
      caret.classList.toggle("closed", body.hidden);
      hint.textContent = body.hidden ? "点击展开" : "点击收起";
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        toggle();
      }
    });
    return w;
  }

  function endStream(node) {
    if (node._live) {
      if (node._live.cursor.parentElement) node._live.cursor.remove();
      var m = node._live.md;
      if (m) {
        m.innerHTML = md(node._live.buf);
        if (!m.innerHTML) m.remove();      // 纯思考、没有正文：不留空壳
        else unwrapEl(m);
      }
      node._live = null;
    }
    stopLiveTools();
    scrollDown();
  }

  function addUserMsg(text, images) {
    var node = newMessageEl("user");
    var imgs = images || [];
    if (imgs.length) {
      var strip = el("div", "bubble-images");
      imgs.forEach(function (i) {
        var im = document.createElement("img");
        im.src = "data:" + i.mimeType + ";base64," + i.data;
        im.alt = "附件图片";
        im.title = fmtNum(b64Bytes(i.data));
        strip.appendChild(im);
      });
      node.body.appendChild(strip);
    }
    if (text) {
      node.body.appendChild(el("div", "bubble-text", text));
      node.el._rawText = text;      // 「从此处编辑」要拿原文去 pi 的 fork 列表里比对
      node.el.appendChild(msgActs(node.el, text));
    }
    scrollDown(true);
    return node;
  }

  /* 用户气泡的悬停操作条：复制 / 从此处编辑。
     参考实现有消息级分支（BranchNavigator「从此处编辑」），移植版原来只有 /clone 整会话克隆。 */
  function msgActs(wrap, text) {
    var bar = el("div", "msg-acts");
    var cp = el("button", "ma-btn");
    cp.type = "button";
    cp.title = "复制这条消息";
    cp.appendChild(icon("i-file-text"));
    cp.addEventListener("click", function (e) { e.stopPropagation(); copyText(text, cp); });
    var fk = el("button", "ma-btn");
    fk.type = "button";
    fk.title = "从此处编辑（以这条消息为起点分叉成新会话）";
    fk.appendChild(icon("i-corner-up-left"));
    fk.addEventListener("click", function (e) { e.stopPropagation(); forkFrom(wrap); });
    bar.appendChild(cp);
    bar.appendChild(fk);
    return bar;
  }

  /* 纯函数：在 fork 候选里挑出「从末尾数第 suffix 条同文本」的那条。
     抽出来是为了能在自检里单测——真跑 fork 会把当前会话分叉掉，自检不能干这事。 */
  function pickForkEntry(list, text, suffix) {
    var cands = (list || []).filter(function (m) { return m.text === text; });
    return cands[cands.length - 1 - (suffix || 0)] || null;
  }

  /* 从此处编辑 = pi 的 fork：以这条用户消息为起点分叉成新会话，并把原文回填输入框。
     pi 的 fork 要 entryId，而前端手上只有消息文本 —— 用「从末尾数第几条同文本消息」定位：
     历史往往只加载了尾部，从头数会错位，从尾数不会。 */
  function forkFrom(wrap) {
    if (S.streaming) { toasts("正在生成中，先停止再从此处编辑", "warn"); return; }
    var text = wrap._rawText || "";
    if (!text) return;
    var bubbles = [].slice.call(streamInner.querySelectorAll(".msg.user"));
    var at = bubbles.indexOf(wrap);
    var suffix = 0;
    for (var i = at + 1; i < bubbles.length; i++) {
      if (bubbles[i]._rawText === text) suffix++;
    }
    toasts("正在从此处分叉…", "info");
    send("pi.call", { type: "get_fork_messages" }).then(function (r) {
      var list = (r && r.data && r.data.messages) || [];
      var pick = pickForkEntry(list, text, suffix);
      if (!pick) throw new Error("没在当前会话里找到这条消息（可能已被压缩）");
      return send("pi.call", { type: "fork", params: { entryId: pick.entryId } });
    }).then(function (r) {
      var d = (r && r.data) || {};
      if (d.cancelled) return null;
      return send("pi.call", { type: "get_state" }).then(function (st) {
        var sf = (st && st.data && st.data.sessionFile) || "";
        return attachForked(sf).then(function () {
          setInputText(d.text || text);
          $("input").focus();
          toasts("已分叉成新会话（原会话保留），改完直接发送", "ok");
        });
      });
    }).catch(function (e) { toasts("分叉失败：" + e.message, "error"); });
  }

  /* fork 之后 pi 自己已经切到新会话，前端跟上：重列会话 → 重取历史 → 刷新统计 */
  function attachForked(path) {
    if (!path) return Promise.resolve();
    S.activeSession = path;
    S.liveSession = path;   // pi 自己已经切过去了（见上）
    S.hist = null;
    updateHistMore();
    return loadSessions()
      .then(function () { renderSessions(); return loadHistoryTail(path, 0); })
      .then(function () { return refreshStats(); });
  }

  function fmtPercent(p) {
    if (p == null) return "—";
    var v = Number(p);
    if (!isFinite(v)) return "—";
    if (v >= 1) return Math.round(v) + "%";
    if (v <= 0) return "0%";
    return v.toFixed(1) + "%";
  }

  /* ================= 顶栏计量 ================= */
  function renderMeter(stats) {
    if (!stats) return;
    S.stats = stats;
    var t = stats.tokens || {};
    var cu = stats.contextUsage || {};
    $("m-in").textContent = fmtNum(t.input);
    $("m-out").textContent = fmtNum(t.output);
    $("m-cache").textContent = fmtNum(t.cacheRead);
    $("m-pct").textContent = fmtPercent(cu.percent);
    $("m-window").textContent = cu.contextWindow ? fmtNum(cu.contextWindow) : "—";
    fitMeter();
  }
  /* 顶栏自适应。界面放大后顶栏可用宽度（缩放坐标系里）是固定且变小的，
     硬塞必然把右边的 token 计量裁掉一截——这就是「字体调大后 UI 超出范围」。
     分两级，都只改「显示多少」，不改字号：
       1) 按优先级整格隐藏计量：⊙缓存 -> ↓输出 -> ↑输入，%上下文占用最后留；
       2) 仍放不下就把「完整历史 / 生成标题 / 系统 / 工具」压成纯图标。
     绝不做的事：把数字裁一半。 */
  function fitMeter() {
    var m = $("meter");
    var top = document.querySelector(".topbar");
    if (!m || !top) return;
    var cells = [];
    ["m-cache", "m-out", "m-in"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b && b.parentElement) cells.push(b.parentElement);
    });
    // 顶栏「塞得下」有两个条件：顶栏自己不溢出，且计量条没被挤到裁切。
    // 计量条是 flex:0 1 auto + min-width:0，塞不下时会被压成 0 宽——
    // 只看顶栏的 scrollWidth 会误判成「够宽」，于是 token 计量被裁一半还显示着。
    function fits() {
      return top.scrollWidth <= top.clientWidth + 1 && m.scrollWidth <= m.clientWidth + 1;
    }
    function reset() {
      m.hidden = false;
      cells.forEach(function (c) { c.hidden = false; });
    }
    reset();
    top.classList.remove("compact");
    if (fits()) return;
    // 每撤一格重新量一次，量的是真实布局后的宽度（scrollWidth 是内容实宽）。
    for (var i = 0; i < cells.length; i++) {
      cells[i].hidden = true;
      if (fits()) return;
    }
    // 撤光格子还不够，就是四个按钮本身塞不下（例如 24px 字号 + 窄窗口）：
    // 压成纯图标腾出宽度，再重新分配一次格子。
    top.classList.add("compact");
    reset();
    if (fits()) return;
    for (var j = 0; j < cells.length; j++) {
      cells[j].hidden = true;
      if (fits()) return;
    }
    // 连纯图标都塞不下：整条计量让位，绝不折行把顶栏撑高。
    m.hidden = true;
  }
  function refreshStats() {
    return send("pi.call", { type: "get_session_stats" })
      .then(function (r) { if (r.success) renderMeter(r.data); })
      .catch(function (e) { console.warn("[meter] 取会话用量失败：" + ((e && e.message) || e)); });
  }

  /* ================= pi 事件处理 ================= */
  var liveNode = null;

  function ensureAssistantNode() {
    if (!liveNode) liveNode = newMessageEl("assistant");
    return liveNode;
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case "agent_start":
        S.streaming = true;
        S.pendingPrompts = 0;
        updateRunState();
        liveNode = null;
        actSet("wait");
        break;

      case "message_start":
        if (ev.message && ev.message.role === "assistant") {
          liveNode = newMessageEl("assistant");
        }
        break;

      case "message_update": {
        var node = ensureAssistantNode();
        var a = ev.assistantMessageEvent || {};
        if (a.type === "text_delta") { appendText(node, a.delta || ""); actSet("text"); }
        else if (a.type === "thinking_delta") { appendThinking(node, a.delta || ""); actSet("think"); }
        else if (a.type === "toolcall_start") {
          toolCard(node, a.id, a.toolName);
          actSet("args", { tool: actToolName(a.toolName) });
        } else if (a.type === "toolcall_delta") {
          // 入参还在流式拼：先占位，别把半截 JSON 糊在标题上
          var rec = node.tools[a.contentIndex] || node.tools[Object.keys(node.tools).pop()];
          if (rec) rec.arg.textContent = "正在生成参数…";
        } else if (a.type === "toolcall_end" && a.toolCall) {
          setToolInput(node.tools[a.toolCall.id], a.toolCall.arguments || {});
          actSet("args", { tool: actToolName(a.toolCall.toolName || a.toolName) });
        }
        if (ev.usage) usageLine(node, ev.usage);
        break;
      }

      case "message_end":
        if (ev.message && ev.message.role === "assistant") {
          var n = liveNode;
          if (n) {
            endStream(n);
            if (ev.message.usage) usageLine(n, ev.message.usage);
          }
          liveNode = null;
        }
        break;

      case "tool_execution_start": {
        var nn = ensureAssistantNode();
        var c = toolCard(nn, ev.toolCallId, ev.toolName);
        setToolInput(c, ev.args || {});
        c.busy = true;
        actSet("tool", { tool: actToolName(ev.toolName), detail: actArgBrief(ev.args) });
        break;
      }

      case "tool_execution_update": {
        var ln = liveNode;
        var rc = ln && ln.tools[ev.toolCallId];
        if (rc) {
          var pr = ev.partialResult || {};
          var txt = (pr.content || []).map(function (x) { return x.text || ""; }).join("");
          setRes(rc.pre, rc, txt);
          if (!rc.body.hidden) hlApplyPre(rc.pre);
          // 状态行跟着工具的输出末行走：pi-web 就是「正在运行 powershell… <最后一行>」
          var last = actDetail(txt, 120);
          if (S.act && S.act.kind === "tool" && last && last !== S.act.detail) {
            S.act.detail = last;
            renderAct();
          }
        }
        break;
      }

      case "tool_execution_end": {
        var ln2 = liveNode;
        var rc2 = ln2 && ln2.tools[ev.toolCallId];
        var res = ev.result || {};
        var out = (res.content || []).map(function (x) { return x.text || ""; }).join("");
        finishTool(rc2, out, ev.isError);
        actSet("wait");
        break;
      }

      case "turn_end":
        if (liveNode) { endStream(liveNode); liveNode = null; }
        break;

      case "agent_end":
        if (liveNode) { endStream(liveNode); liveNode = null; }
        refreshStats();
        break;

      case "agent_settled":
        S.streaming = false;
        updateRunState();
        actClear();
        refreshStats();
        break;

      case "queue_update":
        S.queue = { steering: ev.steering || [], followUp: ev.followUp || [] };
        renderQueue();
        break;

      case "compaction_start":
        toasts("正在压缩上下文…（" + (ev.reason || "") + "）");
        actSet("note", { detail: "正在压缩上下文…" });
        break;
      case "compaction_end":
        toasts(ev.aborted ? "压缩已取消" : "上下文压缩完成");
        actSet("wait");
        refreshStats();
        break;

      case "auto_retry_start":
        toasts("第 " + ev.attempt + "/" + ev.maxAttempts + " 次自动重试：" + (ev.errorMessage || ""), "warn");
        actSet("note", { detail: "正在自动重试（第 " + ev.attempt + " 次）…" });
        break;
      case "auto_retry_end":
        if (!ev.success) toasts("重试失败：" + (ev.finalError || ""), "error");
        break;

      case "extension_error":
        toasts("扩展错误：" + (ev.error || ""), "error");
        break;
    }
  }

  /* ================= 输入框上方的「当前在干什么」 =================
     照 pi-web 的样子：跑工具时显示「正在运行 执行命令(powershell)… <输出最后一行>」，
     两个工具之间显示「正在等待模型回应…」，输出/思考时各有一句。
     只用 pi 已经在推的事件（tool_execution_* / message_update），不发额外请求。 */
  var ACT_ARG_KEYS = ["command", "cmd", "file_path", "filePath", "path", "url", "query",
    "pattern", "prompt", "task", "code", "name"];

  function actToolName(name) {
    var n = String(name == null ? "" : name);
    var zh = toolZh(n);
    return zh && zh !== n ? zh + "(" + n + ")" : n;
  }

  // 取最后一行非空文本（工具的实时输出末尾那行就是「当前在干什么」最直接的信息）
  function actDetail(txt, max) {
    var lim = max || 120;
    var lines = String(txt == null ? "" : txt).replace(/\r/g, "").split("\n");
    for (var i = lines.length - 1; i >= 0; i--) {
      var s = lines[i].trim();
      if (s) return s.length > lim ? s.slice(0, lim) + "…" : s;
    }
    return "";
  }

  function actArgBrief(args) {
    if (!args || typeof args !== "object") return "";
    for (var i = 0; i < ACT_ARG_KEYS.length; i++) {
      var v = args[ACT_ARG_KEYS[i]];
      if (typeof v === "string" && v.trim()) return actDetail(v, 100);
      if (Array.isArray(v) && v.length) return actDetail(String(v[0]), 90) + " …";
    }
    var ks = Object.keys(args);
    for (var j = 0; j < ks.length; j++) {
      var v2 = args[ks[j]];
      if (typeof v2 === "string" && v2.trim()) return actDetail(v2, 100);
    }
    return "";
  }

  function actSet(kind, opt) {
    opt = opt || {};
    S.act = { kind: kind, tool: opt.tool || "", detail: opt.detail || "" };
    renderAct();
  }

  function actClear() {
    S.act = null;
    stopLiveTools();
    renderAct();
  }

  function renderAct() {
    var box = $("act-line"), tx = $("act-txt");
    if (!box || !tx) return;
    var a = S.act;
    // 不跑的时候这行整体收起，别在空闲界面上留一行灰字
    if (!a || !S.streaming) { box.hidden = true; tx.textContent = ""; return; }
    var txt;
    if (a.kind === "tool") txt = "正在运行 " + a.tool + "…" + (a.detail ? " " + a.detail : "");
    else if (a.kind === "args") txt = "正在生成 " + a.tool + " 参数…";
    else if (a.kind === "think") txt = "正在思考…";
    else if (a.kind === "text") txt = "正在输出回答…";
    else if (a.kind === "wait") txt = "正在等待模型回应…";
    else txt = a.detail || a.kind;
    box.hidden = false;
    tx.textContent = txt;
  }

  function updateRunState() {
    var streaming = !!S.streaming;
    var box = $("composer-box");
    if (box) box.classList.toggle("streaming", streaming);
    // 空闲只有「发送」；运行中换成「引导 / 后续消息 + 停止」（与参考截图一致）
    $("btn-send").hidden = streaming;
    $("btn-steer").hidden = !streaming;
    $("btn-follow").hidden = !streaming;
    $("btn-stop").hidden = !streaming;
    // 压缩只在空闲可点：pi 的 compact 不接受与进行中的回合并发
    var cc = $("chip-compact");
    if (cc) cc.disabled = streaming;
    var inp = $("input");
    if (inp) inp.placeholder = streaming ? "立即引导 / 排队后续消息…" : "输入消息…";
    // 回合刚结束：响一声（WebView2 里没用户手势前 AudioContext 是挂起的，
    // 但能走到这里就说明用户已经交互过）
    if (WAS_STREAMING && !streaming && S.sound) beep();
    WAS_STREAMING = streaming;
    $("st-left").textContent = streaming ? "● 正在运行" : "· 空闲";
    renderAct();
  }
  var WAS_STREAMING = false;

  /* 回合结束提示音。用 WebAudio 现场合成，不带音频文件 ——
     绿色版要能整个目录拷走，多挂一个 wav 就多一个可能丢的东西。 */
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      S.ac = S.ac || new AC();
      var ctx = S.ac;
      if (ctx.state === "suspended") ctx.resume();
      var t = ctx.currentTime;
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.28);
    } catch (e) { /* 没声卡就算了，不能因为提示音把界面弄崩 */ }
  }

  function renderQueue() {
    var n = S.queue.steering.length + S.queue.followUp.length;
    $("st-right").textContent = n ? ("队列 " + n + " 条") : "";
  }

  /* ================= 图片附件 ================= */
  // 对齐 pi-web：图片以 { type:"image", data:<纯 base64>, mimeType } 走 prompt 的 images 字段。
  // pi CLI bundle 实测：prompt handler 把 images 直接拼进 user 消息 content 块。
  // 上限同 pi-web lib/image-attachments.ts：MAX_ATTACHED_IMAGES=10，单张 10MB。
  var MAX_IMAGES = 10;
  var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  // pi-web ChatInput.tsx 同款压缩参数
  var COMPRESS_OVER_BYTES = 1024 * 1024;
  var MAX_SIDE = 1024;
  var JPEG_Q = 0.85;

  function b64Bytes(b64) {
    if (!b64 || b64.length % 4 !== 0) return -1;
    var pad = b64.slice(-2) === "==" ? 2 : b64.slice(-1) === "=" ? 1 : 0;
    return (b64.length / 4) * 3 - pad;
  }

  function readAsDataUrl(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onerror = function () { rej(new Error("读图失败")); };
      fr.onload = function () { res(String(fr.result)); };
      fr.readAsDataURL(blob);
    });
  }

  // >1MB 且非 gif 时缩到最长边 1024、转 JPEG 0.85；压缩结果没更小就保留原图。
  function compressImage(file) {
    var original = function () {
      return readAsDataUrl(file).then(function (u) {
        return { data: u.split(",")[1] || "", mimeType: file.type || "image/png" };
      });
    };
    if (file.size <= COMPRESS_OVER_BYTES || file.type === "image/gif" || typeof createImageBitmap !== "function") return original();
    return createImageBitmap(file).then(function (bmp) {
      try {
        var scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        var cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(bmp.width * scale));
        cv.height = Math.max(1, Math.round(bmp.height * scale));
        var ctx = cv.getContext("2d");
        if (!ctx) return original();
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
        var d = cv.toDataURL("image/jpeg", JPEG_Q).split(",")[1] || "";
        return (d && d.length < Math.ceil(file.size / 3) * 4) ? { data: d, mimeType: "image/jpeg" } : original();
      } catch (e) { return original(); }
      finally { try { bmp.close(); } catch (e2) { /* ignore */ } }
    }, function () { return original(); });
  }

  function renderAttachStrip() {
    var box = $("attach-strip");
    box.innerHTML = "";
    if (!S.images.length) { box.hidden = true; return; }
    box.hidden = false;
    S.images.forEach(function (img, idx) {
      var t = el("div", "attach-thumb");
      var im = document.createElement("img");
      im.src = "data:" + img.mimeType + ";base64," + img.data;
      im.alt = "图片 " + (idx + 1);
      t.appendChild(im);
      t.appendChild(el("span", "kb", fmtNum(b64Bytes(img.data))));
      var rm = document.createElement("button");
      rm.className = "rm";
      rm.type = "button";
      rm.title = "移除";
      rm.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
      rm.addEventListener("click", function () {
        S.images.splice(idx, 1);
        renderAttachStrip();
      });
      t.appendChild(rm);
      box.appendChild(t);
    });
    if (S.images.length >= MAX_IMAGES) box.appendChild(el("span", "attach-hint", "已达上限 " + MAX_IMAGES + " 张"));
  }

  function addImageFiles(files) {
    var imgs = Array.prototype.slice.call(files || []).filter(function (f) {
      return /^image\//.test(f.type || "");
    });
    if (!imgs.length) { toasts("只支持图片文件", "warn"); return; }
    var room = MAX_IMAGES - S.images.length;
    if (room <= 0) { toasts("最多 " + MAX_IMAGES + " 张图片", "warn"); return; }
    if (imgs.length > room) { toasts("超过上限，只取前 " + room + " 张", "warn"); imgs = imgs.slice(0, room); }
    var chain = Promise.resolve();
    imgs.forEach(function (f) {
      chain = chain.then(function () {
        return compressImage(f).then(function (r) {
          var n = b64Bytes(r.data);
          if (n < 0) { toasts("图片数据无效：" + f.name, "error"); return; }
          if (n > MAX_IMAGE_BYTES) { toasts("图片超过 10MB：" + f.name, "error"); return; }
          S.images.push(r);
          renderAttachStrip();
        });
      });
    });
    chain.then(function () {
      if (S.images.length) toasts("已添加 " + S.images.length + " 张图片");
    });
  }

  /* ================= 模型选择 ================= */
  var THINK_LABEL = { off: "关闭", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大" };
  // 内置子代理（general-purpose / explore / plan）用下面这张表，与 pi-web 的
  // SUBAGENT_THINKING_OPTIONS 对齐。「跟随父会话」= 不写 thinking 键。
  var SA_THINK = [
    ["", "跟随父会话"], ["off", "关闭"], ["minimal", "最小"], ["low", "低"],
    ["medium", "中"], ["high", "高"], ["xhigh", "极高"], ["max", "最大"]
  ];
  var SA_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
  var SA_THINK_LABEL = { off: "关闭", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "极高", max: "最大" };

  function renderModelBtn() {
    $("model-name").textContent = S.model ? (S.model.name || S.model.id) : "—";
    $("model-btn").title = S.model ? (S.model.provider + "/" + S.model.id + " · 思考 " + (THINK_LABEL[S.thinkLevel] || S.thinkLevel || "—")) : "选择模型";
    renderChips();
  }

  /* ---------- 输入区工具条：思考等级 / 工具预设 胶囊 ---------- */
  // 胶囊上显示中文名（思考等级：中/高…，工具预设：默认/只读…），
  // 原始 pi 标识（low / default …）放到 tooltip 里，界面不再夹杂英文。
  var TOOL_PRESETS = [
    ["chat-only", "仅对话", "不带任何工具"],
    ["read-only", "只读", "read / grep / find / ls"],
    ["default", "默认", "pi 自己的默认工具集"],
    ["full", "全部", "读、写、执行全开"]
  ];
  var CHIP_POP = null;

  function presetLabel(k) {
    for (var i = 0; i < TOOL_PRESETS.length; i++) if (TOOL_PRESETS[i][0] === k) return TOOL_PRESETS[i][1];
    return k || "default";
  }

  function renderChips() {
    var t = $("chip-think-txt"), p = $("chip-preset-txt");
    if (!t || !p) return;
    t.textContent = THINK_LABEL[S.thinkLevel] || S.thinkLevel || "中";
    $("chip-think").title = "思考等级：" + (S.thinkLevel || "—");
    p.textContent = presetLabel(S.toolPreset);
    $("chip-preset").title = "工具预设：" + (S.toolPreset || "default") + "（切换需重启 pi）";
    $("chip-preset").classList.toggle("on", (S.toolPreset || "default") !== "default");
    var b = $("btn-sound");
    if (b) {
      b.title = S.sound ? "回合结束提示音：开" : "回合结束提示音：关";
      b.querySelector("use").setAttribute("href", S.sound ? "#i-volume" : "#i-volume-x");
      b.classList.toggle("dim", !S.sound);
    }
  }

  function closeChipPop() {
    var p = $("chip-pop");
    if (p) { p.hidden = true; p.innerHTML = ""; }
    CHIP_POP = null;
  }

  function openChipPop(kind) {
    var p = $("chip-pop");
    if (!p) return;
    if (CHIP_POP === kind) { closeChipPop(); return; }
    closeModelPop();
    CHIP_POP = kind;
    p.innerHTML = "";
    function item(name, sub, on, tip, fn) {
      var it = el("div", "mp-item");
      it.innerHTML = '<svg class="i ck"><use href="#i-check"/></svg>';
      if (!on) it.firstChild.style.visibility = "hidden";
      it.appendChild(el("span", "nm", name));
      if (sub) it.appendChild(el("span", "sub", sub));
      if (tip) it.title = tip;
      it.addEventListener("click", fn);
      p.appendChild(it);
    }
    if (kind === "think") {
      p.appendChild(el("div", "mp-sec", "思考等级"));
      var list = S.thinkLevels.length ? S.thinkLevels : ["off", "minimal", "low", "medium", "high"];
      list.forEach(function (k) {
        item(k, THINK_LABEL[k] || "", k === S.thinkLevel, null, function () {
          send("pi.call", { type: "set_thinking_level", params: { level: k } })
            .then(function () {
              S.thinkLevel = k;
              renderModelBtn();
              openChipPop("think");
              toasts("思考等级：" + (THINK_LABEL[k] || k));
            })
            .catch(function (e) { toasts("设置失败：" + e.message, "error"); });
        });
      });
    } else {
      p.appendChild(el("div", "mp-sec", "工具预设"));
      TOOL_PRESETS.forEach(function (t) {
        item(t[0], t[1] + " · " + t[2], t[0] === (S.toolPreset || "default"), null, function () {
          setToolPreset(t[0]);
        });
      });
      p.appendChild(el("div", "mp-note", "pi 没有运行中改工具集的 RPC，切换要重启 pi 子进程并把当前会话接回来。"));
    }
    p.hidden = false;
  }

  /* 工具预设：写配置 → 重启 pi → switch_session 接回原会话。
     不接回来的话重启就是一个空白新会话，看着像聊天记录被清了。 */
  function setToolPreset(k) {
    if (k === (S.toolPreset || "default")) { closeChipPop(); return; }
    if (S.streaming) { toasts("运行中不能切换工具预设，请先停止", "warn"); return; }
    var back = S.liveSession || S.activeSession;
    closeChipPop();
    toasts("正在切换工具预设…");
    send("settings.set", { toolPreset: k })
      .then(function () {
        S.toolPreset = k;
        renderChips();
        return send("pi.restart");
      })
      .then(function () {
        if (!back) { S.liveSession = null; return null; }
        return send("pi.call", { type: "switch_session", params: { sessionPath: back } })
          .then(function () { S.liveSession = back; });
      })
      .then(function () { return rebuildFromMessages(); })
      .then(function () { return refreshState(); })
      .then(function () { toasts("工具预设：" + k + "（pi 已重启）"); })
      .catch(function (e) { toasts("切换失败：" + (e && e.message || e), "error"); });
  }

  /* 服务商显示名：取 pi 目录里的 name（商汤 / WORKBUDDY …），取不到就退回 id */
  function providerLabel(id) {
    var n = S.providerNames && S.providerNames[id];
    if (!n && typeof MdCatalog !== "undefined" && MdCatalog.byId && MdCatalog.byId[id]) n = MdCatalog.byId[id].name;
    n = n || id || "—";
    /* 分组表头：纯 ASCII 的服务商名统一大写（与参考版式一致），中文名不动 */
    return /^[\x20-\x7e]+$/.test(n) ? n.toUpperCase() : n;
  }
  /* 作用域徽标：global / project → 全局 / 项目 */
  function scopeZh(v) {
    if (v === "global") return "全局";
    if (v === "project") return "项目";
    return v || "全局";
  }
  /* 只拉一次：node 起目录比较慢，开机异步预热，打开弹窗时基本已经好了 */
  function loadProviderNames() {
    if (S.providerNames) return Promise.resolve(S.providerNames);
    return send("models.catalog", {})
      .then(function (r) {
        var map = {};
        ((r && r.providers) || []).forEach(function (p) { if (p && p.id) map[p.id] = p.name || p.id; });
        S.providerNames = map;
        return map;
      })
      .catch(function () { S.providerNames = {}; return S.providerNames; });
  }

  function closeModelPop() { var p = $("model-pop"); if (p) p.hidden = true; }

  function openModelPop() {
    var pop = $("model-pop");
    pop.innerHTML = "";
    // 按服务商分组：组头是服务商显示名，模型缩进列在下面（对齐参考图）
    var order = [], byP = {};
    S.models.forEach(function (m) {
      var k = m.provider || "—";
      if (!byP[k]) { byP[k] = []; order.push(k); }
      byP[k].push(m);
    });
    if (!order.length) pop.appendChild(el("div", "mp-item", "无可用模型"));
    order.forEach(function (k) {
      pop.appendChild(el("div", "mp-grp", providerLabel(k)));
      byP[k].forEach(function (m) {
        var it = el("div", "mp-item");
        var cur = S.model && S.model.id === m.id && S.model.provider === m.provider;
        if (cur) it.className = "mp-item on";
        it.innerHTML = '<svg class="i ck"><use href="#i-check"/></svg>';
        if (!cur) it.firstChild.style.visibility = "hidden";
        it.appendChild(el("span", "nm", m.name || m.id));
        var caps = [];
        if (m.contextWindow) caps.push(fmtNum(m.contextWindow));
        if (m.input && m.input.indexOf("image") >= 0) caps.push("图片");
        if (m.reasoning) caps.push("思考");
        it.title = (m.name || m.id) + " · " + m.provider + "/" + m.id +
          (caps.length ? " · " + caps.join(" · ") : "");
        it.addEventListener("click", function () {
          closeModelPop();
          send("pi.call", { type: "set_model", params: { provider: m.provider, modelId: m.id } })
            .then(function (r) {
              if (r.success && r.data) { S.model = r.data; renderModelBtn(); }
              return refreshState();
            })
            .then(function () { toasts("已切换到 " + (m.name || m.id)); })
            .catch(function (e) { toasts("切换失败：" + e.message, "error"); });
        });
        pop.appendChild(it);
      });
    });
    loadProviderNames();
    pop.appendChild(el("div", "mp-sep"));
    pop.appendChild(el("div", "mp-sec", "思考等级"));
    var lv = el("div", "mp-lv");
    var list = S.thinkLevels.length ? S.thinkLevels : ["off", "minimal", "low", "medium", "high"];
    list.forEach(function (k) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = THINK_LABEL[k] || k;
      if (k === S.thinkLevel) b.className = "on";
      b.title = k;
      b.addEventListener("click", function () {
        send("pi.call", { type: "set_thinking_level", params: { level: k } })
          .then(function () { S.thinkLevel = k; renderModelBtn(); openModelPop(); toasts("思考等级：" + (THINK_LABEL[k] || k)); })
          .catch(function (e) { toasts("设置失败：" + e.message, "error"); });
      });
      lv.appendChild(b);
    });
    pop.appendChild(lv);
    pop.appendChild(el("div", "mp-sep"));
    var all = el("div", "mp-item", "管理全部模型（设置）…");
    all.addEventListener("click", function () { closeModelPop(); openModal("models"); });
    pop.appendChild(all);
    pop.hidden = false;
  }

  /* ================= 草稿 =================
     参考实现把每个会话没写完的话存在本地（draft-store），移植版原来切走就没了。
     键是会话文件路径（小写），只留最近 DRAFT_MAX 个，免得 localStorage 无限长。 */
  var DRAFT_KEY = "pi-drafts";
  var DRAFT_MAX = 30;
  var draftTimer = 0;

  function draftKey(p) {
    return String(p || "").toLowerCase();
  }
  function draftsAll() {
    try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }
  function draftSave(path, text) {
    if (!path) return;
    var all = draftsAll();
    var k = draftKey(path);
    if (text) all[k] = { text: text, at: Date.now() };
    else delete all[k];
    var keys = Object.keys(all);
    if (keys.length > DRAFT_MAX) {
      keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
      keys.slice(0, keys.length - DRAFT_MAX).forEach(function (x) { delete all[x]; });
    }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch (e) { /* 配额满了就算了 */ }
  }
  function draftGet(path) {
    if (!path) return "";
    var d = draftsAll()[draftKey(path)];
    return (d && d.text) || "";
  }
  /* 防抖写：每敲一个字就写 localStorage 会卡 */
  function draftQueue(path, text) {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(function () { draftTimer = 0; draftSave(path, text); }, 250);
  }
  function draftFlush() {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = 0; }
    var ta = $("input");
    if (S.activeSession && ta) draftSave(S.activeSession, ta.value.trim() ? ta.value : "");
  }
  function setInputText(t) {
    var ta = $("input");
    ta.value = t || "";
    ta.style.height = "auto";
    ta.style.height = Math.min(180, ta.scrollHeight) + "px";
    if (typeof syncSlash === "function") syncSlash();
  }
  /* 开机恢复：pi 那边可能已经带着一个会话，把它的草稿也捞回来 */
  function restoreDraft() {
    var ta = $("input");
    if (ta.value) return;                 // 用户已经开打了，别覆盖
    var t = draftGet(S.activeSession);
    if (t) setInputText(t);
  }
  function bindDrafts() {
    $("input").addEventListener("input", function () {
      draftQueue(S.activeSession, $("input").value);
    });
  }

  /* ================= 发消息 ================= */
  function activeOrNull() {
    return S.streaming;
  }
  function submit(kind) {
    var ta = $("input");
    var text = ta.value.trim();
    var imgs = S.images.slice();
    if (!text && !imgs.length) return;
    ta.value = "";
    ta.style.height = "auto";
    draftSave(S.activeSession, "");   // 发出去了，草稿就该没了
    addUserMsg(text, imgs);

    // pi RPC 的 images 结构：{ type:"image", data, mimeType }，data 为不带前缀的 base64。
    var piImages = imgs.map(function (i) { return { type: "image", data: i.data, mimeType: i.mimeType }; });
    var gate = S.pendingSwitch || Promise.resolve();
    var promise;
    // 一律走 prompt + streamingBehavior，由 pi 的 AgentSession 原子决定「插进当前运行」还是
    // 「开新一轮」：直接发 steer/follow_up 在运行刚好结束的瞬间会把消息留在空队列里，
    // 表现为「插入的消息要等前面的问题做完才回答」。
    var params = { message: text };
    if (piImages.length) params.images = piImages;
    if (S.streaming) params.streamingBehavior = (kind === "follow") ? "followUp" : "steer";
    promise = gate.then(function () { return send("pi.send", { type: "prompt", params: params }); });
    // 只有真正发出去才清空附件，失败可重发
    if (piImages.length) { S.images = []; renderAttachStrip(); }
    promise.then(function () {
      if (!S.streaming) { S.streaming = true; updateRunState(); }
    }).catch(function (e) { toasts("发送失败：" + e.message, "error"); });
  }

  /* ================= 打开会话（走磁盘 jsonl 分页，不走 pi 的 get_messages） =================
     实测：单会话 41.5MB / 5000+ 条。pi 那边光读文件 1.6s，再把整个会话过一遍 IPC、
     前端解析并渲染全部消息，点一下要十几秒——用户感知就是「打开历史很慢」。
     历史本来就逐条以 jsonl 落在磁盘上，这里只取尾部一页按需渲染，和网页版一样秒开。 */
  var HIST_PAGE = 80;

  /* pi 子进程是按 cwd 分目录落会话的（~/.pi/agent/sessions/<编码后的 cwd>/）。
     所以「新建会话 / 打开别的目录的会话」之前必须先把子进程挪到目标目录，
     否则新会话会落到 pi 进程原来所在的目录里 —— 也就是「新建的会话不在我选的目录」。
     目录一致时后端直接返回 changed:false，不重启、不丢上下文。 */
  function piUseCwd(dir) {
    return send("pi.useCwd", { cwd: dir || "" }).then(function (r) {
      if (r && r.changed) {
        S.liveSession = null;   // 换目录会重启 pi，它那条会话已经不作数了
        console.log("[pi] 工作目录 -> " + r.cwd);
      }
      return r;
    });
  }

  function openSession(path) {
    // 残缺会话（缺 {"type":"session"} 头，比如被截断的碎片文件）pi 一定拒绝，
    // 而且拒绝之前它已经把扩展运行时拆掉重建，界面上会连带弹出两条与本次切换
    // 无关的扩展错误（pi-subagents 不能重启 / ctx 已失效）。
    // 所以切换前先体检：不合法就原地停下，连侧栏高亮都不改，更不去惊动 pi。
    return send("session.probe", { path: path })
      .catch(function () { return { valid: true }; })   // 体检本身失败就当合法，交给 pi 去判断
      .then(function (r) {
        if (r && r.valid === false) {
          console.warn("[打开会话] 拒绝残缺会话：" + path);
          toasts("这个会话文件不完整（缺会话头），pi 打不开，已留在原会话", "warn");
          return null;
        }
        return openSessionNow(path);
      });
  }

  function openSessionNow(path) {
    var t0 = Date.now();
    draftFlush();                // 切走前先把旧会话的半截话落盘（防抖可能还没触发）
    S.activeSession = path;
    S.hist = null;
    updateHistMore();
    renderSessions();            // 先高亮选中行，不等 pi 回话
    setInputText(draftGet(path)); // 这个会话上次没写完的话捞回来
    var done = loadHistoryTail(path, 0).then(function () {
      // 要打开的这个会话可能属于别的目录（切工作目录后从列表里点回来的情况），
      // 先把子进程挪到该会话的 cwd 再切，目录一致时后端不会重启。
      var hit = (S.sessions || []).filter(function (x) { return x.path === path; })[0];
      return piUseCwd((hit && hit.cwd) || S.cwd || "").then(function () {
        // pi 侧也要真切过去，否则后面发的消息会落到上一个会话里。
        // 但点的就是 pi 正在跑的那条时不必切：switch_session 要 pi 把整条会话读进内存
        // （大会话实测 15–32s，自检里还因此超时），白等一场。统计照样重取。
        if (S.liveSession && S.liveSession === path) {
          console.log("[打开会话] pi 已在该会话，跳过切换 · 合计 " + (Date.now() - t0) + "ms");
          return refreshStats();
        }
        return send("pi.call", { type: "switch_session", params: { sessionPath: path } })
          .then(function (r) {
            if (r && r.success === false) throw new Error(r.error || "切换失败");
            S.liveSession = path;
            console.log("[打开会话] 合计 " + (Date.now() - t0) + "ms");
            // 切完必须重取一次统计：pi 的 get_session_stats 认的是「当前会话」，
            // 切前取到的是上一个会话的数字，切后不取则顶栏计量一直是 0（开机恢复会话尤其明显）。
            return refreshStats();
          });
      })
        .catch(function (e) { toasts("切换失败：" + e.message, "error"); });
    });
    // 切换完成前用户就回车的话，submit 会等这个 promise（否则消息会发到旧会话）
    S.pendingSwitch = done;
    done.then(function () { if (S.pendingSwitch === done) S.pendingSwitch = null; });
    return done;
  }

  /* 取一页历史：before=0 取最新一页，否则取该字节偏移之前的一页（往上翻） */
  function loadHistoryTail(path, before) {
    var t0 = Date.now();
    return send("session.tail", { path: path, limit: HIST_PAGE, before: before || 0 })
      .then(function (r) {
        var t1 = Date.now();
        var msgs = r.messages || [];
        var prev = (before && S.hist && S.hist.path === path) ? S.hist.shown : 0;
        S.hist = {
          path: path,
          total: r.total || 0,
          startByte: r.startByte || 0,
          hasMore: !!r.hasMore,
          shown: prev + msgs.length
        };
        rebuildFromMessages(msgs, before ? "prepend" : "replace");
        console.log("[历史] 取数 " + (t1 - t0) + "ms · 渲染 " + (Date.now() - t1) + "ms · " +
                    msgs.length + " 条 / 共 " + S.hist.total + (before ? "（更早一页）" : ""));
        updateHistMore();
        return r;
      });
  }

  /* 本目录对比用：去掉末尾斜杠、统一小写（Windows 路径不区分大小写） */
  function normDirJs(p) {
    return String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  }

  function updateHistMore() {
    var b = $("hist-more");
    if (!b) return;
    var more = !!(S.hist && S.hist.hasMore && S.hist.path === S.activeSession);
    b.hidden = !more;
    if (more) b.textContent = "加载更早的消息（" + S.hist.shown + "/" + S.hist.total + "）";
  }

  function loadEarlier() {
    if (!S.hist || !S.hist.hasMore) return Promise.resolve();
    var b = $("hist-more");
    var t0 = Date.now();
    b.disabled = true;
    return loadHistoryTail(S.hist.path, S.hist.startByte)
      .catch(function (e) { toasts("加载更早的消息失败：" + e.message, "error"); })
      .then(function () {
        b.disabled = false;
        console.log("[历史] 更早一页合计 " + (Date.now() - t0) + "ms");
      });
  }

  /* ================= 目录选择模态（工作目录 →「+ 自定义路径…」） ================= */
  var DP = { cwd: "" };

  function openDirPicker(start) {
    DP.cwd = "";
    $("dir-pick").hidden = false;
    return dpGo(start || S.cwd || "~");
  }
  function closeDirPicker() { $("dir-pick").hidden = true; }

  function dpGo(p) {
    return send("fs.list", { path: p || "~" })
      .then(function (r) {
        DP.cwd = r.path || "";
        dpRender(r);
      })
      .catch(function (e) { toasts("列目录失败：" + e.message, "error"); });
  }

  function dpRender(r) {
    // 输入框里放完整路径（和参考截图一致）；用户手改后用后端的 expand_path 解析
    $("dp-path").value = DP.cwd || "";
    var box = $("dp-list");
    box.innerHTML = "";
    var n = 0;
    (r.entries || []).forEach(function (e) {
      if (!e.dir) return;
      n++;
      var row = el("div", "dp-row");
      row.appendChild(icon("i-folder"));
      row.appendChild(el("span", "dp-name", e.name));
      row.addEventListener("click", function () { dpGo(e.path); });
      box.appendChild(row);
    });
    if (!n) box.appendChild(el("div", "empty", "（没有子目录）"));
  }

  function dpGoTyped() {
    var v = ($("dp-path").value || "").trim();
    if (v) dpGo(v);
  }

  function dpUp() {
    if (!DP.cwd) return;
    send("fs.up", { path: DP.cwd }).then(function (r) { if (r && r.path) dpGo(r.path); });
  }

  /* 「选择此文件夹」= 用当前所在目录（不是列表里选中的那行） */
  function dpAccept() {
    var v = (DP.cwd || "").trim() || ($("dp-path").value || "").trim();
    if (!v) return;
    closeDirPicker();
    wsPick(v);
  }

  /* ================= 会话列表（本地会话目录） ================= */
  function loadSessions() {
    // 带上当前目录：pi 的会话是按 cwd 分目录落盘的，只列这个目录的
    return send("session.list", { cwd: S.cwd || "" })
      .then(function (r) {
        S.sessions = r.sessions || [];
        S.sessionOther = r.otherCount || 0;
        renderSessions();
      })
      .catch(function (e) { console.warn("会话列表失败", e); });
  }

  function renderSessions() {
    var box = $("session-list");
    box.innerHTML = "";
    var kw = ($("search-input").value || "").trim().toLowerCase();
    // 搜索面：标题 / 用户设过的名字 / 会话文件路径 / 工作目录。
    // 参考实现连正文一起搜（它把消息索引建在内存里），移植版只搜元数据——
    // 正文在 jsonl 里，为了搜索把整个会话目录扫一遍代价太大。
    var list = S.sessions.filter(function (s) {
      if (!kw) return true;
      var hay = [s.title, s.name, s.path, s.cwd].map(function (x) {
        return String(x == null ? "" : x).toLowerCase();
      }).join("\n");
      return hay.indexOf(kw) >= 0;
    });
    if (!list.length) {
      var t = kw ? "无匹配会话" : "本目录暂无会话";
      if (!kw && S.sessionOther) t += "（其它目录还有 " + S.sessionOther + " 个）";
      box.appendChild(el("div", "empty", t));
      return;
    }
    list.forEach(function (s) {
      var d = el("div", "sess" + (s.path === S.activeSession ? " active" : ""));
      var title = s.title || "(未命名)";
      if (s.path === S.activeSession && S.sessionName) title = S.sessionName;
      // 标题行：标题 + 悬停才出现的两个按钮（改名／删除），照参考截图。
      // 用 .sess-row 而不是直接放 .sess 里，是因为删除确认时要把整行换成别的。
      var row = el("div", "sess-row");
      row.appendChild(el("div", "sess-title", title));
      var acts = el("div", "sess-acts");
      acts.appendChild(sessAct("i-download", "导出为 Markdown", function () { exportSession(s); }));
      acts.appendChild(sessAct("i-pen", "重命名", function () { startRename(d, s, title); }));
      acts.appendChild(sessAct("i-trash", "删除（按住 Shift 点击可跳过确认）", function (e) {
        if (e.shiftKey) doDelete(s); else askDelete(d, s, title);
      }));
      row.appendChild(acts);
      var m = el("div", "sess-meta");
      m.appendChild(el("span", "", relTime(s.mtime)));
      if (s.messages) m.appendChild(el("span", "", s.messages + " 条消息"));
      if (s.running) {
        var run = el("span", "dot");
        run.appendChild(icon("i-spinner"));
        run.appendChild(el("span", "", "运行中"));
        m.appendChild(run);
      }
      d.appendChild(row); d.appendChild(m);
      d.title = s.path;
      d.addEventListener("click", function () {
        if (s.path === S.activeSession) return;
        openSession(s.path);
      });
      box.appendChild(d);
    });
  }

  /* ---- 导出会话为 Markdown ----
     参考实现有会话导出；移植版的 fs.saveAs 只能「复制已有文件」，写不了新内容，
     所以 Rust 侧加了 fs.saveText（弹另存为对话框 + 写 UTF-8）。 */
  function safeFileName(s) {
    var t = String(s || "会话").replace(/[\\/:*?"<>|\r\n\t]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 60);
    return t || "会话";
  }
  /* 取一个会话的全部消息：session.tail 的 limit 被后端夹在 1..400 条，
     所以要按 startByte 一页页往前翻，翻到 hasMore 为假为止。 */
  function fetchAllMessages(path) {
    var all = [];
    var before = 0;
    var guard = 0;
    function step() {
      guard++;
      if (guard > 200) return Promise.resolve(all);
      return send("session.tail", { path: path, limit: 400, before: before }).then(function (r) {
        var msgs = (r && r.messages) || [];
        all = msgs.concat(all);
        if (!r || !r.hasMore || !msgs.length || !r.startByte) return all;
        before = r.startByte;
        return step();
      });
    }
    return step();
  }
  function msgToMd(m) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return "";
    var out = [];
    if (m.role === "user") {
      var t = typeof m.content === "string" ? m.content
        : (m.content || []).filter(function (c) { return c && c.type === "text"; })
            .map(function (c) { return c.text || ""; }).join("\n");
      if (!t.trim()) return "";
      out.push("### 用户");
      out.push(t.trim());
      return out.join("\n\n");
    }
    var texts = [], thinks = 0, tools = [];
    (m.content || []).forEach(function (c) {
      if (!c) return;
      if (c.type === "text") texts.push(c.text || "");
      else if (c.type === "thinking") thinks++;
      else if (c.type === "toolCall") tools.push(c);
    });
    out.push("### 助手");
    if (texts.join("").trim()) out.push(texts.join("\n").trim());
    if (thinks) out.push("> （思考过程 " + thinks + " 段，已省略）");
    tools.forEach(function (c) {
      out.push("- 工具 `" + (c.name || "?") + "`：" + (toolPreview(c.arguments || {}) || "—"));
    });
    if (m.usage) {
      var u = m.usage;
      out.push("> 用量：输入 " + fmtNum(u.input || 0) + " · 输出 " + fmtNum(u.output || 0) +
        (u.cacheRead ? " · 缓存读 " + fmtNum(u.cacheRead) : ""));
    }
    return out.join("\n\n");
  }
  function buildSessionMd(s, msgs) {
    var title = (s && (s.name || s.title)) || "会话";
    var head = ["# " + title, "",
      "- 会话文件：`" + ((s && s.path) || S.activeSession || "") + "`",
      "- 工作目录：`" + ((s && s.cwd) || S.cwd || "") + "`",
      "- 消息数：" + msgs.length,
      "- 导出时间：" + new Date().toLocaleString("zh-CN"),
      "", "---", ""];
    var body = msgs.map(msgToMd).filter(Boolean).join("\n\n");
    return head.join("\n") + body + "\n";
  }
  function exportSession(s) {
    var path = (s && s.path) || S.activeSession;
    if (!path) { toasts("没有可导出的会话", "warn"); return; }
    toasts("正在整理会话…", "info");
    fetchAllMessages(path).then(function (msgs) {
      var name = safeFileName((s && (s.name || s.title)) || "会话") + ".md";
      return send("fs.saveText", { name: name, text: buildSessionMd(s, msgs) }).then(function (r) {
        if (r && r.canceled) return;
        toasts("已导出 " + msgs.length + " 条消息 → " + (r.dest || ""), "ok");
      });
    }).catch(function (e) { toasts("导出失败：" + e.message, "error"); });
  }

  /* 会话行右侧的图标按钮：26px 方块，默认不显示（CSS .sess:hover .sess-acts） */
  function sessAct(id, tip, on) {
    var b = el("button");
    b.type = "button";
    b.title = tip;
    b.appendChild(icon(id));
    b.addEventListener("click", function (e) { e.stopPropagation(); on(e); });
    return b;
  }

  /* ---- 改名：标题就地变输入框，Enter 提交 / Esc 取消 / 失焦提交 ----
     用 s.name（用户真正设过的名字）做「有没有改动」的基准，不用 s.title——
     title 很可能只是首条消息的截断，拿它比对会把首条消息误存成会话名。 */
  function startRename(node, s, title) {
    if (node.classList.contains("editing")) return;
    node.classList.add("editing");
    var row = node.querySelector(".sess-row");
    var input = el("input", "sess-rename");
    input.type = "text";
    input.maxLength = 200;
    input.value = s.name || title;
    row.innerHTML = "";
    row.appendChild(input);
    input.focus();
    input.select();
    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      node.classList.remove("editing");
      var name = (input.value || "").trim();
      if (!save || name === (s.name || "")) { renderSessions(); return; }
      send("pi.call", { type: "set_session_name", params: { name: name } })
        .then(function (r) {
          if (r && r.success === false) throw new Error(r.error || "写入失败");
          s.name = name;
          s.title = name;
          if (s.path === S.activeSession) S.sessionName = name;
          renderSessions();
          toasts("已重命名为 " + name);
        })
        .catch(function (e) { toasts("重命名失败：" + e.message, "error"); renderSessions(); });
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", function () { commit(true); });
    // 别把点击冒到行上：那会触发切换会话
    input.addEventListener("click", function (e) { e.stopPropagation(); });
  }

  /* ---- 删除确认：整行换成「删除 {标题}？ + 红色删除 / 取消」----
     先用 22 字截断，照参考截图，免得长标题把两个按钮挤没。 */
  function askDelete(node, s, title) {
    node.classList.add("confirm");
    node.innerHTML = "";
    var shown = title.length > 22 ? title.slice(0, 22) + "…" : title;
    node.appendChild(el("div", "sess-ask", "删除 " + shown + "？"));
    var ok = el("button", "sess-confirm-btn");
    ok.type = "button";
    ok.appendChild(icon("i-trash"));
    ok.appendChild(el("span", "", "删除"));
    ok.addEventListener("click", function (e) { e.stopPropagation(); node.classList.add("busy"); doDelete(s); });
    var no = el("button", "sess-cancel-btn", "取消");
    no.type = "button";
    no.addEventListener("click", function (e) { e.stopPropagation(); renderSessions(); });
    node.appendChild(ok);
    node.appendChild(no);
  }

  /* ---- 真删：fs.delete 落 os 层删文件，索引里的残留条目会被 session.list 跳过 ---- */
  function doDelete(s) {
    return send("fs.delete", { path: s.path })
      .then(function (r) {
        S.sessions = S.sessions.filter(function (x) { return x.path !== s.path; });
        // 删的就是当前会话：pi 侧还指着已不存在的文件，切到新会话句避免出错
        if (s.path === S.activeSession) {
          S.activeSession = null;
          S.sessionName = "";
          streamInner.innerHTML = "";
          S.msgIndex = Object.create(null);
          liveNode = null;
          S.liveSession = null;   // pi 要新建一条，具体是哪条得等它回报
          send("pi.call", { type: "new_session" }).catch(function (e) {
            console.warn("[session] 新建会话失败：" + ((e && e.message) || e));
          });
        }
        renderSessions();
        toasts("已从硬盘删除" + (r && r.size ? "（" + (r.size / 1024).toFixed(1) + " KB）" : ""), "ok");
        loadSessions();
      })
      .catch(function (e) { toasts("删除失败：" + e.message, "error"); renderSessions(); });
  }

  /* msgsOverride / mode 是历史分页用的（见 loadHistoryTail）：
     mode="prepend" 时先把这一页渲染进游离容器，再整体插到最前面，
     这样 toolResult 找「最近的助手节点」被限制在本页内，不会跨页配错。
     不传参数就是原来的行为：取 pi 的全部消息重建整条消息流。 */
  function rebuildFromMessages(msgsOverride, mode) {
    var t0 = Date.now();
    var get = msgsOverride
      ? Promise.resolve({ data: { messages: msgsOverride } })
      : send("pi.call", { type: "get_messages" });
    return get
      .then(function (r) {
        var t1 = Date.now();
        var msgs = (r.data && r.data.messages) || [];
        if (mode === "prepend") {
          MSG_HOST = el("div", "hist-page");
        } else {
          streamInner.innerHTML = "";
          S.msgIndex = Object.create(null);
          liveNode = null;
          MSG_HOST = null;
        }
        msgs.forEach(function (m) {
          if (m.role === "user") {
            var txt = typeof m.content === "string" ? m.content
              : (m.content || []).filter(function (c) { return c.type === "text"; })
                  .map(function (c) { return c.text; }).join("\n");
            addUserMsg(txt);
          } else if (m.role === "assistant") {
            var node = newMessageEl("assistant");
            var texts = [], thinks = [];
            (m.content || []).forEach(function (c) {
              if (c.type === "text") texts.push(c.text);
              else if (c.type === "thinking") thinks.push(c.thinking);
              else if (c.type === "toolCall") {
                var rec = toolCard(node, c.id, c.name);
                setToolInput(rec, c.arguments || {});
                rec.pre.hidden = true;
                clearInterval(rec.timer);
                rec.dur.textContent = "";
              }
            });
            if (thinks.length) {
              node.body.appendChild(thinkBlock(thinks.join("\n"), S.expandThinking !== false));
            }
            /* 正文插到思考块前面。以前写的是 node.body.innerHTML = md(...) + node.body.innerHTML，
               序列化再解析会把思考块换成新节点，事件监听全丢 → 历史会话里点「展开」毫无反应。 */
            var mdHtml = md(texts.join("\n"));
            if (mdHtml) {
              var holder = el("div");
              holder.innerHTML = mdHtml;
              var anchor = node.body.firstChild;
              while (holder.firstChild) node.body.insertBefore(holder.firstChild, anchor);
            }
            if (m.usage) usageLine(node, m.usage);
          } else if (m.role === "toolResult") {
            var owner = null;
            for (var k in S.msgIndex) { void k; }
            // 找到最近的 assistant 节点并补结果
            var last = msgHost().lastElementChild;
            while (last && !last.classList.contains("assistant")) last = last.previousElementSibling;
            if (last) owner = last;
            if (owner) {
              var cards = owner.querySelectorAll(".tool-card");
              var card = cards[cards.length - 1];
              if (card) {
                if (m.isError) card.classList.add("err");
                var pre = card.querySelector("pre.tool-res");
                if (pre) {
                  var pa = card.querySelector("pre.tool-args");
                  setRes(pre, card._rec || { lang: (pa && pa._lang) || "" },
                    (m.content || []).map(function (x) { return x.text || ""; }).join(""));
                }
                var durl = card.querySelector(".tool-dur");
                if (durl) durl.textContent = "";
              }
            }
          } else if (m.role === "bashExecution") {
            var nb = newMessageEl("user");
            nb.body.textContent = "$ " + (m.command || "") + "\n" + (m.output || "").slice(0, 2000);
          }
        });
        if (MSG_HOST) {
          // 插到最前面并保持视口不动（否则内容往上顶，用户会以为页面跳走了）
          var keep = streamBox.scrollHeight - streamBox.scrollTop;
          streamInner.insertBefore(MSG_HOST, streamInner.firstChild);
          streamBox.scrollTop = streamBox.scrollHeight - keep;
          MSG_HOST = null;
        } else {
          scrollDown(true);
        }
        // 开会话慢的时候靠这条分清「pi 传数据慢」还是「JS 渲染慢」
        console.log("[打开会话] " + (mode === "prepend" ? "更早一页 · " : "取数 " + (t1 - t0) + "ms · ") +
                    "渲染 " + (Date.now() - t1) + "ms · " + msgs.length + " 条");
        return refreshStats();
      })
      .catch(function (e) { toasts("加载消息失败：" + e.message, "error"); });
  }

  /* ================= 文件浏览器 ================= */
  /* 文件类型 → 图标 + 配色。思路上跟 pi-web 的 getFileIcon 一致（同一套
     文档轮廓，靠内部小符号 + 颜色区分），但它用的是 Catppuccin 图标集，
     一个类型一个 SVG 文件；这里自绘 8 种画在 sprite 里，不多挂外部文件。 */
  var FILE_KINDS = [
    [/\.(zip|rar|7z|tar|gz|bz2|xz|jar|war|apk|whl|nupkg)$/, "archive", "i-file-archive"],
    [/\.(png|jpe?g|gif|bmp|webp|ico|svg|tiff?|psd|heic)$/, "image", "i-file-image"],
    [/\.pdf$/, "pdf", "i-file-pdf"],
    [/\.(json|jsonl|ya?ml|toml|ini|cfg|conf|xml|env|lock)$/, "data", "i-file-data"],
    [/\.(xlsx?|csv|tsv|ods)$/, "sheet", "i-file-sheet"],
    [/\.(mp4|mkv|avi|mov|webm|mp3|wav|flac|m4a|ogg|wmv)$/, "media", "i-file-media"],
    [/\.(exe|dll|so|dylib|msi|sys|bin|lib|pdb|node)$/, "bin", "i-file-bin"],
    [/\.(js|jsx|mjs|cjs|ts|tsx|py|rs|go|java|kt|c|h|cpp|hpp|cs|php|rb|swift|lua|sh|bash|ps1|bat|cmd|sql|vue|svelte|css|scss|less|html?)$/, "code", "i-file-code"],
    [/\.(md|markdown|txt|log|rst|rtf|docx?|pptx?)$/, "doc", "i-file-text"],
  ];
  function fileKind(name) {
    var s = String(name).toLowerCase();
    for (var i = 0; i < FILE_KINDS.length; i++) {
      if (FILE_KINDS[i][0].test(s)) return FILE_KINDS[i];
    }
    return null;
  }

  /* 「@ 提及」：插到输入框的是相对当前目录的路径（照 pi-web 的 onAtMention） */
  function relPathOf(p) {
    var c = String(S.cwd || "").replace(/[\\/]+$/, "");
    if (c && String(p).toLowerCase().indexOf(c.toLowerCase()) === 0) {
      var t = String(p).slice(c.length).replace(/^[\\/]+/, "");
      if (t) return t;
    }
    return String(p).replace(/\\/g, "/");
  }
  function mentionPath(p) {
    var ta = $("input");
    var txt = "@" + relPathOf(p) + " ";
    var s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    var e = ta.selectionEnd == null ? s : ta.selectionEnd;
    var head = ta.value.slice(0, s);
    var tail = ta.value.slice(e);
    var pre = head && !/\s$/.test(head) ? " " : "";
    ta.value = head + pre + txt + tail;
    var pos = (head + pre + txt).length;
    try { ta.setSelectionRange(pos, pos); } catch (err) { /* 不支持的浏览器就算了 */ }
    ta.focus();
    // 触发自动升高（composer 的 input 监听只做高度自适应）
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    return txt.trim();
  }

  /* 建一行：目录带展开箭头，文件留同宽空位（跟参考实现一致）；
     名字上挂完整路径 tooltip；悬停才露出「@ 提及」「另存为」。 */
  function buildNodeRow(n, depth, open) {
    var row = el("div", "node" + (n.dir ? " dir" : ""));
    row.dataset.path = n.path;
    var caret = n.dir
      ? iconEl("caret" + (open ? "" : " closed"), "i-chevron-down")
      : el("span", "caret-sp");
    var kind = n.dir ? null : fileKind(n.name);
    var ic = n.dir
      ? iconEl("ficon", open ? "i-folder-open" : "i-folder")
      : iconEl("ficon" + (kind ? " k-" + kind[1] : ""), kind ? kind[2] : "i-file");
    var nm = el("span", "nm", n.name);
    nm.title = n.path;
    row.appendChild(caret); row.appendChild(ic); row.appendChild(nm);
    row._caret = caret; row._ficon = ic;
    var acts = el("div", "row-acts");
    var mb = el("button", "row-act mention");
    mb.type = "button"; mb.title = "插入路径";
    mb.appendChild(icon("i-at"));
    mb.appendChild(el("span", "", "提及"));
    mb.addEventListener("click", function (e) {
      e.stopPropagation();
      toasts("已提及 " + mentionPath(n.path));
    });
    acts.appendChild(mb);
    if (!n.dir) {
      var db = el("button", "row-act dl");
      db.type = "button"; db.title = "另存为…";
      db.appendChild(icon("i-download"));
      db.addEventListener("click", function (e) {
        e.stopPropagation();
        send("fs.saveAs", { path: n.path }).then(function (r) {
          if (!r || r.canceled) return;
          toasts("已另存为 " + r.dest);
        }).catch(function (err) { toasts("另存为失败：" + err.message, "error"); });
      });
      acts.appendChild(db);
    }
    row.appendChild(acts);
    return row;
  }

  function setRowOpen(row, isOpen) {
    if (row._caret) row._caret.classList.toggle("closed", !isOpen);
    if (row._ficon) {
      var u = row._ficon.querySelector("use");
      if (u) u.setAttribute("href", isOpen ? "#i-folder-open" : "#i-folder");
    }
  }

  function renderTree(nodes, host, depth) {
    (nodes || []).forEach(function (n) {
      var row = buildNodeRow(n, depth, false);
      host.appendChild(row);
      if (n.dir) {
        var childBox = el("div");
        childBox.hidden = true;
        host.appendChild(childBox);
        var loaded = false;
        row.addEventListener("click", function () {
          childBox.hidden = !childBox.hidden;
          setRowOpen(row, !childBox.hidden);
          if (!childBox.hidden && !loaded) {
            loaded = true;
            send("fs.list", { path: n.path }).then(function (r) {
              childBox.innerHTML = "";
              renderTree(r.entries || [], childBox, depth + 1);
            }).catch(function (e) {
              childBox.appendChild(el("div", "empty", "读取失败：" + e.message));
            });
          }
        });
      } else {
        // 文件：点开就在右侧面板里看（跟 pi-web 一样，取代原来只能「提及路径」的做法）
        row.addEventListener("click", function () { rpOpenFile(n.path); });
      }
    });
  }

  /* ---- 文件搜索（工具条放大镜）：递归按文件名匹配，语义同 pi-web 的「搜索文件」 ---- */
  var FSS = { open: false, timer: null, seq: 0, q: "" };
  function fsSearchToggle(on) {
    FSS.open = on === undefined ? !FSS.open : !!on;
    $("fs-panel").hidden = !FSS.open;
    $("fs-search").classList.toggle("on", FSS.open);
    if (FSS.open) {
      try { $("fs-query").focus(); } catch (e) {}
    } else {
      // 关面板要还原文件树，否则树被搜索替掉后关不上
      $("file-tree").hidden = false;
      $("fs-query").value = "";
      $("fs-results").innerHTML = "";
      FSS.q = "";
    }
    return FSS.open;
  }
  function fsRunSearch() {
    var q = $("fs-query").value.trim();
    FSS.q = q;
    var box = $("fs-results");
    // 有查询词就拿搜索结果替掉文件树（照参考实现：同一块区域只显示一份）
    $("file-tree").hidden = !!q;
    if (!q) { box.innerHTML = ""; return Promise.resolve(); }
    box.innerHTML = '<div class="empty">搜索中…</div>';
    var mine = ++FSS.seq;
    return send("fs.search", { path: S.cwd, query: q }).then(function (r) {
      if (mine !== FSS.seq || FSS.q !== q) return;   // 手快打了下一版，丢弃过期结果
      fsRenderResults(r, q);
    }).catch(function (e) {
      if (mine !== FSS.seq) return;
      box.innerHTML = "";
      box.appendChild(el("div", "empty", "搜索失败：" + e.message));
    });
  }
  function fsRenderResults(r) {
    var box = $("fs-results");
    box.innerHTML = "";
    var list = (r && r.paths) || [];
    if (!list.length) {
      box.appendChild(el("div", "empty", "没有匹配的文件"));
      return;
    }
    list.forEach(function (p) {
      var row = buildNodeRow({ name: p.name, path: p.path, dir: p.dir }, 0, false);
      var sub = el("span", "sub", p.rel);
      row.insertBefore(sub, row.querySelector(".row-acts"));
      // 点目录 = 跳过去展开，点文件 = 右侧面板打开
      row.addEventListener("click", function () {
        if (p.dir) { fsSearchToggle(false); loadTree(p.path); }
        else rpOpenFile(p.path);
      });
      box.appendChild(row);
    });
    if (r && r.truncated) box.appendChild(el("div", "empty", "结果过多，只显示前 200 条"));
  }

  function loadTree(path, depth) {
    var box = $("file-tree");
    box.innerHTML = '<div class="empty">加载中…</div>';
    return send("fs.list", { path: path })
      .then(function (r) {
        S.cwd = r.path;
        wsSyncLabel(r.display || r.path, r.path);
        box.innerHTML = "";
        renderTree(r.entries || [], box, depth || 0);
        return r;
      })
      .catch(function (e) {
        box.innerHTML = "";
        box.appendChild(el("div", "empty", "读取失败：" + e.message));
      });
  }

  /* ================= 侧栏顶部：工作目录下拉（照参考截图） ================= */
  /* 语义范围：只换文件浏览器的根目录（S.cwd），不重启 pi 进程——
     要重启就得重建成会话、丢掉当前上下文，超出本次需求。
     项目列表存 localStorage：WebView2 的数据目录就在 exe 旁边
     （pi-webview.exe.WebView2），拷到别的机器上跟着一起走。 */
  var WS_KEY = "piweb.ws.recent";
  var WS = { home: "", def: "" };

  /* ~ 开头的短显示，同参考实现 displayCwd */
  function wsDisplay(p) {
    if (!p) return "";
    var h = WS.home || "";
    if (h && p.toLowerCase().indexOf(h.toLowerCase()) === 0) return "~" + p.slice(h.length);
    return p;
  }
  function wsRecent() {
    try {
      var l = JSON.parse(localStorage.getItem(WS_KEY) || "[]");
      return Object.prototype.toString.call(l) === "[object Array]" ? l : [];
    } catch (e) { return []; }
  }
  function wsPush(p) {
    if (!p) return;
    var l = wsRecent().filter(function (x) { return x.p !== p; });
    l.unshift({ p: p, d: wsDisplay(p) });
    try { localStorage.setItem(WS_KEY, JSON.stringify(l.slice(0, 8))); } catch (e) {}
  }
  function wsSyncLabel(display, full) {
    var box = $("ws-path");
    box.innerHTML = "";
    var inner = document.createElement("span");
    inner.style.unicodeBidi = "plaintext";
    inner.textContent = display || "~";
    box.appendChild(inner);
    $("ws-btn").title = full || display || "";
  }
  function wsClose() {
    $("ws-menu").hidden = true;
    $("ws-btn").classList.remove("open");
  }
  function wsPick(p) {
    wsClose();
    return loadTree(p).then(function (r) {
      if (!r || !r.path) return r;
      wsPush(r.path);
      wsSyncLabel(r.display || r.path, r.path);
      // 会话列表跟着目录走：切了目录就只列这个目录的会话
      return loadSessions().then(function () { return r; });
    });
  }

  function wsItem(label, on, opt) {
    var b = el("button", "ws-item" + (on ? " on" : "") + (opt.act ? " action" : ""));
    b.type = "button";
    var tick = el("span", "ws-tick");
    if (on) tick.appendChild(icon("i-check"));
    b.appendChild(tick);
    if (opt.icon) b.appendChild(icon(opt.icon));
    var lb = el("span", "ws-label");
    var inner = document.createElement("span");
    inner.style.unicodeBidi = "plaintext";
    inner.textContent = label;
    lb.appendChild(inner);
    b.appendChild(lb);
    b.title = opt.tip || label;
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      if (opt.act === "custom") { wsClose(); openDirPicker(S.cwd); return; }
      if (opt.act === "up") {
        // 上级目录从工具条里摸掉了（参考实现的工具条只有 终端/搜索/上传/刷新），
        // 能力搬到这边，免得丢功能
        wsClose();
        send("fs.up", { path: S.cwd }).then(function (r) { wsPick(r.path); });
        return;
      }
      if (opt.p) wsPick(opt.p);
    });
    return b;
  }

  function renderWsMenu() {
    var box = $("ws-menu");
    box.innerHTML = "";
    var cur = S.cwd || "";
    var list = wsRecent();
    // 当前目录不在最近列表里（首次启动、或从「仅 Git 仓库根目录」跳过来的）
    // 也要排在最上面并打上勾
    if (cur && !list.some(function (x) { return x.p === cur; })) {
      list = [{ p: cur, d: wsDisplay(cur) }].concat(list);
    }
    var scroll = el("div", "ws-scroll");
    list.forEach(function (it) {
      scroll.appendChild(wsItem(it.d || wsDisplay(it.p), it.p === cur, { p: it.p, tip: it.p }));
    });
    box.appendChild(scroll);
    box.appendChild(el("div", "ws-sep"));
    box.appendChild(wsItem("使用默认目录", !!(WS.def && cur === WS.def), {
      p: WS.def, act: "default", icon: "i-folder", tip: WS.def
    }));
    box.appendChild(wsItem("自定义路径…", false, { act: "custom", icon: "i-plus" }));
    box.appendChild(wsItem("上级目录", false, { act: "up", icon: "i-corner-up-left" }));
  }

  function bindWorkspace() {
    $("ws-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      if ($("ws-menu").hidden) {
        renderWsMenu();
        $("ws-menu").hidden = false;
        $("ws-btn").classList.add("open");
      } else {
        wsClose();
      }
    });
    // 点别处 / Esc 关闭；菜单内部的点击由各元素 stopPropagation 挡住
    document.addEventListener("click", function () { if (!$("ws-menu").hidden) wsClose(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("ws-menu").hidden) wsClose();
    });
  }

  /* ================= 右上角用量详情面板 ================= */
  /* 点顶栏的 token 计量展开详情（会话信息 / 项目信息 | 消息 | Token），再点收起；
     点别处或 Esc 也收。数据全部来自已有的 S.stats（get_session_stats 已给出 sessionFile /
     sessionId / userMessages / assistantMessages / toolCalls / toolResults / tokens /
     contextUsage），只有「活跃时长」本地没有——pi 的 stats 不含这个字段，要让它扫一遍
     会话 jsonl（session.info），所以那格是回来后补上的。 */
  function fmtFull(n) {
    return (Number(n) || 0).toLocaleString("en-US");
  }
  /* 活跃时长照参考图风格：9h 14m；不足一小时只给 14m */
  function fmtDur(ms) {
    if (ms === null || ms === undefined || ms < 0) return "—";
    var m = Math.floor(ms / 60000);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }
  /* WebView2 里 navigator.clipboard 在非聚焦或非安全上下文会挂，兜底走 execCommand */
  function fallbackCopy(txt) {
    var ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }
  function copyText(txt, btn) {
    var mark = function () {
      if (!btn) return;
      var old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(function () { btn.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(mark, function () { fallbackCopy(txt); mark(); });
    } else {
      fallbackCopy(txt);
      mark();
    }
  }
  /* 面板里的一行：左标签 + 右值（等宽右对齐）。
     wrap 给长路径/长 ID 用：值左对齐、按字符断行，不撑破面板。
     copy 加一个「复制」小按钮，复制的是原始值（不是显示值）。 */
  function spRow(k, v, opts) {
    opts = opts || {};
    var text = v === null || v === undefined || v === "" ? "—" : String(v);
    var r = el("div", "sp-r");
    r.appendChild(el("span", "sp-k", k));
    if (opts.wrap) {
      var w = el("div", "sp-wr");
      w.appendChild(el("span", "sp-v wrap", text));
      r.appendChild(w);
    } else {
      r.appendChild(el("span", "sp-v", text));
    }
    if (opts.copy && v) {
      var b = el("button", "sp-copy", "复制");
      b.type = "button";
      b.addEventListener("click", function (e) { e.stopPropagation(); copyText(String(v), b); });
      r.appendChild(b);
    }
    return r;
  }
  function renderStatsPop() {
    var pop = $("stats-pop");
    if (!pop || pop.hidden) return;
    var st = S.stats || {};
    var lt = st.tokens || {};
    var cu = st.contextUsage || {};
    // 面板描述的是「当前打开的那条会话」，不是 pi 子进程的活会话：
    // get_session_stats 只报活会话，看历史会话时消息数/Token 会是 0，
    // 所以消息与 Token 以 session.info 扫 jsonl 出来的账为准，活会话才用实时数。
    var info = S.statsInfo && S.statsInfo.path === S.activeSession ? S.statsInfo : null;
    var live = !!S.activeSession && S.activeSession === st.sessionFile;
    var mi = (info && info.messages) || null;
    var it = (info && info.tokens) || null;
    var t = !it || live ? lt : it;
    var billed = (t.input || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
    var total = t.total === undefined
      ? (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0)
      : t.total;
    // 平均缓存命中率 = 缓存读取 / (输入 + 缓存读取 + 缓存写入)，与参考图的 98.1% 同口径
    var hit = billed > 0 ? (t.cacheRead || 0) / billed * 100 : null;
    // 上下文占用：活会话用 pi 报的；历史会话用扫出来的最后一条 assistant 上下文量 / 窗口
    var win = cu.contextWindow || 0;
    var ctxT = live ? 0 : ((info && info.contextTokens) || 0);
    var ctxTxt;
    if (win > 0 && ctxT > 0) {
      ctxTxt = fmtPercent(ctxT / win * 100) + " / " + fmtNum(win);
    } else if (cu.percent === null || cu.percent === undefined) {
      ctxTxt = "—";
    } else {
      ctxTxt = fmtPercent(cu.percent) + " / " + (win ? fmtNum(win) : "—");
    }
    var cur = null;
    (S.sessions || []).forEach(function (s) { if (s.path === S.activeSession) cur = s; });

    pop.innerHTML = "";
    var c1 = el("div", "sp-col wide");
    c1.appendChild(el("div", "sp-h", "会话信息"));
    c1.appendChild(spRow("名称", S.sessionName || (cur && cur.title) || "未命名会话"));
    c1.appendChild(spRow("会话文件", S.activeSession || st.sessionFile || "", { wrap: true, copy: true }));
    c1.appendChild(spRow("ID", (info && info.id) || st.sessionId || "", { wrap: true, copy: true }));
    c1.appendChild(spRow("活跃时长", info ? fmtDur(info.activeMs) : "…"));
    c1.appendChild(el("div", "sp-h", "项目信息"));
    c1.appendChild(spRow("项目目录", (info && info.cwd) || S.cwd || "", { wrap: true, copy: true }));

    var c2 = el("div", "sp-col");
    c2.appendChild(el("div", "sp-h", "消息"));
    c2.appendChild(spRow("用户", fmtFull(mi ? mi.user : st.userMessages)));
    c2.appendChild(spRow("助手", fmtFull(mi ? mi.assistant : st.assistantMessages)));
    c2.appendChild(spRow("工具调用", fmtFull(mi ? mi.toolCalls : st.toolCalls)));
    c2.appendChild(spRow("工具结果", fmtFull(mi ? mi.toolResults : st.toolResults)));
    c2.appendChild(spRow("总计", fmtFull(mi ? mi.total : st.totalMessages)));

    var c3 = el("div", "sp-col");
    c3.appendChild(el("div", "sp-h", "Token"));
    c3.appendChild(spRow("输入", fmtFull(t.input)));
    c3.appendChild(spRow("输出", fmtFull(t.output)));
    c3.appendChild(spRow("缓存读取", fmtFull(t.cacheRead)));
    c3.appendChild(spRow("总计", fmtFull(total)));
    c3.appendChild(spRow("上下文", ctxTxt));
    c3.appendChild(spRow("平均缓存命中率", hit === null ? "—" : hit.toFixed(1) + "%"));

    pop.appendChild(c1);
    pop.appendChild(c2);
    pop.appendChild(c3);
  }
  function openStatsPop() {
    $("stats-pop").hidden = false;
    $("meter").classList.add("open");
    // 刷用量会重设活会话，先把要查的那条路径拿住
    var path = S.activeSession;
    renderStatsPop();
    // 顺手刷一次用量，回来再重画（不然面板里的数还是上一回合的）
    refreshStats().then(function () { renderStatsPop(); });
    S.statsInfo = null;
    if (!path) return;
    send("session.info", { path: path }).then(function (r) {
      // 原生 verb 直接回数据体（send 已经把 m.data 解开了）；pi.call 才是 {success,data}
      S.statsInfo = r && r.path === path ? r : null;
      renderStatsPop();
    }).catch(function (e) { console.warn("[stats] 读会话统计失败：" + ((e && e.message) || e)); });
  }
  function closeStatsPop() {
    $("stats-pop").hidden = true;
    $("meter").classList.remove("open");
  }
  function bindStatsPop() {
    var m = $("meter"), pop = $("stats-pop");
    if (!m || !pop) return;
    m.addEventListener("click", function (e) {
      e.stopPropagation();
      if (pop.hidden) openStatsPop(); else closeStatsPop();
    });
    // 面板内部点击（含复制按钮）不关面板；点别处 / Esc 才关
    pop.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function () { if (!pop.hidden) closeStatsPop(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !pop.hidden) closeStatsPop();
    });
  }

  /* ================= 设置面板 ================= */
  /* 页签定义。照参考截图：常规=i-sliders、模型=i-cpu、技能=i-layers、
     子代理=i-bot、插件=i-plug，显式写 href 而不用 key 做图标名。 */
  var TABS = [
    { id: "general", key: "set.tab.general", label: "常规", icon: "i-sliders" },
    { id: "models", key: "set.tab.models", label: "模型", icon: "i-cpu" },
    { id: "skills", key: "set.tab.skills", label: "技能", icon: "i-layers" },
    { id: "agents", key: "set.tab.agents", label: "子代理", icon: "i-bot" },
    { id: "extensions", key: "set.tab.plugins", label: "插件", icon: "i-plug" }
  ];
  var curTab = "general";
  var SET = null;               // settings.get 的缓存
  // 加载设置前（settings.get 还没回来）的兜底默认值；3020 行会被 Rust 传来的
  // s.defaults 整体覆盖。字段与 ipc.rs 的 defaults 保持一致，否则面板会先按这里的
  // 值渲染一帧再跳变。
  var DEFAULT_SET = {
    theme: "light", uiFontSize: 13, fontFamily: "system", fontMono: "system",
    expandThinking: true, chatWidth: 870, chatFontSize: 15,
    selectionPopup: true, usePowerShell: false, language: "zh-CN", zhReply: true,
    thinkingLevel: "medium", autoCompaction: true
  };
  /// 界面缩放的基准：CSS 里 body 是 13px，uiFontSize=13 ⇒ 缩放 1.0
  var UI_FONT_BASE = 13;
  
  function openModal(tab, pick) {
    curTab = tab || curTab;
    PENDING_PICK = pick || null;
    $("modal").hidden = false;
    renderTabs();
    loadSettings().then(renderTab);
  }
  // 分页渲染完后要选中的条目名（?open=agents:explore 这类截图/验收入口用）
  var PENDING_PICK = null;
  function takePick(tab) {
    var p = PENDING_PICK;
    PENDING_PICK = null;
    return p;
  }
  function closeModal() { $("modal").hidden = true; }

  /* ---- 设置弹窗底部状态栏 ----
     插件页要在底部放「N ext · N skills · N prompts · N themes」+ 检查更新/刷新，
     其他页清空并隐藏。 */
  function setFoot(nodes) {
    var f = $("modal-foot");
    if (!f) return;
    f.innerHTML = "";
    var list = Array.prototype.slice.call(nodes || []);
    if (!list.length) { f.hidden = true; return; }
    f.hidden = false;
    list.forEach(function (n) { f.appendChild(n); });
  }

  /* ---------------- 通用表单弹窗 ---------------- */
  // 设置页里凡是需要多字段输入的地方（新增 Provider、编辑模型）都走这里。
  // 字段定义：{ key, label, value, placeholder, hint, type, options, width }
  // type: text | password | number | select | textarea | check
  function dialog(title, fields, onSubmit) {
    var back = el("div", "dlg-back");
    var box = el("div", "dlg");
    var head = el("div", "dlg-head");
    head.appendChild(el("div", "ttl", title));
    var x = el("button", "btn btn-icon", "\u2715");
    x.addEventListener("click", function () { document.body.removeChild(back); });
    head.appendChild(x);
    box.appendChild(head);
    var body = el("div", "dlg-body");
    box.appendChild(body);

    var inputs = {};
    (fields || []).forEach(function (f) {
      var wrap = el("div", "field");
      if (f.type !== "check") wrap.appendChild(el("label", "", f.label));
      if (f.hint) wrap.appendChild(el("div", "hint", f.hint));
      var inp;
      if (f.type === "select") {
        inp = el("select");
        (f.options || []).forEach(function (o) {
          var op = el("option", "", o[1]);
          op.value = o[0];
          if (String(f.value || "") === String(o[0])) op.selected = true;
          inp.appendChild(op);
        });
      } else if (f.type === "textarea") {
        inp = el("textarea");
        inp.rows = 4;
        inp.value = f.value == null ? "" : String(f.value);
      } else if (f.type === "check") {
        inp = el("input");
        inp.type = "checkbox";
        inp.checked = !!f.value;
        var lab = el("label", "dlg-check");
        lab.appendChild(inp);
        lab.appendChild(el("span", "", f.label));
        wrap.appendChild(lab);
      } else {
        inp = el("input");
        inp.type = f.type === "password" ? "password" : (f.type === "number" ? "number" : "text");
        inp.value = f.value == null ? "" : String(f.value);
        if (f.placeholder) inp.placeholder = f.placeholder;
        if (f.type === "password") inp.autocomplete = "new-password";
      }
      if (f.type !== "check") wrap.appendChild(inp);
      inputs[f.key] = inp;
      body.appendChild(wrap);
    });

    var foot = el("div", "dlg-foot");
    var cancel = el("button", "btn", "取消");
    cancel.addEventListener("click", function () { document.body.removeChild(back); });
    var ok = el("button", "btn btn-new", "确定");
    ok.addEventListener("click", function () {
      var out = {};
      (fields || []).forEach(function (f) {
        var i = inputs[f.key];
        var v = f.type === "check" ? !!i.checked : i.value;
        if (f.type === "number") v = Number(v);
        out[f.key] = v;
      });
      // 提交器返 string 表示校验失败（当错误提示用），返 falsy 表示成功并关窗
      var r = onSubmit(out);
      if (typeof r === "string" && r) {
        var old = box.querySelector(".dlg-err");
        if (old) old.remove();
        box.appendChild(el("div", "dlg-err", r));
        return;
      }
      document.body.removeChild(back);
    });
    foot.appendChild(cancel); foot.appendChild(ok);
    box.appendChild(foot);
    back.appendChild(box);
    back.addEventListener("click", function (e) { if (e.target === back) document.body.removeChild(back); });
    document.body.appendChild(back);
    var first = box.querySelector("input,select,textarea");
    if (first) first.focus();
    return back;
  }
  function renderTabs() {
    var tabs = $("modal-tabs");
    tabs.innerHTML = "";
    TABS.forEach(function (t) {
      var b = el("button", "tab" + (t.id === curTab ? " on" : ""));
      // 图标在文字左侧，尺寸/颜色靠 CSS 控制；无 href 的页签不画图标
      if (t.icon) {
        var sv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        sv.setAttribute("class", "i ti");
        var us = document.createElementNS("http://www.w3.org/2000/svg", "use");
        us.setAttribute("href", "#" + t.icon);
        sv.appendChild(us);
        b.appendChild(sv);
      }
      b.appendChild(el("span", "", t.label));
      b.addEventListener("click", function () { openModal(t.id); });
      tabs.appendChild(b);
    });
  }
  function loadSettings() {
    return send("settings.get").then(function (s) {
      SET = s;
      if (s && s.defaults) DEFAULT_SET = s.defaults;
      return s;
    });
  }

  /* ---- 设置写入：局部合并保存 + 即时应用 ----
     写完再拉一次 settings.get：set 只返回配置本体，
     get 才带 defaults/themes/languages，重拉才能保证 SET 结构完整。 */
  function saveSetting(patch, okText) {
    return send("settings.set", patch)
      .then(function () { return send("settings.get"); })
      .then(function (s) {
        SET = s;
        applySettings(s);
        if (okText !== false) toasts(okText || "已保存");
        return s;
      })
      .catch(function (e) {
        toasts("保存失败：" + e.message, "error");
        throw e;
      });
  }

  /* ---- 把配置应用到界面 ----
     主题是 CSS 变量集合，改 html[data-theme] 即可全量生效。
     字号用 CSS `zoom` 而不是 font-size：样式表里有 100 多处写死的 px 字号，
     改 font-size 只能动其中一部分（之前「聊天字体大小」就只改了正文，代码块、
     工具卡片、token 明细都不动）。zoom 是把整块连同 px 一起等比缩放，才能真正统一。
        · --ui-zoom    作用在 body 上 → 整个界面
        · --chat-zoom  作用在 .stream-inner 上 → 消息流内部全部文字
     两者相乘是预期行为：界面整体放大后，聊天再按聊天滑条额外放大。 */
  function applySettings(s) {
    if (!s) return;
    var root = document.documentElement;
    root.setAttribute("data-theme", s.theme || "light");
    var ui = Number(s.uiFontSize) || UI_FONT_BASE;
    root.style.setProperty("--ui-zoom", (ui / UI_FONT_BASE).toFixed(4));
    var chat = Number(s.chatFontSize) || DEFAULT_SET.chatFontSize;
    root.style.setProperty("--chat-font", chat + "px");
    root.style.setProperty("--chat-zoom", (chat / UI_FONT_BASE).toFixed(4));
    if (s.chatWidth) root.style.setProperty("--chat-width", s.chatWidth + "px");
    // 界面字体 / 代码字体：body 用的是 var(--font-sans)，等宽文字用 var(--font-mono)，
    // 写这两个变量就能全量换字体（界面控件、聊天正文都从 body 继承）。
    root.style.setProperty("--font-sans", fontStack(s.fontFamily));
    // 字体只有一个设置项（界面+代码合并）；fontMono 留作手动覆盖，没设就跟着 fontFamily 走。
    var monoPick = (s.fontMono && s.fontMono !== FONT_SYSTEM) ? s.fontMono : s.fontFamily;
    root.style.setProperty("--font-mono", fontStack(monoPick, "mono"));
    S.selectionPopup = s.selectionPopup !== false;
    S.toolPreset = s.toolPreset || "default";
    S.expandThinking = s.expandThinking !== false;
    S.sound = s.soundEnabled !== false;
    renderChips();
    // 缩放换了，顶栏可用宽度也变了，必须重算自适应。
    // 同步调用而不是 rAF：fitMeter 读 scrollWidth 会强制一次回流，
    // CSS 变量刚写入的 zoom 在这一次回流里就生效了；放 rAF 里反而会晚于
    // 紧随其后的 Promise 回调，导致调用方量到没自适应的状态。
    fitMeter();
    // 缩放同时改了「还剩多少宽度」：面板该不该退化成浮层、侧栏该不该收，都要重算。
    applyLayout();
  }

  /* ---- 通用控件工厂 ---- */
  function cardRow(label, hint, ctl) {
    var r = el("div", "card-row");
    var m = el("div", "cr-main");
    m.appendChild(el("div", "cr-label", label));
    if (hint) m.appendChild(el("div", "cr-hint", hint));
    r.appendChild(m);
    var c = el("div", "cr-ctl");
    if (ctl) c.appendChild(ctl);
    r.appendChild(c);
    return r;
  }
  function switchEl(on, onchange) {
    var d = el("div", "sw" + (on ? " on" : ""));
    d.addEventListener("click", function () {
      var next = !d.classList.contains("on");
      d.classList.toggle("on", next);
      onchange(next);
    });
    return d;
  }
  function resetBtn(disabled, onclick) {
    var b = el("button", "icon-btn");
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "i");
    var u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", "#i-rotate");
    svg.appendChild(u);
    b.appendChild(svg);
    b.title = "重置为默认值";
    b.disabled = !!disabled;
    if (!disabled) b.addEventListener("click", onclick);
    return b;
  }
  function sliderRow(label, hint, val, min, max, step, def, unit, onsave) {
    var wrap = el("div", "slider-wrap");
    var r = document.createElement("input");
    r.type = "range"; r.min = min; r.max = max; r.step = step; r.value = val;
    var v = el("span", "val", val + unit);
    var rb = resetBtn(val === def, function () {
      r.value = def; v.textContent = def + unit;
      rb.disabled = true;
      onsave(def);
    });
    r.addEventListener("input", function () { v.textContent = r.value + unit; });
    r.addEventListener("change", function () {
      rb.disabled = (Number(r.value) === def);
      onsave(Number(r.value));
    });
    wrap.appendChild(r); wrap.appendChild(v); wrap.appendChild(rb);
    return cardRow(label, hint, wrap);
  }
  function tileGrid(options, cur, onpick, colorOf) {
    var g = el("div", "tile-grid");
    options.forEach(function (o) {
      var id = o[0], name = o[1];
      var t = el("div", "tile" + (id === cur ? " on" : ""));
      var sw = el("div", "sw");
      if (colorOf) {
        var c = colorOf(id);
        sw.style.background = c[0];
        sw.style.borderColor = c[1] || c[0];
      }
      t.appendChild(sw);
      t.appendChild(el("div", "nm", name));
      t.addEventListener("click", function () { onpick(id); });
      g.appendChild(t);
    });
    return g;
  }
  function radioList(items, cur, onpick) {
    var box = el("div", "card");
    items.forEach(function (it) {
      var id = it[0], name = it[1];
      var r = el("div", "radio-row" + (id === cur ? " on" : ""));
      r.appendChild(el("span", "dot"));
      r.appendChild(el("span", "nm", name));
      r.appendChild(el("span", "code", id));
      r.addEventListener("click", function () { onpick(id); });
      box.appendChild(r);
    });
    return box;
  }
  function statusLine(kind, text) {
    var d = el("div", "status-line " + (kind || ""));
    var svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "i");
    var u = document.createElementNS(SVGNS, "use");
    u.setAttribute("href", kind === "ok" ? "#i-check" : (kind === "bad" ? "#i-warning" : "#i-spinner"));
    svg.appendChild(u);
    d.appendChild(svg);
    d.appendChild(el("span", "", text));
    return d;
  }
  function secTitle(t) { return el("div", "sec-title", t); }

  /* 每个主题的色板（用于设置页里的预览小方块） */
  var THEME_COLORS = {
    light: ["#ffffff", "#dcdfe4"],
    dark: ["#1e1f22", "#3a3d42"],
    mist: ["#eef4f4", "#0f7a75"],
    rose: ["#fbf1f5", "#b5386b"],
    pine: ["#202b26", "#4caf82"],
    apple: ["#f5f5f7", "#0071e3"],
    system: ["#e8eaed", "#9aa0a6"]
  };

  /* ---- 字体 ----
     候选表不硬编码：启动时向 Rust 要系统已安装的字体族（fonts.list，走
     DirectWrite——Chromium 匹配 font-family 查的就是同一份系统字体集），
     再用浏览器实测一遍「这个族名真能解析出来」，能用的排前面。

     为什么要实测：CSS 里写一个不存在的族名浏览器不会报错，只会静默回落成
     系统默认。6.2 那版硬编码表就踩过这个坑（Windows 上写 "PingFang SC"
     永远命不中，实测族名是「苹方_中等」）。 */
  var FONT_FALLBACK = "\"Segoe UI\", \"Microsoft YaHei\", system-ui, sans-serif";
  // 必须与 app.css :root 的 --font-mono 一致（那边是初始值，这里是 JS 侧副本）。
  var FONT_MONO_FALLBACK = "'JetBrains Mono', 'Fira Code', 'Consolas', ui-monospace, 'Microsoft YaHei', monospace";
  var FONT_SYSTEM = "system";                      // 「跟随系统」的哨兵值
  var FONT_PROBE_MISSING = "__pi_no_such_font__";  // 实测用的「一定不存在」族名
  /* 6.2 存的候选 id → 真实族名：老配置升级后字体不会突然变回系统默认。 */
  var FONT_LEGACY = {
    pingfang: "苹方_中等",
    harmony: "HarmonyOS Sans SC",
    misans: "MiSans",
    oppo: "OPPO Sans 4.0",
    source: "思源黑体 CN",
    yahei: "Microsoft YaHei UI"
  };
  var FONT_LIST = null;       // [{name, ok}]，ok=false 表示浏览器实测解析不出
  var FONT_LOADING = null;

  /* 实测族名能否解析：同一串字量宽度，跟「一定不存在的族名」比，宽度不同说明
     拿到了真字形。monospace 和 sans-serif 各比一次：候选本身就是等宽字体时，
     它和 monospace 兜底的宽度可能恰好一样，只比一次会误判成不存在。 */
  var _fontProbe = null;
  function measureFontWidth(stack) {
    if (!_fontProbe) {
      _fontProbe = el("span", "font-probe");
      _fontProbe.setAttribute("aria-hidden", "true");
      _fontProbe.textContent = "汉汉字字WWWWiiii0123";
      document.body.appendChild(_fontProbe);
    }
    _fontProbe.style.fontFamily = stack;
    return _fontProbe.getBoundingClientRect().width;
  }
  function fontResolves(name) {
    var n = String(name == null ? "" : name).replace(/"/g, "");
    if (!n) return false;
    var probes = ["monospace", "sans-serif"];
    for (var i = 0; i < probes.length; i++) {
      var base = measureFontWidth("\"" + FONT_PROBE_MISSING + "\", " + probes[i]);
      var test = measureFontWidth("\"" + n + "\", " + probes[i]);
      if (Math.abs(test - base) > 0.01) return true;
    }
    return false;
  }

  /* 系统字体清单，一次会话只取一次（loadFonts 会被界面/代码两个选择器共用）。 */
  function loadFonts() {
    if (FONT_LIST) return Promise.resolve(FONT_LIST);
    if (FONT_LOADING) return FONT_LOADING;
    FONT_LOADING = send("fonts.list").then(function (r) {
      var fams = (r && r.families) || [];
      var ok = [], bad = [];
      for (var i = 0; i < fams.length; i++) {
        if (fontResolves(fams[i])) ok.push({ name: fams[i], ok: true });
        else bad.push({ name: fams[i], ok: false });
      }
      FONT_LIST = ok.concat(bad);
      FONT_LOADING = null;
      return FONT_LIST;
    }, function (e) {
      FONT_LOADING = null;
      throw e;
    });
    return FONT_LOADING;
  }

  /* 存的是 `system` 或字体族名；也兼容一整串 font-family 栈和 6.2 的老 id。
     kind="mono" 时兜底栈换成等宽。 */
  function fontStack(v, kind) {
    var fallback = kind === "mono" ? FONT_MONO_FALLBACK : FONT_FALLBACK;
    var s = String(v == null ? "" : v).trim();
    if (!s || s === FONT_SYSTEM) return fallback;
    if (FONT_LEGACY[s]) s = FONT_LEGACY[s];
    if (s.charAt(0) === "\"" || s.indexOf(",") >= 0) return s;
    return "\"" + s.replace(/"/g, "") + "\", " + fallback;
  }
  function fontLabel(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s || s === FONT_SYSTEM) return "跟随系统";
    return FONT_LEGACY[s] || s;
  }

  /* 字体下拉框：一个控件同时管界面与代码（用户要求把「界面字体/代码字体」合并）。
     候选来自系统实际安装的字体族（fonts.list → DirectWrite），不再硬编码；
     浏览器实测解析不出的族名标「实测不可用」——写进 CSS 也不会生效。 */
  function fontSelect(cur, onpick) {
    var box = el("div", "font-box");
    var sel = el("select", "font-sel");
    var prev = el("div", "font-prev");
    var prevLine = el("div", "fp-line",
      "字体预览 Aa 汉字 0123 —— 侧栏 / 标题 / 聊天正文 / 代码块");
    var prevNote = el("small", "", "");
    prev.appendChild(prevLine);
    prev.appendChild(prevNote);
    box.appendChild(sel);
    box.appendChild(prev);

    var chosen = String(cur == null ? "" : cur).trim() || FONT_SYSTEM;
    if (FONT_LEGACY[chosen]) chosen = FONT_LEGACY[chosen];
    var byValue = {};

    function applyPreview(v) {
      var stack = fontStack(v);
      prev.style.fontFamily = stack;
      prev.setAttribute("data-stack", stack);
      prevNote.textContent = "当前：" + fontLabel(v) +
        (v === FONT_SYSTEM ? "" : "（实际栈 " + stack.split(",")[0].replace(/"/g, "") + "）");
    }
    function addOption(value, label, bad) {
      var op = document.createElement("option");
      op.value = value;
      op.textContent = label + (bad ? "（实测不可用）" : "");
      if (bad) op.className = "bad";
      sel.appendChild(op);
      byValue[value] = op;
    }
    sel.addEventListener("change", function () {
      chosen = sel.value;
      applyPreview(chosen);
      if (onpick) onpick(chosen);
    });

    addOption(FONT_SYSTEM, "跟随系统（默认）", false);
    var loading = document.createElement("option");
    loading.value = "";
    loading.textContent = "正在读取系统字体…";
    sel.appendChild(loading);
    applyPreview(chosen);
    loadFonts().then(function (all) {
      loading.remove();
      for (var i = 0; i < all.length; i++) addOption(all[i].name, all[i].name, !all[i].ok);
      sel.value = byValue[chosen] ? chosen : FONT_SYSTEM;
      applyPreview(sel.value);
    }, function (e) {
      loading.textContent = "读取系统字体失败：" + e;
    });
    return box;
  }

  function renderTab() {
    var body = $("modal-body");
    body.innerHTML = "";
    body.classList.toggle("plain", curTab !== "models" && curTab !== "skills" && curTab !== "agents" && curTab !== "extensions");
    setFoot([]);
    if (!SET) { body.appendChild(el("div", "hint-box", "正在读取设置…")); return; }
    if (curTab === "general") renderGeneral(body);
    else if (curTab === "models") renderModels(body);
    else if (curTab === "skills") renderSkills(body);
    else if (curTab === "agents") renderAgents(body);
    else renderExtensions(body);
  }

  /* ---------------- 分页 1：常规 ---------------- */
  function renderGeneral(body) {
    var s = SET;
    body.appendChild(secTitle("外观"));
    body.appendChild(tileGrid(s.themes || [], s.theme, function (id) {
      saveSetting({ theme: id }).then(function () { renderTab(); });
    }, function (id) { return THEME_COLORS[id] || ["#eee", "#ccc"]; }));
    var uiCard = el("div", "card");
    uiCard.appendChild(sliderRow("界面字体大小", "侧栏、顶栏、设置面板等整个界面的字号；13 为默认",
      s.uiFontSize, 11, 24, 1, DEFAULT_SET.uiFontSize, "px",
      function (v) { saveSetting({ uiFontSize: v }); }));
    /* 字体候选来自系统（fonts.list → DirectWrite），不再硬编码；一个下拉框同时
       管界面与代码（用户要求合并），改完界面 / 聊天正文 / 代码块一起变。 */
    uiCard.appendChild(cardRow("字体",
      "候选是本机已安装的全部字体族；标了「实测不可用」的写进 CSS 也不会生效。界面、聊天正文、代码块一起跟着变",
      fontSelect(s.fontFamily, function (v) { saveSetting({ fontFamily: v }); })));
    body.appendChild(uiCard);

    body.appendChild(secTitle("对话"));
    var c = el("div", "card");
    c.appendChild(cardRow("默认展开思考块", "助手输出的思考内容默认展开显示",
      switchEl(s.expandThinking, function (on) { saveSetting({ expandThinking: on }); })));
    c.appendChild(cardRow("思考与回答用中文",
      "启动 pi 时追加一段系统提示，要求模型用中文思考、用中文回答；改完会重启 pi 进程。已经产生的英文思考改不了",
      switchEl(s.zhReply !== false, function (on) {
        saveSetting({ zhReply: on }, "已保存，重启 pi 后生效")
          .then(function () { return send("pi.restart"); })
          .catch(function (e) { void e; });
      })));
    c.appendChild(sliderRow("聊天内容宽度", "消息区的最大宽度", s.chatWidth, 600, 1600, 10,
      DEFAULT_SET.chatWidth, "px", function (v) { saveSetting({ chatWidth: v }); }));
    c.appendChild(sliderRow("聊天字体大小", "消息流里的全部文字：正文、代码块、工具卡片、token 明细一起缩放",
      s.chatFontSize, 11, 24, 1, DEFAULT_SET.chatFontSize, "px",
      function (v) { saveSetting({ chatFontSize: v }); }));
    c.appendChild(cardRow("选中文字时显示提问浮窗", "选中回答里的文字后弹出「就此提问」按钮",
      switchEl(s.selectionPopup, function (on) { saveSetting({ selectionPopup: on }); })));
    body.appendChild(c);

    body.appendChild(secTitle("Shell 工具"));
    body.appendChild(el("div", "hint", "选择模型执行命令时使用的 Shell。直接输入的 ! 和 !! 命令仍使用 Bash。"));
    var sh = el("div", "card");
    sh.appendChild(cardRow("使用 PowerShell 替代 Bash", "关闭时使用 Bash（Git Bash / WSL 提供的 sh）",
      switchEl(s.usePowerShell, function (on) { saveSetting({ usePowerShell: on }); })));
    body.appendChild(sh);

    body.appendChild(secTitle("Pi Agent 路径"));
    body.appendChild(el("div", "hint", "Pi agent 可执行文件的路径。留空则使用系统 PATH 里的 pi。"));
    var piCard = el("div", "card");
    var piInput = el("input");
    piInput.type = "text";
    piInput.value = s.piBin || "";
    piInput.placeholder = "例如 C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd";
    var savePi = el("button", "btn", "保存");
    savePi.addEventListener("click", function () {
      saveSetting({ piBin: piInput.value }).then(function () {
        send("settings.get").then(function (ns) { SET = ns; renderTab(); });
      });
    });
    var piCtl = el("div", "row");
    piCtl.style.width = "100%";
    piInput.style.flex = "1";
    piCtl.appendChild(piInput); piCtl.appendChild(savePi);
    piCard.appendChild(cardRow("可执行文件路径", "", piCtl));
    var autoBtn = el("button", "btn", "自动检测");
    autoBtn.addEventListener("click", function () {
      autoBtn.disabled = true;
      send("settings.detectPi").then(function (r) {
        if (r.found) {
          piInput.value = r.path;
          toasts("已找到：" + r.path);
        } else {
          toasts("未找到 pi，请手动填写路径", "warn");
        }
      }).catch(function (e) { toasts(e.message, "error"); })
        .then(function () { autoBtn.disabled = false; });
    });
    var piCur = el("div");
    piCur.appendChild(autoBtn);
    piCur.appendChild(statusLine("", "当前生效: " + (s.piBinResolved || "pi")));
    piCard.appendChild(cardRow("", "检测本机已安装的 pi 位置", piCur));
    body.appendChild(piCard);

    body.appendChild(secTitle("语言"));
    body.appendChild(radioList(s.languages || [["zh-CN", "简体中文"]], s.language, function (id) {
      saveSetting({ language: id }).then(function () { renderTab(); });
    }));
  }

  /* ---------------- 分页 2：模型 ----------------
     布局对齐 pi-web 的 ModelsConfig（components/ModelsConfig.tsx）：

     左栏 = 自定义 Provider 列表
            ├ 齿轮行 = Provider 名 → 右栏显示 Provider 详情
            ├ 缩进行 = 模型 id（reasoning 为真时右侧带 T 角标）→ 右栏显示模型详情
            └ 「+ 模型」→ 追加一个空模型并选中
            底部「+ 添加 Provider」→ 右栏换成 Provider 选择器
            （自定义 / 订阅服务 / API KEY 三组，每张卡片一个 Provider）

     右栏 = Provider 详情（PROVIDER / Provider 名称 / Base URL / API Key / API /
            Headers / 导入模型…）或模型详情（ID·Name / 填入模型信息 / 能力 /
            模型规格 / 高级设置：API 覆盖 / Headers / 兼容性 / 思考等级映射）

     底部 = 「保存」把整份配置写回 ~/.pi/agent/models.json 并让 pi 重载。

     真源就是 models.json —— 这一页改什么，pi 就用什么。 */
  var MD_API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
  var MD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  var MD_LEVEL_COLORS = {
    off: "#9aa0a6", minimal: "#6b7280", low: "#60a5fa", medium: "#a78bfa",
    high: "#f472b6", xhigh: "#fb923c", max: "#ef4444"
  };

  /* pi 的 provider-composer.js 里 applyModelsJson 有硬校验：
     - 空字符串不算「有内容」（`!config.apiKey` 对 "" 也为真），必须在写盘前剔掉；
     - baseUrl 用 `??` 合并，"" 不会回退到内建值，会直接把请求打到空地址；
     - 一个 Provider 必须有 baseUrl / headers / compat / modelOverrides / 非空 models /
       非空 apiKey / oauth / authHeader 之一，都没有就直接抛错，整个 pi 起不来；
     - 只有 models 且 model.id 为空也无法匹配，同样要剔。
     所以保存前统一过一遍：去空串、去空 models、只剩空壳的 Provider 整条丢掉。
     放在模块级是为了让自检能直接单测它。 */
  function sanitizeModelsConfig(raw) {
    var out = { providers: {} };
    var dropped = [];
    var src = (raw && raw.providers) || {};
    Object.keys(src).forEach(function (k) {
      var p = JSON.parse(JSON.stringify(src[k] || {}));
      Object.keys(p).forEach(function (f) {
        if (p[f] === "" || p[f] === null || p[f] === undefined) delete p[f];
      });
      if (Array.isArray(p.models)) {
        p.models = p.models.filter(function (m) { return m && String(m.id || "").trim() !== ""; });
        p.models.forEach(function (m) {
          Object.keys(m).forEach(function (f) {
            if (m[f] === "" || m[f] === undefined) delete m[f];
          });
          if (m.cost && !Object.keys(m.cost).length) delete m.cost;
          if (m.compat && !Object.keys(m.compat).length) delete m.compat;
          if (m.thinkingLevelMap && !Object.keys(m.thinkingLevelMap).length) delete m.thinkingLevelMap;
        });
        if (!p.models.length) delete p.models;
      }
      var has = !!(p.baseUrl || p.headers || p.compat || p.oauth || p.authHeader ||
        (p.models && p.models.length) || p.apiKey ||
        (p.modelOverrides && Object.keys(p.modelOverrides).length));
      if (!has) { dropped.push(k); return; }
      out.providers[k] = p;
    });
    return { config: out, dropped: dropped };
  }

  function renderModels(body) {
    var wrap = el("div", "split");
    var left = el("div", "split-left");
    var right = el("div", "split-right md-right");
    wrap.appendChild(left); wrap.appendChild(right);
    body.appendChild(wrap);

    var cfg = { providers: {} };   // models.json 的内容（真源）
    var sel = null;                // { type:"provider"|"model", name, index }
    var cat = null;                // 内建 Provider 目录（异步填）
    var catErr = "";               // 目录读取失败原因（降级提示）
    var picker = false;            // 右栏是否处于「添加 Provider」选择器
    var dirty = false;
    var advOpen = true;            // 高级设置默认展开（截图即展开态）
    var costOpen = false;          // 「编辑价格」展开态
    var disc = null;               // 导入模型的结果 { phase, models, error, url, query, picked, added }

    /* ---------- 底部：保存 ---------- */
    function foot() {
      var sp = el("div", "foot-stat", dirty ? "有未保存的改动" : "");
      var b = el("button", "md-save", "保存");
      b.addEventListener("click", doSave);
      setFoot([sp, b]);
    }
    function doSave() {
      var res = sanitizeModelsConfig(cfg);
      if (res.dropped.length) {
        toasts("已跳过 " + res.dropped.length + " 个空条目（" + res.dropped.slice(0, 2).join("、") +
          "）：pi 要求 Provider 至少要有 baseUrl / headers / compat / apiKey / models 之一", "warn");
      }
      send("models.write", { config: res.config }).then(function (r) {
        cfg = res.config;
        dirty = false; foot();
        toasts("已保存" + (r && r.reloaded ? " · pi 已重载模型" : ""));
      }).catch(function (e) { toasts(e.message, "error"); });
    }

    function touch() { dirty = true; foot(); }

    function prov(name) { return cfg.providers[name] || {}; }
    // 选中一个还没落盘的 Provider（刚在弹窗里挑的内建项）时，需要先把它实体化才能写入字段。
    // 空壳本身不脏——保存前 sanitize() 会把没内容的条目干掉。
    function ensureProv(name) {
      if (!cfg.providers[name]) cfg.providers[name] = {};
      return cfg.providers[name];
    }
    function modelsOf(name) {
      var p = prov(name);
      return Array.isArray(p.models) ? p.models : [];
    }
    // 与 sanitize() 的判据保持一致：有任意一项算数就算是有效条目
    function providerHasContent(p) {
      return !!(p.baseUrl || p.headers || p.compat || p.oauth || p.authHeader || p.apiKey ||
        (Array.isArray(p.models) && p.models.some(function (m) { return m && String(m.id || "").trim(); })) ||
        (p.modelOverrides && Object.keys(p.modelOverrides).length));
    }

    /* ---------- 右栏公共小件 ---------- */
    function fld(label, ctl, hint) {
      var d = el("div", "md-fld");
      if (label) d.appendChild(el("label", "", label));
      d.appendChild(ctl);
      if (hint) d.appendChild(el("div", "md-fhint", hint));
      return d;
    }
    function inp(value, placeholder, mono) {
      var i = el("input", "md-in" + (mono ? " mono" : ""));
      i.type = "text";
      i.value = value == null ? "" : String(value);
      if (placeholder) i.placeholder = placeholder;
      return i;
    }
    function numInp(value, placeholder) {
      var i = el("input", "md-in mono");
      i.type = "number";
      i.value = value == null ? "" : String(value);
      if (placeholder) i.placeholder = placeholder;
      return i;
    }
    function selInp(value, options) {
      var s = el("select", "md-in");
      options.forEach(function (o) {
        var op = el("option", "", o[1]);
        op.value = o[0];
        if (o[0] === value) op.selected = true;
        s.appendChild(op);
      });
      return s;
    }
    function chk(label, checked, onchange) {
      var w = el("label", "md-chk");
      var c = el("input");
      c.type = "checkbox";
      c.checked = !!checked;
      c.addEventListener("change", function () { onchange(c.checked); });
      w.appendChild(c);
      w.appendChild(el("span", "", label));
      return w;
    }

    /* ---------- 左栏 ---------- */
    function renderLeft() {
      left.innerHTML = "";
      var ls = el("div", "split-list");
      var names = Object.keys(cfg.providers);
      names.forEach(function (p) {
        var isP = sel && sel.type === "provider" && sel.name === p;
        var row = el("div", "li md-pv" + (isP ? " on" : ""));
        row.appendChild(iconEl("md-gear", "i-settings"));
        row.appendChild(el("span", "nm", p));
        row.addEventListener("click", function () {
          picker = false; disc = null;
          sel = { type: "provider", name: p };
          renderAll();
        });
        ls.appendChild(row);

        modelsOf(p).forEach(function (m, i) {
          var isM = sel && sel.type === "model" && sel.name === p && sel.index === i;
          var mr = el("div", "li md-md" + (isM ? " on" : ""));
          mr.appendChild(el("span", "nm", m.id || "新模型"));
          if (m.reasoning) mr.appendChild(el("span", "md-t", "T"));
          mr.addEventListener("click", function () {
            picker = false; disc = null;
            sel = { type: "model", name: p, index: i };
            renderAll();
          });
          ls.appendChild(mr);
        });

        var ar = el("div", "li md-md md-add");
        ar.appendChild(el("span", "nm", "+ 模型"));
        ar.addEventListener("click", function (ev) {
          ev.stopPropagation();
          var arr = cfg.providers[p].models = cfg.providers[p].models || [];
          arr.push({ id: "", name: "", contextWindow: 128000, maxTokens: 16384 });
          picker = false; disc = null;
          sel = { type: "model", name: p, index: arr.length - 1 };
          touch(); renderAll();
        });
        ls.appendChild(ar);
      });
      if (!names.length) ls.appendChild(el("div", "empty", "还没有配置任何 Provider"));
      left.appendChild(ls);

      var ft = el("div", "split-foot");
      var addb = el("button", "split-add", "+ 添加 Provider");
      addb.addEventListener("click", function () {
        picker = true; disc = null;
        renderRight();
      });
      ft.appendChild(addb);
      left.appendChild(ft);
    }

    /* ---------- 右栏：模型详情 ---------- */
    function renderModelDetail(name, index) {
      var arr = cfg.providers[name].models;
      var m = arr[index];
      if (!m) {
        sel = { type: "provider", name: name };
        return renderProviderDetail(name);
      }
      right.innerHTML = "";

      var head = el("div", "md-head");
      head.appendChild(el("div", "md-h", "模型"));
      var sp = el("div", "md-spacer");
      head.appendChild(sp);
      var tbtn = el("button", "md-btn", "测试");
      tbtn.addEventListener("click", function () {
        if (!String(m.id || "").trim()) return;
        tbtn.disabled = true; tbtn.textContent = "测试中…";
        var t0 = Date.now();
        send("models.test", { provider: name, model: m.id }).then(function (r) {
          tbtn.disabled = false; tbtn.textContent = "测试";
          var old = right.querySelector(".status-line");
          if (old) old.remove();
          head.after(statusLine("ok", "连通 " + (Date.now() - t0) + "ms · " + ((r && r.model) || m.id)));
        }).catch(function (e) {
          tbtn.disabled = false; tbtn.textContent = "测试";
          toasts(e.message, "error");
        });
      });
      var rmbtn = el("button", "md-btn md-danger", "移除");
      rmbtn.addEventListener("click", function () {
        if (!confirm("移除模型「" + (m.id || "新模型") + "」？")) return;
        arr.splice(index, 1);
        sel = { type: "provider", name: name };
        touch(); renderAll();
      });
      head.appendChild(tbtn); head.appendChild(rmbtn);
      right.appendChild(head);

      var g = el("div", "md-grid2");
      var idIn = inp(m.id, "model-id", true);
      idIn.addEventListener("input", function () { m.id = idIn.value; touch(); renderLeftSoon(); });
      var nmIn = inp(m.name, "显示名称");
      nmIn.addEventListener("input", function () { m.name = nmIn.value; touch(); });
      g.appendChild(fld("ID *", idIn));
      g.appendChild(fld("名称", nmIn));
      right.appendChild(g);

      if (!String(m.id || "").trim()) {
        right.appendChild(el("div", "md-emptynote",
          "ID 还是空的，保存时这个模型会被跳过——pi 靠 ID 匹配模型，空 ID 无法写入。"));
      }

      // 「填入模型信息」+ 来源
      var fillRow = el("div", "md-rowline md-fillrow");
      var fbtn = el("button", "md-btn", "填入模型信息");
      fbtn.disabled = !String(m.id || "").trim();
      fbtn.addEventListener("click", function () {
        var pid = MdCatalog.builtinIdFor(name);
        if (!pid) { toasts("「" + name + "」不是内建 Provider，无法按模型名自动填表", "warn"); return; }
        fbtn.disabled = true; fbtn.textContent = "读取中…";
        send("models.catalogModels", { id: pid }).then(function (r) {
          fbtn.disabled = false; fbtn.textContent = "填入模型信息";
          var hit = ((r && r.provider && r.provider.models) || []).filter(function (x) { return x.id === m.id; })[0];
          if (!hit) { toasts("内建目录里没有模型「" + m.id + "」", "warn"); return; }
          ["name", "contextWindow", "maxTokens", "reasoning", "input", "cost", "compat", "thinkingLevelMap", "api"]
            .forEach(function (k) { if (hit[k] !== undefined) m[k] = hit[k]; });
          touch(); renderAll();
          toasts("已按内建目录填入 " + m.id);
        }).catch(function (e) {
          fbtn.disabled = false; fbtn.textContent = "填入模型信息";
          toasts(e.message, "error");
        });
      });
      fillRow.appendChild(fbtn);
      var src = el("span", "md-srcline", "来源：models.dev");
      src.title = "取自本机 pi 自带的内建模型目录（与 models.dev 同源，随 pi 升级更新）";
      fillRow.appendChild(src);
      right.appendChild(fillRow);

      // 能力
      right.appendChild(el("div", "md-sec", "能力"));
      var caps = el("div", "md-chkrow");
      caps.appendChild(chk("推理 / 思考", m.reasoning, function (v) {
        if (v) m.reasoning = true; else delete m.reasoning;
        touch(); renderAll();
      }));
      caps.appendChild(chk("图片输入", Array.isArray(m.input) && m.input.indexOf("image") >= 0, function (v) {
        if (v) m.input = ["text", "image"]; else delete m.input;
        touch(); renderLeftSoon();
      }));
      right.appendChild(caps);

      // 模型规格
      var specHead = el("div", "md-sechead");
      specHead.appendChild(el("div", "md-sec", "模型规格"));
      var costBtn = el("button", "md-link", costOpen ? "完成编辑价格" : "编辑价格");
      costBtn.addEventListener("click", function () { costOpen = !costOpen; renderRight(); });
      specHead.appendChild(costBtn);
      right.appendChild(specHead);

      var sg = el("div", "md-grid2");
      var cw = numInp(m.contextWindow, "128000");
      cw.addEventListener("input", function () {
        if (cw.value === "") delete m.contextWindow; else m.contextWindow = Number(cw.value);
        touch();
      });
      var mt = numInp(m.maxTokens, "16384");
      mt.addEventListener("input", function () {
        if (mt.value === "") delete m.maxTokens; else m.maxTokens = Number(mt.value);
        touch();
      });
      sg.appendChild(fld("上下文窗口 (tokens)", cw));
      sg.appendChild(fld("最大输出 tokens", mt));
      right.appendChild(sg);

      var MD_COST = [["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读取"], ["cacheWrite", "缓存写入"]];
      var cost = m.cost || {};
      var costBox = el("div", "md-cost");
      costBox.appendChild(el("div", "md-costttl", "每百万 TOKENS 价格"));
      var cg = el("div", "md-costgrid");
      MD_COST.forEach(function (c) {
        var cell = el("div", "md-costcell");
        cell.appendChild(el("div", "md-costlabel", c[1]));
        if (costOpen) {
          var ci = numInp(cost[c[0]], "0");
          ci.addEventListener("input", function () {
            var v = ci.value === "" ? undefined : Number(ci.value);
            m.cost = m.cost || {};
            if (v === undefined) delete m.cost[c[0]]; else m.cost[c[0]] = v;
            if (!Object.keys(m.cost).length) delete m.cost;
            touch();
          });
          cell.appendChild(ci);
        } else {
          var v = cost[c[0]];
          cell.appendChild(el("div", "md-costval" + (v === undefined ? " miss" : ""),
            v === undefined ? "未提供" : String(v)));
        }
        cg.appendChild(cell);
      });
      costBox.appendChild(cg);
      right.appendChild(costBox);

      // 高级设置
      var adv = el("div", "md-adv");
      var ah = el("div", "md-sechead md-advhead");
      var ahL = el("div", "md-advttl");
      ahL.appendChild(el("div", "md-sec", "高级设置"));
      ahL.appendChild(el("div", "md-advsub", advSummary(m)));
      ah.appendChild(ahL);
      ah.appendChild(iconEl("md-caret" + (advOpen ? "" : " closed"), "i-chevron-down"));
      ah.addEventListener("click", function () { advOpen = !advOpen; renderRight(); });
      adv.appendChild(ah);
      if (advOpen) {
        var ab = el("div", "md-advbody");
        ab.appendChild(fld("API 覆盖", (function () {
          var s = selInp(m.api || "", [["", "— 默认 / none —"]].concat(
            MD_API_OPTIONS.map(function (o) { return [o, o]; })));
          s.addEventListener("change", function () {
            if (s.value) m.api = s.value; else delete m.api;
            touch(); renderRight();
          });
          return s;
        })()));
        ab.appendChild(fld("请求头", headerEditor(m, "model"), "仅添加到该模型的请求中，并覆盖服务商的同名请求头。"));

        if (m.reasoning) {
          ab.appendChild(el("div", "md-sec md-sec-gap", "兼容性"));
          var compat = m.compat || {};
          ab.appendChild(chk("DeepSeek 思考兼容", compat.requiresReasoningContentOnAssistantMessages === true,
            function (v) { setCompat(m, "requiresReasoningContentOnAssistantMessages", v); touch(); renderRight(); }));
          ab.appendChild(chk("使用 developer 角色传递系统提示词", compat.supportsDeveloperRole !== false,
            function (v) { setCompat(m, "supportsDeveloperRole", v); touch(); renderRight(); }));

          var lmHead = el("div", "md-sechead md-sechead-gap");
          lmHead.appendChild(el("div", "md-sec", "思考等级映射"));
          if (m.thinkingLevelMap) {
            var clr = el("button", "md-link md-linkdim", "全部清除");
            clr.addEventListener("click", function () { delete m.thinkingLevelMap; touch(); renderRight(); });
            lmHead.appendChild(clr);
          }
          ab.appendChild(lmHead);
          ab.appendChild(levelMapEditor(m));
        }
        adv.appendChild(ab);
      }
      right.appendChild(adv);
    }

    function advSummary(m) {
      var bits = [];
      if (m.api) bits.push("API " + m.api);
      var hn = m.headers ? Object.keys(m.headers).length : 0;
      if (hn) bits.push("请求头 " + hn + " 条");
      var cn = m.compat ? Object.keys(m.compat).length : 0;
      if (cn) bits.push("兼容性 " + cn + " 项");
      var ln = m.thinkingLevelMap ? Object.keys(m.thinkingLevelMap).length : 0;
      if (ln) bits.push("思考等级映射 " + ln + " 级");
      return bits.length ? bits.join(" · ") : "沿用 Provider 默认设置";
    }

    function setCompat(m, key, v) {
      m.compat = m.compat || {};
      if (key === "supportsDeveloperRole") {
        if (v) delete m.compat[key]; else m.compat[key] = false;
      } else if (v) {
        m.compat[key] = true;
      } else {
        delete m.compat[key];
      }
      if (!Object.keys(m.compat).length) delete m.compat;
    }

    /* ---------- Headers 编辑器（对象 {名: 值}） ---------- */
    function headerEditor(owner, scope) {
      var box = el("div", "md-hdrs");
      var h = owner.headers = owner.headers || {};
      Object.keys(h).forEach(function (k) {
        var row = el("div", "md-hdrrow");
        var kn = inp(k, "Header-Name", true);
        kn.addEventListener("change", function () {
          var nv = kn.value.trim();
          if (!nv || nv === k) { kn.value = k; return; }
          var v = h[k];
          delete h[k]; h[nv] = v;
          touch(); renderRight();
        });
        var vn = inp(h[k], "value", true);
        vn.addEventListener("input", function () { h[k] = vn.value; touch(); });
        var x = el("button", "md-hdrx");
        x.appendChild(icon("i-x"));
        x.addEventListener("click", function () {
          delete h[k];
          if (!Object.keys(h).length) delete owner.headers;
          touch(); renderRight();
        });
        row.appendChild(kn); row.appendChild(vn); row.appendChild(x);
        box.appendChild(row);
      });
      var add = el("button", "md-btn md-addhdr", "+ 添加请求头");
      add.addEventListener("click", function () {
        var n = 1, k = "Header-Name";
        while (owner.headers && owner.headers[k]) { k = "Header-Name-" + (++n); }
        owner.headers = owner.headers || {};
        owner.headers[k] = "";
        touch(); renderRight();
      });
      box.appendChild(add);
      return box;
    }

    /* ---------- 思考等级映射 ---------- */
    function levelMapEditor(m) {
      var box = el("div", "md-lvls");
      var map = m.thinkingLevelMap || {};
      MD_THINKING_LEVELS.forEach(function (lv) {
        var inMap = Object.prototype.hasOwnProperty.call(map, lv);
        var raw = map[lv];
        var state = !inMap ? "omit" : (raw === null ? "null" : "string");
        var str = typeof raw === "string" ? raw : "";

        var row = el("div", "md-lvl");
        var nameCell = el("div", "md-lvlname");
        var dot = el("span", "md-lvldot");
        dot.style.background = MD_LEVEL_COLORS[lv];
        if (state === "null") dot.style.opacity = ".3";
        nameCell.appendChild(dot);
        var nm = el("span", "md-lvltxt" + (state === "null" ? " off" : ""), lv);
        nameCell.appendChild(nm);
        row.appendChild(nameCell);

        function setLv(entry) {
          m.thinkingLevelMap = m.thinkingLevelMap || {};
          if (entry === "omit") delete m.thinkingLevelMap[lv];
          else m.thinkingLevelMap[lv] = entry;
          if (!Object.keys(m.thinkingLevelMap).length) delete m.thinkingLevelMap;
          touch(); renderRight();
        }

        var seg1 = el("div", "md-seg");
        var bDef = el("button", "md-segb" + (state === "omit" ? " on" : ""), "默认");
        bDef.addEventListener("click", function () { setLv("omit"); });
        var bDis = el("button", "md-segb" + (state === "null" ? " on danger" : ""), "禁用");
        bDis.addEventListener("click", function () { setLv(null); });
        seg1.appendChild(bDef); seg1.appendChild(bDis);
        row.appendChild(seg1);

        var seg2 = el("div", "md-seg md-seg-custom" + (state === "string" ? " on" : ""));
        var bCus = el("button", "md-segb" + (state === "string" ? " on" : ""), "自定义");
        bCus.addEventListener("click", function () { setLv(str || lv); });
        var tin = el("input", "md-segin");
        tin.value = str;
        tin.placeholder = lv;
        tin.addEventListener("input", function () {
          m.thinkingLevelMap = m.thinkingLevelMap || {};
          m.thinkingLevelMap[lv] = tin.value;
          touch();
        });
        seg2.appendChild(bCus); seg2.appendChild(tin);
        row.appendChild(seg2);

        box.appendChild(row);
      });
      return box;
    }

    /* ---------- 右栏：Provider 详情 ---------- */
    function renderProviderDetail(name) {
      var p = ensureProv(name);
      right.innerHTML = "";
      // 这里不能动 disc：renderRight() 每次重画都会走到这，一置 null 就等于
      // 「导入模型」永远看不到结果（点了没反应就是这么来的）。切 Provider / 切模型
      // 的重置已经在左栏各个点击处理里做了。

      var head = el("div", "md-head");
      head.appendChild(el("div", "md-hlbl", "服务商"));
      head.appendChild(el("div", "md-spacer"));
      var del = el("button", "md-btn md-danger", "删除");
      del.addEventListener("click", function () {
        if (!confirm("删除 Provider「" + name + "」及其 " + modelsOf(name).length + " 个模型？")) return;
        delete cfg.providers[name];
        sel = null;
        touch(); renderAll();
      });
      head.appendChild(del);
      right.appendChild(head);

      var nameIn = inp(name, "provider-name", true);
      nameIn.addEventListener("change", function () {
        var nid = nameIn.value.trim();
        if (!nid || nid === name) { nameIn.value = name; return; }
        if (cfg.providers[nid]) { toasts("已存在同名 Provider", "error"); nameIn.value = name; return; }
        var moved = {};
        Object.keys(cfg.providers).forEach(function (k) { moved[k === name ? nid : k] = cfg.providers[k]; });
        cfg.providers = moved;
        sel = { type: "provider", name: nid };
        touch(); renderAll();
      });
      right.appendChild(fld("服务商名称", nameIn));

      // pi 不接受空壳条目（provider-composer.js 的 applyModelsJson 会直接抛错），
      // 所以这里提前告知：现在保存会被跳过。
      if (!providerHasContent(p)) {
        right.appendChild(el("div", "md-emptynote",
          "这个 Provider 目前还没有 baseUrl / API Key / Headers / 模型，保存时会被跳过——" +
          "pi 不接只声明名字的空条目。"));
      }

      var baseIn = inp(p.baseUrl || p.base_url || "", "https://api.example.com/v1", true);
      baseIn.addEventListener("input", function () {
        if (baseIn.value) p.baseUrl = baseIn.value; else delete p.baseUrl;
        delete p.base_url;
        touch();
      });
      right.appendChild(fld("接口地址", baseIn));

      var keyIn = el("input", "md-in mono md-key");
      keyIn.type = "password";
      keyIn.value = String(p.apiKey || p.api_key || "");
      keyIn.placeholder = "环境变量名、!shell 命令，或直接填密钥文本";
      keyIn.addEventListener("input", function () {
        if (keyIn.value) p.apiKey = keyIn.value; else delete p.apiKey;
        delete p.api_key;
        touch();
      });
      var keyWrap = el("div", "md-keywrap");
      keyWrap.appendChild(keyIn);
      var eye = el("button", "md-eye");
      eye.appendChild(icon("i-search"));
      eye.title = "显示 / 隐藏";
      eye.addEventListener("click", function () {
        keyIn.type = keyIn.type === "password" ? "text" : "password";
      });
      keyWrap.appendChild(eye);
      right.appendChild(fld("API 密钥", keyWrap,
        "以 ! 开头会当作 shell 命令执行；也可以直接填环境变量名。"));

      var apiSel = selInp(p.api || "openai-completions", MD_API_OPTIONS.map(function (o) { return [o, o]; }));
      apiSel.addEventListener("change", function () { p.api = apiSel.value; touch(); });
      right.appendChild(fld("API", apiSel));

      right.appendChild(fld("请求头", headerEditor(p, "provider"),
        "加到这个服务商的每个请求上（例如 User-Agent），网关做机器人识别时有用。"));

      var discBox = el("div", "md-disc");
      if (!disc || disc.phase === "idle" || disc.phase === "error") {
        // 不禁用：内建 Provider 走本地模型表，不需要 Base URL；
        // 真缺条件时 doDiscover 会给出可读的错误，而不是按钮点了没反应。
        var dbtn = el("button", "md-btn", disc && disc.phase === "error" ? "重试导入模型…" : "导入模型…");
        dbtn.addEventListener("click", doDiscover);
        discBox.appendChild(dbtn);
        var isBuiltin = !!MdCatalog.builtinIdFor(name);
        discBox.appendChild(el("div", "md-hint", isBuiltin
          ? "从 pi 内置模型表导入（本地读取，不需要 API 密钥）或抓取 " + (p.baseUrl || "<接口地址>") + "/models。"
          : "抓取 " + (p.baseUrl || "<接口地址>") + "/models；若服务商名与 pi 内置同名则改用内置模型表。"));
        if (disc && disc.phase === "error") discBox.appendChild(el("div", "md-err", disc.error));
      } else if (disc.phase === "loading") {
        discBox.appendChild(statusLine("", "正在读取 " + (disc.src || "模型表") + " …"));
      } else if (disc.phase === "done") {
        var existing = {};
        modelsOf(name).forEach(function (m) { existing[m.id] = 1; });
        var q = el("input", "md-in");
        q.value = disc.query || "";
        q.placeholder = "筛选 " + disc.models.length + " 个模型…";
        q.addEventListener("input", function () { disc.query = q.value; renderRight(); });
        discBox.appendChild(q);

        var listBox = el("div", "md-disclist");
        var all = el("label", "md-discall");
        var allCk = el("input");
        allCk.type = "checkbox";
        var sel0 = disc.picked;
        var shown = disc.models.filter(function (x) {
          var s = (disc.query || "").trim().toLowerCase();
          if (!s) return true;
          return String(x.id).toLowerCase().indexOf(s) >= 0
            || String(x.name || "").toLowerCase().indexOf(s) >= 0;
        }).slice(0, 300);
        var pickable = shown.filter(function (x) { return !existing[x.id]; });
        allCk.checked = pickable.length > 0 && pickable.every(function (x) { return sel0[x.id]; });
        allCk.disabled = pickable.length === 0;
        allCk.addEventListener("change", function () {
          pickable.forEach(function (x) { if (allCk.checked) sel0[x.id] = 1; else delete sel0[x.id]; });
          renderRight();
        });
        all.appendChild(allCk);
        all.appendChild(el("span", "", "全选可见项"));
        listBox.appendChild(all);

        if (!shown.length) listBox.appendChild(el("div", "md-discnone", "没有匹配的模型"));
        shown.forEach(function (x) {
          var added = !!existing[x.id];
          var row = el("label", "md-discrow" + (added ? " done" : ""));
          var c = el("input");
          c.type = "checkbox";
          c.checked = added || !!sel0[x.id];
          c.disabled = added;
          c.addEventListener("change", function () {
            if (c.checked) sel0[x.id] = 1; else delete sel0[x.id];
            renderRight();
          });
          row.appendChild(c);
          var t = el("span", "md-disctxt");
          t.appendChild(el("span", "md-discnm", x.name || x.id));
          if (x.name) t.appendChild(el("code", "md-disccode", x.id));
          row.appendChild(t);
          if (added) row.appendChild(el("span", "md-discadded", "已添加"));
          listBox.appendChild(row);
        });
        discBox.appendChild(listBox);

        var foot2 = el("div", "md-discfoot");
        foot2.appendChild(el("span", "md-discinfo",
          "共 " + disc.models.length + " 个 · " + (disc.url || "")));
        var cnt = pickable.filter(function (x) { return sel0[x.id]; }).length;
        var addBtn = el("button", "md-btn md-btn-primary", cnt ? "添加所选（" + cnt + "）" : "添加所选");
        addBtn.disabled = cnt === 0;
        addBtn.addEventListener("click", function () {
          var arr = cfg.providers[name].models = cfg.providers[name].models || [];
          var ids = disc.models
            .filter(function (x) { return sel0[x.id] && !existing[x.id]; })
            .map(function (x) { return x.id; });
          if (!ids.length) return;
          var pidAdd = MdCatalog.builtinIdFor(name);
          var push = function (list) {
            (list || []).forEach(function (m) {
              if (!m || !m.id || existing[m.id]) return;
              existing[m.id] = 1;
              arr.push(m);
            });
          };
          var done = function () {
            sel = { type: "provider", name: name };
            disc = null;
            touch(); renderAll();
            toasts("已添加 " + ids.length + " 个模型");
          };
          // 内建 Provider 让 pi 自己生成条目：上下文窗口 / 最大输出 / 价格都带对。
          if (pidAdd) {
            send("models.fromCatalog", { id: pidAdd, models: ids })
              .then(function (r) { push((r && r.models) || []); done(); })
              .catch(function () {
                push(ids.map(function (id) {
                  return { id: id, name: id, contextWindow: 128000, maxTokens: 16384 };
                }));
                done();
              });
          } else {
            push(disc.models
              .filter(function (x) { return sel0[x.id] && !existing[x.id]; })
              .map(function (x) {
                return { id: x.id, name: x.name || x.id, contextWindow: 128000, maxTokens: 16384 };
              }));
            done();
          }
        });
        foot2.appendChild(addBtn);
        discBox.appendChild(foot2);
      }
      right.appendChild(discBox);
    }

    function doDiscover() {
      var p = prov(sel.name);
      var pid = MdCatalog.builtinIdFor(sel.name);
      var base = String(p.baseUrl || "").trim();
      disc = { phase: "loading", query: "", picked: {}, models: [], src: pid && !base ? "pi 内置模型表" : "模型端点" };
      renderRight();

      // 内建 Provider 的模型表 pi 本地就有一份，不用联网、不用 API Key；
      // 只有自定义端点才去抓 {baseUrl}/models。先试更靠谱的那条，失败再退另一条。
      var tryLocal = function () {
        if (!pid) return Promise.reject(new Error("这不是 pi 内置服务商，填好接口地址后重试"));
        return send("models.catalogModels", { id: pid }).then(function (r) {
          var d = (r && r.provider) || {};
          var ms = (d.models || []).map(function (m) { return { id: m.id, name: m.name || m.id }; });
          if (!ms.length) throw new Error("pi 内置目录里没有 " + pid + " 的模型表");
          return { models: ms, url: "pi 内置目录 · " + pid, src: "pi 内置模型表" };
        });
      };
      var tryRemote = function () {
        if (!base) return Promise.reject(new Error("请先填接口地址，或把服务商名字改成 pi 内置服务商名以使用本地模型表"));
        return send("models.discover", {
          baseUrl: base, api: p.api || "openai-completions", apiKey: p.apiKey || ""
        }).then(function (r) {
          var arr = (r && r.models) || [];
          if (!arr.length) throw new Error("端点没有返回任何模型");
          return { models: arr, url: (r && r.url) || (base + "/models"), src: "模型端点" };
        });
      };

      var chain = base
        ? tryRemote().catch(function (e1) { return tryLocal().catch(function () { throw e1; }); })
        : tryLocal().catch(function (e1) {
            // 本地表也不认这个名字：把「要填 Base URL」写进错误里，
            // 否则用户看到的是“pi 目录里没有 xxx”，不知道下一步该干吗。
            return tryRemote().catch(function () {
              throw new Error(e1.message + "（想抓端点请先填接口地址）");
            });
          });

      chain.then(function (ok) {
        disc = { phase: "done", query: "", picked: {}, models: ok.models, url: ok.url, src: ok.src };
        renderRight();
      }).catch(function (e) {
        disc = { phase: "error", error: e.message };
        renderRight();
      });
    }

    /* ---------- 右栏：添加 Provider 选择器 ---------- */
    function renderPicker() {
      right.innerHTML = "";
      var head = el("div", "md-head");
      head.appendChild(el("div", "md-h", "添加 Provider"));
      head.appendChild(el("div", "md-spacer"));
      var cancel = el("button", "md-btn", "取消");
      cancel.addEventListener("click", function () { picker = false; renderRight(); });
      head.appendChild(cancel);
      right.appendChild(head);

      var q = el("input", "md-in md-picksearch");
      q.placeholder = "搜索 Provider…";
      head.after(q);

      var list = el("div", "md-picklist");
      right.appendChild(list);
      var qv = "";

      function draw() {
        list.innerHTML = "";
        var existing = {};
        Object.keys(cfg.providers).forEach(function (k) { existing[k] = 1; });
        var s = qv.trim().toLowerCase();

        function card(p, title, sub) {
          var c = el("div", "md-pickcard");
          var t = el("div", "md-picktxt");
          t.appendChild(el("div", "md-picknm", title));
          t.appendChild(el("div", "md-picksub", sub));
          c.appendChild(t);
          c.addEventListener("click", function () {
            // 内建 Provider 不能预先写一个只有名字的空壳（pi 会直接报错），
            // 这里只建一个空对象占位，真实字段靠用户填，保存时空壳由 sanitize() 剔掉。
            ensureProv(p);
            picker = false;
            sel = { type: "provider", name: p };
            touch(); renderAll();
          });
          return c;
        }

        // 自定义
        list.appendChild(el("div", "md-pickgrp", "自定义"));
        var cg = el("div", "md-pickgrid");
        var cc = el("div", "md-pickcard md-pickcustom");
        var ct = el("div", "md-picktxt");
        ct.appendChild(el("div", "md-picknm", "OpenAI / Anthropic / 自定义端点"));
        ct.appendChild(el("div", "md-picksub", "自定义端点格式"));
        cc.appendChild(ct);
        var plus = el("span", "md-pickplus", "+");
        cc.appendChild(plus);
        cc.addEventListener("click", function () {
          var n = "new-provider", i = 1;
          while (cfg.providers[n]) { n = "new-provider-" + (++i); }
          cfg.providers[n] = { api: "openai-completions", apiKey: "", models: [] };
          picker = false;
          sel = { type: "provider", name: n };
          touch(); renderAll();
        });
        cg.appendChild(cc);
        list.appendChild(cg);

        if (catErr) {
          list.appendChild(el("div", "md-err", "读取 pi 内建 Provider 目录失败：" + catErr));
          return;
        }
        if (!cat) {
          list.appendChild(statusLine("", "正在读取 pi 内建 Provider 目录…"));
          return;
        }

        function match(p) {
          if (!s) return true;
          return String(p.id).toLowerCase().indexOf(s) >= 0
            || String(p.name || "").toLowerCase().indexOf(s) >= 0
            || String(p.oauthName || "").toLowerCase().indexOf(s) >= 0;
        }
        var subs = cat.filter(function (p) { return p.oauth && !existing[p.id] && match(p); });
        var keys = cat.filter(function (p) { return !existing[p.id] && match(p); });

        if (subs.length) {
          list.appendChild(el("div", "md-pickgrp", "订阅服务"));
          var g1 = el("div", "md-pickgrid");
          subs.forEach(function (p) { g1.appendChild(card(p.id, p.oauthName || p.name, "OAuth")); });
          list.appendChild(g1);
        }
        if (keys.length) {
          list.appendChild(el("div", "md-pickgrp", "API 密钥"));
          var g2 = el("div", "md-pickgrid");
          keys.forEach(function (p) {
            g2.appendChild(card(p.id, p.name, p.modelCount + " 个模型"));
          });
          list.appendChild(g2);
        }
        if (!subs.length && !keys.length) {
          list.appendChild(el("div", "md-discnone", "没有匹配的 Provider"));
        }
      }
      q.addEventListener("input", function () { qv = q.value; draw(); });
      draw();
    }

    /* ---------- 调度 ---------- */
    function renderRight() {
      if (picker) return renderPicker();
      if (!sel) {
        right.innerHTML = "";
        right.appendChild(el("div", "md-empty", "从左侧选一个 Provider 或模型。"));
        return;
      }
      if (sel.type === "model") return renderModelDetail(sel.name, sel.index);
      return renderProviderDetail(sel.name);
    }

    // 只重画左栏（改模型 id / 思考开关时用，避免右栏输入框丢焦点）
    var leftTimer = null;
    function renderLeftSoon() {
      if (leftTimer) return;
      leftTimer = setTimeout(function () {
        leftTimer = null;
        renderLeft();
      }, 400);
    }

    // 切换选中项时把右栏滚回顶部。
    // 不这么做会踩到一个坑：right 是同一个 DOM 节点，只换 innerHTML 时
    // scrollTop 会被保留，从长详情切到短详情就停在半中间，看起来像"页面没对齐"。
    var lastSelKey = null;
    function selKey() {
      if (!sel) return "";
      return sel.type + ":" + sel.name + ":" + (sel.index === undefined ? "" : sel.index);
    }

    function renderAll() {
      var k = selKey();
      var moved = k !== lastSelKey;
      lastSelKey = k;
      renderLeft();
      renderRight();
      // 两层都要：同步那一下应付普通重画；rAF 那一下应付首帧——
      // 模态框打开时会对首个可聚焦元素 focus()，浏览器为了把它拉进视口
      // 会改 right.scrollTop，只设一次会被它覆盖。
      if (moved) {
        right.scrollTop = 0;
        requestAnimationFrame(function () { right.scrollTop = 0; });
      }
    }

    /* ---------- 载入 ---------- */
    right.innerHTML = "";
    right.appendChild(statusLine("", "正在读取 ~/.pi/agent/models.json…"));
    left.appendChild(el("div", "empty", "载入中…"));
    foot();

    // 内建 Provider 目录：慢（要起 node），异步来，不挡页面
    send("models.catalog").then(function (r) {
      cat = (r && r.providers) || [];
      MdCatalog.ids = cat.map(function (p) { return p.id; });
      MdCatalog.byId = {};
      cat.forEach(function (p) { MdCatalog.byId[p.id] = p; });
    }).catch(function (e) {
      catErr = e.message;
    }).then(function () {
      if (picker) renderPicker();
    });

    send("models.read", {}).then(function (r) {
      cfg = (r && r.config) || { providers: {} };
      cfg.providers = cfg.providers || {};
      // 补默认：models 数组、api 缺省值，避免下面到处判空
      // 不在这里补 api 默认值：写回盘时会把内建 Provider 的 api 覆盖成 openai-completions。
      // 读取端统一用 `p.api || "openai-completions"` 兜底。
      Object.keys(cfg.providers).forEach(function (k) {
        var p = cfg.providers[k];
        if (!Array.isArray(p.models)) p.models = [];
      });
      var names = Object.keys(cfg.providers);
      if (names.length) sel = { type: "provider", name: names[0] };
      right.innerHTML = "";
      if (!names.length) {
        right.appendChild(el("div", "hint-box",
          "还没有 models.json（" + ((r && r.path) || "~/.pi/agent/models.json") +
          "）。点左下角「+ 添加 Provider」从 pi 的内建目录里挑一个，或建一个自定义端点。"));
      }
      renderAll();
    }).catch(function (e) {
      right.innerHTML = "";
      right.appendChild(el("div", "hint-box", "读取模型配置失败：" + e.message));
    });
  }

  /* pi 内建 Provider 目录的只读小工具：把 models.json 里的自定义 Provider 名
     映射回 pi 的内建 id（同名即可，pi 的 models.json 用 Provider id 当键）。 */
  var MdCatalog = {
    ids: null,
    byId: {},
    builtinIdFor: function (name) {
      // pi 的 models.json 用 Provider id 当键，覆盖内建时就是同名
      if (!name) return null;
      if (!this.ids) return name;             // 目录还没读完，先按同名试
      return this.ids.indexOf(name) >= 0 ? name : null;
    }
  };

  /* ---------------- 分页 3：技能 ---------------- */
  /* ---------------- 分页 3：技能 ----------------
     布局对齐 pi-web 的 SkillsConfig：
     左栏 = 「全局 / 项目级」分组 + 圆点行（启用=实心绿点，停用=空心点）
            + 底部「+ 添加技能」；
     右栏 = 作用域标签 + 完整路径 + 右侧开关，下面 Name / Description；
            装了 skills.sh 包的额外带 来源 / 版本 / 检查更新 / 更新 / 卸载；
            点「+ 添加技能」换页为添加态（搜索框 + global|project + 安装路径）。 */
  function renderSkills(body) {
    var wrap = el("div", "split");
    var left = el("div", "split-left");
    var right = el("div", "split-right");
    var list = el("div", "split-list");
    var foot = el("div", "split-foot");
    var addBtn = el("button", "btn btn-block btn-ghost", "+ 添加技能");
    foot.appendChild(addBtn);
    left.appendChild(list); left.appendChild(foot);
    wrap.appendChild(left); wrap.appendChild(right);
    body.appendChild(wrap);

    var ST = { skills: [], inst: {}, cwd: "", sel: null, addMode: false, loaded: false };

    var SCOPE_LABEL = { project: "项目", package: "包", global: "全局" };
    function sourceLabel(s) {
      if (s.scope === "project" || s.source === "project") return "project";
      if (s.source === "package") return "package";
      return "global";
    }
    function keyOf(s) { return s.path || s.name; }

    addBtn.addEventListener("click", function () {
      ST.addMode = true; ST.sel = null;
      paintList(); paintRight();
    });

    function load() {
      right.innerHTML = "";
      right.appendChild(el("div", "hint-box", "读取技能中…"));
      send("app.home", {}).then(function (h) {
        ST.cwd = (h && (h.cwd || h.home)) || "";
        return send("skills.installs", { cwd: ST.cwd });
      }).then(function (ir) {
        ST.inst = (ir && ir.installs) || {};
        return send("skills.list", { cwd: ST.cwd });
      }).then(function (sl) {
        ST.skills = ((sl && sl.skills) || []).map(function (s) {
          var o = {};
          Object.keys(s).forEach(function (k) { o[k] = s[k]; });
          o.install = ST.inst[o.name];
          return o;
        });
        ST.loaded = true;
        // 默认选中第一个「启用中」的技能（与 pi-web 的 initialSkill 选取一致）
        var first = null;
        for (var i = 0; i < ST.skills.length; i++) {
          if (ST.skills[i].enabled) { first = ST.skills[i]; break; }
        }
        if (!first && ST.skills.length) first = ST.skills[0];
        ST.sel = first ? keyOf(first) : null;
        paintList(); paintRight();
      }).catch(function (e) {
        right.innerHTML = "";
        right.appendChild(el("div", "hint-box", "读取技能失败：" + e.message));
      });
    }

    /* 分组顺序照 pi-web：项目级/skills.sh → 项目级 → 全局/skills.sh → 全局 → 包内置 */
    function groups() {
      var defs = [
        { label: "项目级 / skills.sh", m: function (s) { return sourceLabel(s) === "project" && s.install && s.install.skillsShUrl; } },
        { label: "项目级", m: function (s) { return sourceLabel(s) === "project" && !(s.install && s.install.skillsShUrl); } },
        { label: "全局 / skills.sh", m: function (s) { return sourceLabel(s) === "global" && s.install && s.install.skillsShUrl; } },
        { label: "全局", m: function (s) { return sourceLabel(s) === "global" && !(s.install && s.install.skillsShUrl); } },
        { label: "包内置", m: function (s) { return sourceLabel(s) === "package"; } }
      ];
      var out = [];
      defs.forEach(function (d) {
        var g = ST.skills.filter(d.m);
        // 停用的排在启用之后，与 pi-web 的 orderSkillsByDormancy 一致
        g = g.filter(function (s) { return s.enabled; }).concat(g.filter(function (s) { return !s.enabled; }));
        if (g.length) out.push({ label: d.label, items: g });
      });
      return out;
    }

    function paintList() {
      list.innerHTML = "";
      groups().forEach(function (grp) {
        list.appendChild(el("div", "grp", grp.label));
        grp.items.forEach(function (s) {
          var k = keyOf(s);
          var row = el("div", "li" + (!ST.addMode && ST.sel === k ? " on" : ""));
          var t = el("div", "t");
          t.appendChild(el("span", s.enabled ? "dot-on" : "dot-off"));
          var nm = el("span", "nm", s.name);
          if (!s.enabled) nm.style.color = "var(--fg-dim)";
          t.appendChild(nm);
          if (s.upd && s.upd.state === "update-available") {
            var up = el("span", "", "↑");
            up.title = "有新版本";
            up.style.color = "#d97706";
            t.appendChild(up);
          }
          row.appendChild(t);
          row.addEventListener("click", function () {
            ST.addMode = false; ST.sel = k; paintList(); paintRight();
          });
          list.appendChild(row);
        });
      });
      if (!ST.loaded) list.appendChild(el("div", "empty", "读取中…"));
      else if (!ST.skills.length) list.appendChild(el("div", "empty", "没有找到技能"));
      addBtn.classList.toggle("on", ST.addMode);
    }

    function paintRight() {
      right.innerHTML = "";
      if (!ST.loaded) return;
      if (ST.addMode) { paintAdd(); return; }
      var s = null;
      for (var i = 0; i < ST.skills.length; i++) {
        if (keyOf(ST.skills[i]) === ST.sel) { s = ST.skills[i]; break; }
      }
      if (!s) { right.appendChild(el("div", "hint", "请选择左侧技能")); return; }
      paintDetail(s);
    }

    function paintDetail(s) {
      var label = sourceLabel(s);
      // 第一行：作用域标签 + 完整路径 + 右侧开关（与 pi-web 的 skill-detail-heading 同构）
      var head = el("div", "sk-head");
      var chip = el("span", "scope-chip" + (label === "project" ? " project" : ""), SCOPE_LABEL[label] || label);
      head.appendChild(chip);
      var pth = el("span", "sk-path", s.path || "—");
      pth.title = s.path || "";
      head.appendChild(pth);
      head.appendChild(el("span", "plg-spacer"));
      var sw = el("span", "sw" + (s.enabled ? " on" : ""));
      sw.title = s.enabled ? "已加入系统提示" : "已从系统提示隐藏";
      sw.addEventListener("click", function () {
        var want = !s.enabled;
        sw.style.opacity = ".5";
        send("skills.setEnabled", { path: s.path, enabled: want }).then(function () {
          s.enabled = want;
          s.disableModelInvocation = !want;
          sw.style.opacity = "";
          paintList(); paintDetail(s);
          toasts(want ? "已启用 " + s.name : "已停用 " + s.name);
        }).catch(function (e) {
          sw.style.opacity = "";
          toasts("保存失败：" + e.message, "error");
        });
      });
      head.appendChild(sw);
      right.appendChild(head);

      if (!s.enabled) {
        var note = el("div", "hint", "已从系统提示隐藏，但模型仍可通过 skill 命令显式调用。");
        note.style.marginTop = "4px";
        right.appendChild(note);
      }

      if (s.install && s.install.skillsShUrl) {
        var f1 = el("div", "sk-fld");
        f1.appendChild(el("div", "sk-flabel", "来源"));
        var a = el("a", "sk-link", String(s.install.skillsShUrl).replace(/^https?:\/\//, "") + " \u2197");
        a.href = s.install.skillsShUrl;
        a.title = s.install.skillsShUrl;
        a.target = "_blank";
        f1.appendChild(a);
        right.appendChild(f1);
      }

      if (s.install) {
        var f2 = el("div", "sk-fld");
        f2.appendChild(el("div", "sk-flabel", "版本"));
        var vr = el("div", "row");
        vr.style.marginBottom = "0";
        var hash = s.install.versionHash || (s.install.source || "");
        vr.appendChild(el("code", "sk-name", String(hash).slice(0, 8) || "unknown"));
        if (s.install.canCheckForUpdates) {
          var ck = el("button", "btn", "检查");
          ck.style.marginLeft = "8px";
          ck.addEventListener("click", function () {
            ck.disabled = true; ck.textContent = "检查中…";
            send("skills.check", {
              source: s.install.source, skillPath: s.install.skillPath,
              ref: s.install.ref || "", versionHash: s.install.versionHash, scope: s.install.scope
            }).then(function (r) {
              ck.disabled = false; ck.textContent = "检查";
              s.upd = r || {};
              if (r && r.state === "update-available") {
                var nv = el("code", "", String(r.latestVersion || "").slice(0, 8));
                nv.style.color = "#d97706"; nv.style.marginLeft = "8px";
                vr.appendChild(nv);
                var ub = el("button", "btn btn-new", "更新");
                ub.style.marginLeft = "8px";
                ub.addEventListener("click", function () { doUpdate(s, ub); });
                vr.appendChild(ub);
                paintList();
              } else {
                vr.appendChild(el("span", "hint", r && r.state === "up-to-date" ? "已是最新" : "无法检查：" + ((r && r.message) || "未知")));
              }
            }).catch(function (e) {
              ck.disabled = false; ck.textContent = "检查";
              toasts("检查失败：" + e.message, "error");
            });
          });
          vr.appendChild(ck);
        }
        var rm = el("button", "btn btn-stop", "卸载");
        rm.style.marginLeft = "8px";
        rm.addEventListener("click", function () {
          if (!confirm("卸载技能「" + s.name + "」（来源 " + s.install.package + "）？")) return;
          rm.disabled = true; rm.textContent = "卸载中…";
          send("skills.remove", { source: s.install.package, scope: s.install.scope })
            .then(function (r) {
              if (!r || !r.ok) throw new Error((r && r.output) || "卸载返回非成功状态");
              toasts("已卸载 " + s.name);
              ST.sel = null; ST.addMode = false; load();
            })
            .catch(function (e) { rm.disabled = false; rm.textContent = "卸载"; toasts(e.message, "error"); });
        });
        vr.appendChild(rm);
        f2.appendChild(vr);
        right.appendChild(f2);
      }

      var f3 = el("div", "sk-fld");
      f3.appendChild(el("div", "sk-flabel", "名称"));
      f3.appendChild(el("div", "sk-name", s.name));
      right.appendChild(f3);
      var f4 = el("div", "sk-fld");
      f4.appendChild(el("div", "sk-flabel", "描述"));
      f4.appendChild(el("div", "sk-desc", s.description || "（无描述）"));
      right.appendChild(f4);
    }

    function doUpdate(s, btn) {
      btn.disabled = true; btn.textContent = "更新中…";
      send("skills.update", {
        source: s.install.source, skill: s.name, ref: s.install.ref || "",
        scope: s.install.scope, skillPath: s.install.skillPath || ""
      }).then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.output) || "更新返回非成功状态");
        toasts("已更新 " + s.name);
        load();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = "更新";
        toasts(e.message, "error");
      });
    }

    /* 添加技能态（对应 pi-web 的 AddSkillPanel） */
    function paintAdd() {
      right.appendChild(el("div", "sk-addttl", "添加技能"));
      var qrow = el("div", "row");
      qrow.style.marginTop = "12px";
      var qi = el("input", "sk-search-input");
      qi.placeholder = "例如 react、testing、deploy";
      var qb = el("button", "btn btn-new", "搜索");
      qb.style.marginLeft = "8px";
      qrow.appendChild(qi); qrow.appendChild(qb);
      right.appendChild(qrow);

      var scope = "global";
      var srow = el("div", "row");
      srow.style.marginTop = "10px";
      var seg = el("div", "seg sk-seg");
      var bG = el("button", "seg-b on", "全局");
      var bP = el("button", "seg-b", "项目");
      seg.appendChild(bG); seg.appendChild(bP);
      var arrow = el("span", "hint", "\u2192 ~/.pi/agent/skills/");
      arrow.style.marginLeft = "10px";
      srow.appendChild(seg); srow.appendChild(arrow);
      right.appendChild(srow);

      function setScope(v) {
        scope = v;
        bG.classList.toggle("on", v === "global");
        bP.classList.toggle("on", v === "project");
        arrow.textContent = v === "global" ? "\u2192 ~/.pi/agent/skills/" : "\u2192 " + (ST.cwd || ".") + "/.pi/skills/";
      }
      bG.addEventListener("click", function () { setScope("global"); });
      bP.addEventListener("click", function () { setScope("project"); });

      var out = el("div", "");
      out.style.marginTop = "16px";
      out.appendChild(el("div", "sk-empty", "在 skills.sh 上搜索，为你的 agent 发现并安装技能。"));
      right.appendChild(out);
      qi.focus();

      var installed = {};
      ST.skills.forEach(function (s) { if (s.install) installed[s.install.scope + ":" + s.install.package] = 1; });

      function doSearch() {
        var q = qi.value.trim();
        if (!q) return;
        out.innerHTML = "";
        out.appendChild(statusLine("", "正在搜索「" + q + "」…（首次会下载 npx skills，可能较慢）"));
        send("skills.search", { query: q, limit: 50 }).then(function (r) {
          out.innerHTML = "";
          var items = (r && r.results) || [];
          if (!items.length) {
            out.appendChild(el("div", "hint-box", "没有搜到结果。也可以直接填完整包名，如 owner/repo@skill。"));
          }
          items.forEach(function (it) {
            var at = String(it.package).indexOf("@");
            var repo = at > -1 ? String(it.package).slice(0, at) : String(it.package);
            var nm = at > -1 ? String(it.package).slice(at + 1) : repo;
            var row = el("div", "sk-res");
            var box = el("div", "");
            box.style.flex = "1"; box.style.minWidth = "0";
            var t = el("div", "sk-name", nm);
            t.style.marginBottom = "3px";
            box.appendChild(t);
            var meta = el("div", "row");
            var rp = el("code", "", repo);
            rp.style.fontSize = "11px";
            meta.appendChild(rp);
            meta.appendChild(el("span", "hint", String(it.installs || "")));
            if (it.url) {
              var a = el("a", "sk-link", "skills.sh \u2197");
              a.href = it.url; a.target = "_blank";
              a.style.fontSize = "12px";
              meta.appendChild(a);
            }
            box.appendChild(meta);
            row.appendChild(box);
            var b = el("span", "badge", "安装");
            b.style.cursor = "pointer";
            var k = scope + ":" + it.package;
            if (installed[k]) { b.textContent = "\u2713 已安装"; b.className = "badge on"; }
            b.addEventListener("click", function () {
              if (installed[k]) return;
              b.textContent = "安装中…";
              send("skills.install", { source: it.package, scope: scope }).then(function (rr) {
                if (!rr || !rr.ok) throw new Error((rr && rr.output) || "安装返回非成功状态");
                toasts("已安装 " + it.package);
                installed[k] = 1;
                b.textContent = "\u2713 已安装";
                b.className = "badge on";
                ST.sel = null; ST.addMode = false; load();
              }).catch(function (e) {
                b.textContent = "安装";
                toasts(e.message, "error");
              });
            });
            row.appendChild(b);
            out.appendChild(row);
          });
        }).catch(function (e) {
          out.innerHTML = "";
          out.appendChild(el("div", "hint-box", "搜索失败：" + e.message));
        });
      }
      qb.addEventListener("click", doSearch);
      qi.addEventListener("keydown", function (e) { if (e.key === "Enter") doSearch(); });
    }

    load();
  }
  /* ---------------- 分页 4：子代理 ---------------- */
  // 对应 pi-web 的 /api/subagents/*：顶部总开关 + 并发数，左侧「内置」分组 +
  // 「+ 新建子代理」，右侧详情表单（内置 profile 只读，可「创建副本」；
  // 自建 profile 可改名/工具/资源/模型/思考级别/最大轮次/两个布尔，底部保存）。
  function renderAgents(body) {
    // 页内布局：顶部通栏（启用开关 + 并发数）+ 下方左右双栏。
    // 不复用 .split（它在 pi-web 里是贴满整页的），子代理页多一条通栏头。
    var page = el("div", "sa-page");
    var headHost = el("div", "sa-headhost");
    page.appendChild(headHost);
    var wrap = el("div", "sa-body");
    var left = el("div", "split-left");
    var right = el("div", "split-right");
    var list = el("div", "split-list");
    left.appendChild(list);
    var foot = el("div", "split-foot");
    var addBtn = el("button", "btn btn-block btn-ghost", "+ 新建子代理");
    foot.appendChild(addBtn);
    left.appendChild(foot);
    wrap.appendChild(left); wrap.appendChild(right);
    page.appendChild(wrap);
    body.appendChild(page);

    var AG = { profiles: [], settings: { enabled: false, maxConcurrent: 1 }, sel: null, view: "detail", models: [] };
    var want = takePick("agents");

    // 内置 profile 与自建同名时，自建覆盖内置。
    function byName(n) {
      var self = AG.profiles.filter(function (p) { return p.name === n && p.scope !== "builtin"; });
      if (self.length) return self[0];
      var b = AG.profiles.filter(function (p) { return p.name === n && p.scope === "builtin"; });
      return b.length ? b[0] : null;
    }

    function pick(n) {
      var p = byName(n);
      if (!p) return;
      AG.sel = p; AG.view = "detail";
      renderList(); renderRight();
    }

    /* ---- 顶部：启用总开关 + 并发数 ---- */
    function renderHead() {
      var head = el("div", "sa-head");
      var txt = el("div", "sa-headtxt");
      txt.appendChild(el("div", "sa-h1", "启用 Pi Web 内置子代理"));
      txt.appendChild(el("div", "sa-h2", "提供 Pi Web 集成的 Agent 工具，并停用发生冲突的 pi-subagents 扩展。"));
      head.appendChild(txt);

      var right2 = el("div", "sa-headright");
      right2.appendChild(el("div", "sa-h2", "并发子代理数"));
      var num = el("input", "sa-num");
      num.type = "number"; num.min = "1"; num.max = "32";
      num.value = String(AG.settings.maxConcurrent || 1);
      function saveMax() {
        var n = parseInt(num.value, 10);
        if (!(n >= 1 && n <= 32)) { n = AG.settings.maxConcurrent || 1; num.value = String(n); toasts("并发数需 1– 32", "warn"); return; }
        send("agents.settings", { enabled: AG.settings.enabled, maxConcurrent: n }).then(function (r) {
          AG.settings = (r && r.settings) || AG.settings;
          toasts("并发数已改为 " + AG.settings.maxConcurrent);
        }).catch(function (e) { toasts("保存失败：" + e.message, "error"); });
      }
      num.addEventListener("change", saveMax);
      right2.appendChild(num);
      right2.appendChild(switchEl(AG.settings.enabled, function (on) {
        send("agents.settings", { enabled: on, maxConcurrent: AG.settings.maxConcurrent }).then(function (r) {
          if (r && r.settings) AG.settings = r.settings;
          if (r && r.profiles) AG.profiles = r.profiles;
          AG.enabled = AG.settings.enabled;
          toasts(on ? "已启用内置子代理（同时停用 pi-subagents 扩展）" : "已停用内置子代理");
          render();
        }).catch(function (e) { toasts("保存失败：" + e.message, "error"); render(); });
      }));
      head.appendChild(right2);
      footStat();
      headHost.innerHTML = "";
      headHost.appendChild(head);
    }

    /* ---- 左列表 ---- */
    function renderList() {
      list.innerHTML = "";
      var builtin = [];
      var seen = {};
      AG.profiles.forEach(function (p) {
        if (p.scope === "builtin") { if (!seen[p.name]) { seen[p.name] = 1; builtin.push(p); } return; }
      });
      var custom = AG.profiles.filter(function (p) { return p.scope !== "builtin"; });

      function addItem(p) {
        var b = el("div", "li" + (AG.view === "detail" && AG.sel && AG.sel.name === p.name && AG.sel.scope === p.scope ? " on" : ""));
        var t = el("div", "t");
        t.appendChild(el("span", p.enabled === false ? "dot-off" : "dot-on"));
        var nm = el("span", "nm", p.displayName || p.name);
        nm.title = p.name;
        t.appendChild(nm);
        b.appendChild(t);
        b.addEventListener("click", function () { pick(p.name); });
        list.appendChild(b);
      }

      list.appendChild(el("div", "grp", "内置"));
      builtin.forEach(addItem);
      // 包自带（npm 子代理包）与自定义分开列：包那层是只读的，来源不同。
      var pkgs = custom.filter(function (p) { return p.scope === "package"; });
      var own = custom.filter(function (p) { return p.scope !== "package"; });
      if (pkgs.length) {
        list.appendChild(el("div", "grp", "包自带"));
        pkgs.forEach(addItem);
      }
      if (own.length) {
        list.appendChild(el("div", "grp", "自定义"));
        own.forEach(addItem);
      }
      if (!AG.profiles.length) list.appendChild(el("div", "empty", "没有找到任何子代理配置"));
    }

    /* ---- 右栏：内置 profile 详情（只读 + 创建副本） ---- */
    function renderBuiltinDetail(p) {
      right.innerHTML = "";
      var box = el("div", "sa-card");
      var row = el("div", "sa-cardhead");
      row.appendChild(el("span", "scope-chip", "内置"));
      row.appendChild(el("span", "sa-cardttl", "内置配置"));
      var sp = el("div", "plg-spacer"); row.appendChild(sp);
      var dup = el("button", "btn", "创建副本");
      dup.addEventListener("click", function () { newProfileFrom(p); });
      row.appendChild(dup);
      // 内置 profile 没有单独的启用键：截图里那个开关就是总开关 builtInEnabled，
      // 所以这里直接读写 settings.enabled，不做假的本地开关。
      row.appendChild(switchEl(AG.settings.enabled, function (on) {
        send("agents.settings", { enabled: on, maxConcurrent: AG.settings.maxConcurrent }).then(function (r) {
          if (r && r.settings) AG.settings = r.settings;
          AG.enabled = !!(AG.settings && AG.settings.enabled);
          toasts(on ? "已启用内置子代理（同时停用 pi-subagents 扩展）" : "已停用内置子代理");
          render();
        }).catch(function (e) { toasts("保存失败：" + e.message, "error"); render(); });
      }));
      box.appendChild(row);

      var grid = el("div", "sa-grid");
      var f1 = el("div", "sa-field");
      f1.appendChild(el("div", "sa-label", "子代理 ID"));
      f1.appendChild(el("div", "sa-ro", p.name));
      grid.appendChild(f1);
      var f2 = el("div", "sa-field");
      f2.appendChild(el("div", "sa-label", "显示名称"));
      f2.appendChild(el("div", "sa-ro", p.displayName || p.name));
      grid.appendChild(f2);
      box.appendChild(grid);

      var d = el("div", "sa-field");
      d.appendChild(el("div", "sa-label", "描述"));
      d.appendChild(el("div", "sa-ro wrap", p.description || "—"));
      box.appendChild(d);
      var s = el("div", "sa-field");
      s.appendChild(el("div", "sa-label", "系统指令"));
      s.appendChild(el("div", "sa-ro wrap", p.systemPrompt || "—"));
      box.appendChild(s);
      var t = el("div", "sa-field");
      t.appendChild(el("div", "sa-label", "工具"));
      t.appendChild(el("div", "sa-ro wrap", (p.tools || []).join(" ") || "none"));
      box.appendChild(t);
      right.appendChild(box);
      footStat();
    }

    // 底部左角的常驻状态（总开关状态），不随右栏切换而丢
    function footStat() {
      setFoot([el("div", "foot-stat", AG.settings.enabled ? "内置子代理：已启用" : "内置子代理：已停用")]);
    }

    /* ---- 右栏：只读来源（包自带 / .agents/agents）----
       这两层 pi 会读、但不归本 UI 写，强做编辑只会写到 pi 不看的文件。 */
    function renderReadonlyDetail(p) {
      right.innerHTML = "";
      var box = el("div", "sa-card");
      var row = el("div", "sa-cardhead");
      row.appendChild(el("span", "scope-chip", p.scope === "package" ? "包自带" : "工作区"));
      row.appendChild(el("span", "sa-path", p.displayPath || ""));
      row.appendChild(el("div", "plg-spacer"));
      var dup = el("button", "btn", "创建副本");
      dup.addEventListener("click", function () { newProfileFrom(p); });
      row.appendChild(dup);
      box.appendChild(row);

      var grid = el("div", "sa-grid");
      var f1 = el("div", "sa-field");
      f1.appendChild(el("div", "sa-label", "子代理 ID"));
      f1.appendChild(el("div", "sa-ro", p.name));
      grid.appendChild(f1);
      var f2 = el("div", "sa-field");
      f2.appendChild(el("div", "sa-label", "显示名称"));
      f2.appendChild(el("div", "sa-ro", p.displayName || p.name));
      grid.appendChild(f2);
      box.appendChild(grid);

      [['描述', p.description], ['系统指令', p.systemPrompt],
       ['工具', (p.tools || []).join(" ") || "none"]].forEach(function (kv) {
        var d = el("div", "sa-field");
        d.appendChild(el("div", "sa-label", kv[0]));
        d.appendChild(el("div", "sa-ro wrap", kv[1] || "—"));
        box.appendChild(d);
      });
      box.appendChild(el("div", "sa-hint",
        "该来源由包/工作区提供，本页不直接写它；要改就「创建副本」存到全局或项目。"));
      right.appendChild(box);
      footStat();
    }

    /* ---- 右栏：可编辑表单 ---- */
    function renderForm(p, isNew) {
      right.innerHTML = "";
      var box = el("div", "sa-card");

      // 头部：作用域 chip + 路径 + 总开关
      var row = el("div", "sa-cardhead");
      row.appendChild(el("span", "scope-chip", p.scope === "project" ? "项目" : "全局"));
      var path = el("span", "sa-path", isNew
        ? (p.scope === "project" ? (S.cwd || "") + "\\.pi\\agents\\" + (p.name || "custom-agent") + ".md" : "~/.pi/agent/agents/" + (p.name || "custom-agent") + ".md")
        : (p.displayPath || p.filePath || ""));
      row.appendChild(path);
      row.appendChild(el("div", "plg-spacer"));
      row.appendChild(switchEl(p.enabled !== false, function (on) { p.enabled = on; }));
      box.appendChild(row);

      // 保存到（全局 / 项目）分段控件
      box.appendChild(el("div", "sa-label", "保存到"));
      var seg = el("div", "seg");
      var bG = el("button", "seg-b" + (p.scope !== "project" ? " on" : ""), "全局");
      var bP = el("button", "seg-b" + (p.scope === "project" ? " on" : ""), "项目");
      bG.addEventListener("click", function () {
        p.scope = "global"; bG.classList.add("on"); bP.classList.remove("on");
        path.textContent = "~/.pi/agent/agents/" + (p.name || "custom-agent") + ".md";
      });
      bP.addEventListener("click", function () {
        p.scope = "project"; bP.classList.add("on"); bG.classList.remove("on");
        path.textContent = (S.cwd || "") + "\\.pi\\agents\\" + (p.name || "custom-agent") + ".md";
      });
      seg.appendChild(bG); seg.appendChild(bP);
      var segWrap = el("div", "sa-segwrap");
      segWrap.appendChild(seg);
      box.appendChild(segWrap);

      // 子代理 ID + 显示名称
      var grid = el("div", "sa-grid");
      var f1 = el("div", "sa-field");
      f1.appendChild(el("div", "sa-label", "子代理 ID"));
      var idIn = el("input", "sa-input");
      idIn.value = p.name || "";
      idIn.disabled = !isNew;   // 改名等于换文件，不允许直接改
      if (!isNew) idIn.classList.add("off");
      idIn.addEventListener("input", function () {
        p.name = idIn.value.trim();
        if (isNew) path.textContent = (p.scope === "project" ? (S.cwd || "") + "\\.pi\\agents\\" : "~/.pi/agent/agents/") + (p.name || "custom-agent") + ".md";
      });
      f1.appendChild(idIn);
      if (!isNew) f1.appendChild(el("div", "sa-hint", "ID 就是文件名，改名请另存为新子代理"));
      grid.appendChild(f1);
      var f2 = el("div", "sa-field");
      f2.appendChild(el("div", "sa-label", "显示名称"));
      var nmIn = el("input", "sa-input");
      nmIn.value = p.displayName || p.name || "";
      nmIn.addEventListener("input", function () { p.displayName = nmIn.value; });
      f2.appendChild(nmIn);
      grid.appendChild(f2);
      box.appendChild(grid);

      var d = el("div", "sa-field");
      d.appendChild(el("div", "sa-label", "描述"));
      var dIn = el("input", "sa-input");
      dIn.value = p.description || "";
      dIn.addEventListener("input", function () { p.description = dIn.value; });
      d.appendChild(dIn);
      box.appendChild(d);

      box.appendChild(el("div", "sa-label", "系统指令"));
      var sIn = el("textarea", "sa-input sa-prompt");
      sIn.value = p.systemPrompt || "";
      sIn.addEventListener("input", function () { p.systemPrompt = sIn.value; });
      box.appendChild(sIn);

      // 工具多选
      box.appendChild(el("div", "sa-label", "工具"));
      var tools = el("div", "sa-tools");
      SA_TOOLS.forEach(function (t) {
        var lab = el("label", "sa-tool");
        var cb = el("input");
        cb.type = "checkbox";
        cb.checked = (p.tools || []).map(function (x) { return x.toLowerCase(); }).indexOf(t) >= 0;
        cb.addEventListener("change", function () {
          var cur = (p.tools || []).filter(function (x) { return x.toLowerCase() !== t; });
          if (cb.checked) cur.push(t);
          p.tools = SA_TOOLS.filter(function (x) { return cur.map(function (y) { return y.toLowerCase(); }).indexOf(x) >= 0; });
        });
        lab.appendChild(cb);
        lab.appendChild(el("span", "", t));
        tools.appendChild(lab);
      });
      box.appendChild(tools);
      box.appendChild(el("div", "sa-hint", (p.tools || []).length ? "当前勾选 " + (p.tools || []).length + " 个工具" : "未勾选任何工具（写入 none）"));

      // 资源：加载技能 / 加载扩展
      box.appendChild(el("div", "sa-label", "资源"));
      var res = el("div", "sa-tools");
      [["loadSkills", "加载技能"], ["loadExtensions", "加载扩展"]].forEach(function (kv) {
        var lab = el("label", "sa-tool");
        var cb = el("input");
        cb.type = "checkbox";
        cb.checked = !!p[kv[0]];
        cb.addEventListener("change", function () { p[kv[0]] = cb.checked; });
        lab.appendChild(cb);
        lab.appendChild(el("span", "", kv[1]));
        res.appendChild(lab);
      });
      box.appendChild(res);

      // 指定模型 / 思考级别 / 最大轮次
      var grid2 = el("div", "sa-grid3");
      var g1 = el("div", "sa-field");
      g1.appendChild(el("div", "sa-label", "指定模型"));
      var msel = el("select", "sa-input");
      var opt0 = el("option", "", "跟随父会话");
      opt0.value = "";
      msel.appendChild(opt0);
      (AG.models || []).forEach(function (m) {
        var o = el("option", "", m.provider + "/" + m.id);
        o.value = m.provider + "/" + m.id;
        msel.appendChild(o);
      });
      // 存的模型不在当前可用列表里也要能显示出来
      if (p.model && !(AG.models || []).some(function (m) { return m.provider + "/" + m.id === p.model || m.id === p.model; })) {
        var o = el("option", "", p.model + "（当前不可用）");
        o.value = p.model;
        msel.appendChild(o);
      }
      msel.value = p.model || "";
      msel.addEventListener("change", function () { p.model = msel.value; });
      g1.appendChild(msel);
      grid2.appendChild(g1);

      var g2 = el("div", "sa-field");
      g2.appendChild(el("div", "sa-label", "思考级别"));
      var tsel = el("select", "sa-input");
      SA_THINK.forEach(function (kv) {
        var o = el("option", "", kv[1]);
        o.value = kv[0];
        tsel.appendChild(o);
      });
      tsel.value = p.thinking || "";
      tsel.addEventListener("change", function () { p.thinking = tsel.value; });
      g2.appendChild(tsel);
      grid2.appendChild(g2);

      var g3 = el("div", "sa-field");
      g3.appendChild(el("div", "sa-label", "最大轮次"));
      var nIn = el("input", "sa-input");
      nIn.type = "number"; nIn.min = "0";
      nIn.value = p.maxTurns ? String(p.maxTurns) : "";
      nIn.addEventListener("input", function () {
        var n = parseInt(nIn.value, 10);
        p.maxTurns = (n > 0) ? n : null;
      });
      g3.appendChild(nIn);
      grid2.appendChild(g3);
      box.appendChild(grid2);

      // 两个布尔
      var flags = el("div", "sa-tools");
      [["inheritContext", "继承父会话上下文"], ["runInBackground", "默认在后台运行"]].forEach(function (kv) {
        var lab = el("label", "sa-tool");
        var cb = el("input");
        cb.type = "checkbox";
        cb.checked = !!p[kv[0]];
        cb.addEventListener("change", function () { p[kv[0]] = cb.checked; });
        lab.appendChild(cb);
        lab.appendChild(el("span", "", kv[1]));
        flags.appendChild(lab);
      });
      box.appendChild(flags);

      if (!(p.writable !== false)) {
        box.appendChild(el("div", "sa-hint", "该来源（.agents/agents）是只读的，换到「全局」或「项目」再保存。"));
      }
      right.appendChild(box);

      // 底部：删除 + 保存
      var del = el("button", "btn btn-danger", "删除");
      del.addEventListener("click", function () {
        if (!p.name) return;
        if (!confirm("确定删除子代理「" + p.name + "」（" + (p.scope === "project" ? "项目" : "全局") + "）？")) return;
        send("agents.delete", { scope: p.scope, name: p.name }).then(function (r) {
          AG.profiles = (r && r.profiles) || [];
          AG.sel = null; AG.view = "detail";
          toasts("已删除 " + p.name);
          render();
        }).catch(function (e) { toasts("删除失败：" + e.message, "error"); });
      });
      var save = el("button", "btn btn-primary", "保存");
      save.addEventListener("click", function () {
        if (!p.name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p.name)) {
          toasts("子代理 ID 只能含字母/数字/._-，且以字母或数字开头", "error"); return;
        }
        save.disabled = true; save.textContent = "保存中…";
        send("agents.save", { scope: p.scope === "project" ? "project" : "global", profile: p }).then(function (r) {
          AG.profiles = (r && r.profiles) || [];
          AG.sel = null; AG.view = "detail";
          toasts("已保存 " + p.name + ".md");
          render();
        }).catch(function (e) {
          toasts("保存失败：" + e.message, "error");
          save.disabled = false; save.textContent = "保存";
        });
      });
      setFoot([el("div", "foot-stat", ""), del, save]);
    }

    function renderRight() {
      if (!AG.sel) {
        right.innerHTML = "";
        right.appendChild(el("div", "hint-box", "左侧选一个子代理，或点左下「+ 新建子代理」创建一个。"));
        footStat();
        return;
      }
      if (AG.sel.scope === "builtin") renderBuiltinDetail(AG.sel);
      else if (AG.sel.scope === "package" || AG.sel.scope === "workspace") renderReadonlyDetail(AG.sel);
      else renderForm(AG.sel, false);
    }

    function newProfileFrom(base) {
      var n = (base && base.name ? base.name + "-copy" : "custom-agent");
      var used = {};
      AG.profiles.forEach(function (p) { used[p.name] = 1; });
      var name = n, i = 2;
      while (used[name]) { name = n + i; i++; }
      AG.sel = {
        name: name,
        displayName: base ? (base.displayName || base.name) : name,
        description: base ? (base.description || "") : "",
        systemPrompt: base ? (base.systemPrompt || "") : "",
        tools: (base && base.tools ? base.tools.slice() : SA_TOOLS.slice()),
        loadSkills: !!(base && base.loadSkills),
        loadExtensions: !!(base && base.loadExtensions),
        thinking: base ? (base.thinking || "") : "",
        maxTurns: base ? (base.maxTurns || null) : null,
        model: base ? (base.model || "") : "",
        inheritContext: !!(base && base.inheritContext),
        runInBackground: !!(base && base.runInBackground),
        promptMode: "append",
        enabled: true,
        scope: "global",
        writable: true
      };
      AG.view = "edit";
      renderList();
      renderForm(AG.sel, true);
    }

    /* ---- 加载 ---- */
    function render() {
      right.innerHTML = "";
      renderHead();
      renderList();
      renderRight();
    }

    addBtn.addEventListener("click", function () { newProfileFrom(null); });

    // 模型下拉用一份当前可用模型列表；pi 没起来就退化到 models.json
    send("models.read", {}).then(function (r) {
      var cfg = (r && r.config) || {};
      var out = [];
      Object.keys(cfg.providers || {}).forEach(function (k) {
        ((cfg.providers[k] || {}).models || []).forEach(function (m) {
          out.push({ provider: k, id: m.id || m.name || "" });
        });
      });
      AG.models = out;
      agentsLoad();
    }).catch(function () { agentsLoad(); });

    function agentsLoad() {
      right.innerHTML = "";
      right.appendChild(el("div", "hint-box", "正在读取子代理配置…"));
      send("agents.list", {}).then(function (r) {
        AG.profiles = (r && r.profiles) || [];
        AG.settings = (r && r.settings) || AG.settings;
        AG.enabled = !!(AG.settings && AG.settings.enabled);
        var first = null;
        if (want === "new") {
          // ?open=agents:new —— 截图/验收直接落到「新建子代理」表单
          agentsLoad();
          newProfileFrom(null);
          return;
        }
        if (want) {
          first = AG.profiles.filter(function (p) { return p.name === want; })[0] || null;
        }
        if (!first && !AG.sel) {
          first = AG.profiles.filter(function (p) { return p.scope === "builtin"; })[0] || AG.profiles[0];
        }
        if (!AG.sel && first) AG.sel = first;
        else if (AG.sel) AG.sel = byName(AG.sel.name) || AG.sel;
        render();
      }).catch(function (e) {
        right.innerHTML = "";
        right.appendChild(el("div", "hint-box", "读取子代理失败：" + e.message));
      });
    }
  }

  /* ---------------- 分页 5：插件 ---------------- */
  /* ---------------- 分页 5：插件 ---------------- */
  // 对应 pi-web 的 /api/plugins：左侧「扩展（独立）+ GLOBAL（npm/git 包）」两组，
  // 右侧详情，底部统计 + 检查更新/刷新；左下「+ 添加插件」切到添加态。
  function renderExtensions(body) {
    var wrap = el("div", "split");
    var left = el("div", "split-left");
    var right = el("div", "split-right");
    var list = el("div", "split-list");
    left.appendChild(list);
    var foot = el("div", "split-foot");
    var addBtn = el("button", "btn btn-block btn-ghost", "+ 添加插件");
    foot.appendChild(addBtn);
    left.appendChild(foot);
    wrap.appendChild(left); wrap.appendChild(right);
    body.appendChild(wrap);

    var PLG = { data: null, view: "detail", sel: null, updates: {} };

    /* 更新检查结果：按「scope|source」建索引，列表徽标、详情状态行、底部按钮都读它。
       底部按钮查全部（对齐 pi-web 的 checkForUpdates() 无参分支），详情按钮只查当前包。 */
    function upKey(scope, source) { return (scope || "") + "|" + (source || ""); }
    function updOf(p) { return PLG.updates[upKey(p.scope, p.source)] || null; }
    function availList() {
      return Object.keys(PLG.updates).map(function (k) { return PLG.updates[k]; })
        .filter(function (u) { return u.state === "update-available"; });
    }
    function availCount() { return availList().length; }
    function updText(u) {
      if (!u) return "";
      if (u.state === "update-available") return u.message ? "可更新：" + u.message : "有新版本";
      if (u.state === "up-to-date") return "已是最新";
      if (u.state === "unsupported") return "无法自动检查：" + (u.message || "版本已钉死或本地路径");
      return "检查失败：" + (u.message || u.state);
    }
    function summarize(us) {
      var ok = 0, avail = [], bad = [];
      us.forEach(function (u) {
        if (u.state === "update-available") avail.push(u);
        else if (u.state === "up-to-date") ok++;
        else bad.push(u);
      });
      var parts = [ok + " 个已是最新"];
      if (avail.length) parts.push(avail.length + " 个可更新：" + avail.map(function (u) { return u.displayName + (u.message ? " " + u.message : ""); }).join("、"));
      if (bad.length) parts.push(bad.length + " 个没查成：" + bad.map(function (u) { return u.displayName + "（" + (u.message || u.state) + "）"; }).join("、"));
      return { ok: ok, avail: avail, bad: bad, text: parts.join(" · ") };
    }
    /* source 为空 = 查全部可检查包；给了 source 只查这一个（其余结果保留）。 */
    function runCheck(source, btn, idleText) {
      var args = { cwd: S.cwd || "" };
      if (source) args.source = source;
      if (btn) { btn.disabled = true; btn.textContent = "检查中…"; }
      return send("plugins.check", args).then(function (r) {
        var us = (r && r.updates) || [];
        if (!source) PLG.updates = {};
        us.forEach(function (u) { PLG.updates[upKey(u.scope, u.source)] = u; });
        renderList(); renderRight(); renderFoot();
        var s = summarize(us);
        if (!us.length) toasts("没有可检查更新的插件（都是钉死版本或本地路径）");
        else toasts(s.text, s.bad.length && !s.avail.length ? "warn" : "");
        return s;
      }).catch(function (e) {
        toasts("检查更新失败：" + e.message, "error");
        if (btn) { btn.disabled = false; btn.textContent = idleText || "检查更新"; }
      });
    }
    /* 逐个更新可更新的包（pi-web 的 updateAllPluginsAction 等价物）。 */
    function updateAll(btn) {
      var targets = availList();
      if (!targets.length) return;
      var done = 0, failed = [];
      function step() {
        if (btn) btn.textContent = "更新中… " + Math.min(done + 1, targets.length) + "/" + targets.length;
        if (done >= targets.length) {
          var n = targets.length - failed.length;
          return load().then(function () {
            if (failed.length) toasts(n + " 个已更新 · " + failed.length + " 个失败：" + failed.join("；"), "warn");
            else toasts(n + " 个插件已更新");
          });
        }
        var t = targets[done];
        return send("plugins.action", { action: "update", source: t.source, scope: t.scope, cwd: S.cwd || "" })
          .then(function (r) { PLG.data = r; delete PLG.updates[upKey(t.scope, t.source)]; })
          .catch(function (e) { failed.push(t.displayName + "（" + e.message + "）"); })
          .then(function () { done++; return step(); });
      }
      if (btn) btn.disabled = true;
      step();
    }

    function keyOf(it) { return it.kind === "ext" ? "ext:" + it.data.path : "pkg:" + it.data.scope + ":" + it.data.source; }

    function flat() {
      var d = PLG.data || {};
      var out = [];
      (d.standaloneExtensions || []).forEach(function (e) { out.push({ kind: "ext", data: e }); });
      (d.packages || []).forEach(function (p) { out.push({ kind: "pkg", data: p }); });
      return out;
    }

    function firstKey() {
      var f = flat();
      return f.length ? keyOf(f[0]) : null;
    }

    var STATUS_CN = { loaded: "已加载", installed: "已安装", disabled: "已禁用", missing: "缺失" };

    function renderList() {
      list.innerHTML = "";
      var d = PLG.data || {};
      var exts = d.standaloneExtensions || [];
      var pkgs = d.packages || [];

      function addItem(it, on) {
        var b = el("div", "li" + (PLG.view === "detail" && PLG.sel === keyOf(it) ? " on" : ""));
        var t = el("div", "t");
        t.appendChild(el("span", on ? "dot-on" : "dot-off"));
        var nm = it.kind === "ext" ? it.data.name : (it.data.displayName || it.data.source);
        var sp = el("span", "nm", nm);
        sp.title = it.data.source || it.data.path || "";
        t.appendChild(sp);
        b.appendChild(t);
        if (it.kind === "pkg") {
          var u = updOf(it.data);
          if (u) {
            var bg = el("span", "upd-badge " + (u.state === "update-available" ? "avail" : u.state === "up-to-date" ? "ok" : "bad"),
              u.state === "update-available" ? "↑ 新版" : u.state === "up-to-date" ? "✓ 最新" : "!");
            bg.title = updText(u);
            b.appendChild(bg);
          }
        }
        b.addEventListener("click", function () {
          PLG.view = "detail"; PLG.sel = keyOf(it);
          renderList(); renderRight();
        });
        list.appendChild(b);
      }

      if (exts.length) {
        list.appendChild(el("div", "grp", "扩展"));
        exts.forEach(function (e) { addItem({ kind: "ext", data: e }, e.enabled !== false); });
      }
      var g = pkgs.filter(function (p) { return p.scope === "project"; });
      var gl = pkgs.filter(function (p) { return p.scope !== "project"; });
      if (gl.length) {
        list.appendChild(el("div", "grp", "全局"));
        gl.forEach(function (p) { addItem({ kind: "pkg", data: p }, p.status === "loaded"); });
      }
      if (g.length) {
        list.appendChild(el("div", "grp plg-proj", "项目"));
        g.forEach(function (p) { addItem({ kind: "pkg", data: p }, p.status === "loaded"); });
      }
      if (!exts.length && !pkgs.length) list.appendChild(el("div", "empty", "还没有安装任何插件"));
    }

    function renderFoot() {
      var d = PLG.data;
      if (!d) { setFoot([]); return; }
      var t = d.totals || {};
      var txt = [
        (t.extensions || 0) + " 插件",
        (t.skills || 0) + " 技能",
        (t.prompts || 0) + " 提示词",
        (t.themes || 0) + " 主题"
      ].join(" · ");
      var navail = availCount();
      var ck = el("button", "btn" + (navail ? " btn-upd" : ""), navail ? ("全部更新 (" + navail + ")") : "检查更新");
      ck.title = navail ? "逐个更新可更新的插件" : "检查全部可检查的包（含项目级）";
      ck.addEventListener("click", function () {
        if (availCount()) { updateAll(ck); return; }
        runCheck("", ck, "检查更新");
      });
      var rf = el("button", "btn", "刷新");
      rf.addEventListener("click", function () { load().then(function () { toasts("已刷新"); }); });
      var c = el("div", "foot-stat", txt);
      setFoot([c, ck, rf]);
    }

    /* ---- 状态 2：添加插件 ---- */
    function renderAdd() {
      right.innerHTML = "";
      var head = el("div", "split-head plg-addhead");
      head.appendChild(el("div", "ttl", "添加插件"));
      var link = el("a", "plg-doc", "pi.dev/packages");
      link.href = "https://pi.dev/packages";
      link.target = "_blank";
      head.appendChild(link);
      right.appendChild(head);
      right.appendChild(el("div", "hint", "~/.pi/agent/{npm,git}"));

      var srcWrap = el("div", "plg-field");
      srcWrap.appendChild(el("div", "plg-label", "来源"));
      var input = el("input", "plg-input");
      input.placeholder = "npm:@scope/package";
      srcWrap.appendChild(input);
      right.appendChild(srcWrap);

      var scope = "global";
      var scopeWrap = el("div", "plg-scopeline");
      var seg = el("div", "seg");
      var bG = el("button", "seg-b on", "全局");
      var bP = el("button", "seg-b", "项目");
      bG.addEventListener("click", function () { scope = "global"; bG.classList.add("on"); bP.classList.remove("on"); });
      bP.addEventListener("click", function () { scope = "project"; bP.classList.add("on"); bG.classList.remove("on"); });
      seg.appendChild(bG); seg.appendChild(bP);
      var go = el("button", "btn btn-primary", "安装");
      go.addEventListener("click", function () {
        var s = input.value.trim();
        if (!s) { toasts("请填写来源", "warn"); return; }
        go.disabled = true; go.textContent = "安装中…";
        send("plugins.action", { action: "install", source: s, scope: scope, cwd: S.cwd || "" })
          .then(function (r) {
            PLG.data = r; PLG.view = "detail"; PLG.sel = "pkg:" + scope + ":" + s;
            renderList(); renderRight(); renderFoot();
            toasts("已安装 " + s);
          })
          .catch(function (e) { toasts("安装失败：" + e.message, "error"); })
          .then(function () { go.disabled = false; go.textContent = "安装"; });
      });
      scopeWrap.appendChild(seg);
      var sp = el("div", "plg-spacer");
      scopeWrap.appendChild(sp);
      scopeWrap.appendChild(go);
      right.appendChild(scopeWrap);

      right.appendChild(el("div", "plg-label plg-exlabel", "示例"));
      ["npm:@scope/pi-plugin", "git:https://github.com/user/repo", "/absolute/path/to/plugin"].forEach(function (ex) {
        var i = el("input", "plg-input plg-ex");
        i.placeholder = ex;
        i.addEventListener("focus", function () { if (!input.value) input.value = ""; });
        right.appendChild(i);
      });
    }

    /* ---- 状态 1：详情 ---- */
    function renderRight() {
      if (PLG.view === "add") { renderAdd(); return; }
      right.innerHTML = "";
      var items = flat();
      var it = null;
      for (var i = 0; i < items.length; i++) if (keyOf(items[i]) === PLG.sel) it = items[i];
      if (!it) {
        if (!items.length) { renderAdd(); return; }
        it = items[0]; PLG.sel = keyOf(it); renderList();
      }
      var d = it.data;

      var head = el("div", "split-head");
      head.appendChild(el("span", "scope-chip", it.kind === "ext" ? scopeZh(d.scope || "global") : scopeZh(d.scope)));
      head.appendChild(el("div", "ttl", it.kind === "ext" ? d.name : (d.displayName || d.source)));
      right.appendChild(head);

      var dl = el("dl", "kv");
      function row(k, v) { dl.appendChild(el("dt", "", k)); dl.appendChild(el("dd", "", v == null || v === "" ? "—" : String(v))); }

      if (it.kind === "ext") {
        row("状态", STATUS_CN[d.enabled === false ? "disabled" : "loaded"]);
        row("安装路径", d.path);
        var act = el("div", "plg-actions");
        var sw = el("div", "sw" + (d.enabled === false ? "" : " on"));
        var lb = el("span", "plg-swlabel", d.enabled === false ? "已禁用" : "已启用");
        sw.addEventListener("click", function () {
          var on = !sw.classList.contains("on");
          send("plugins.action", { action: "toggleExtension", source: (on ? "+" : "-") + d.path, scope: d.scope || "global", cwd: S.cwd || "" })
            .then(function (r) { PLG.data = r; renderList(); renderRight(); renderFoot(); toasts(on ? "已启用" : "已禁用"); })
            .catch(function (e) { toasts("操作失败：" + e.message, "error"); });
        });
        act.appendChild(sw); act.appendChild(lb);
        right.appendChild(dl);
        right.appendChild(act);
      } else {
        row("状态", STATUS_CN[d.status] || d.status);
        row("安装路径", d.installedPathShort || d.installedPath);
        row("来源", d.source);
        if (d.version) row("版本", d.version);
        if (d.configuredVersion && d.configuredVersion !== d.version) row("配置版本", d.configuredVersion);
        var c = d.counts || {};
        row("资源", (c.extensions || 0) + " 个扩展 · " + (c.skills || 0) + " 个技能 · " + (c.prompts || 0) + " 个提示词 · " + (c.themes || 0) + " 个主题");
        var u0 = updOf(d);
        row("更新状态", u0 ? updText(u0) : (d.canCheckForUpdates ? "未检查" : "无法自动检查（版本已钉死或本地路径）"));
        right.appendChild(dl);

        var act2 = el("div", "plg-actions");
        var sw2 = el("div", "sw" + (d.status === "disabled" ? "" : " on"));
        var lb2 = el("span", "plg-swlabel", d.status === "disabled" ? "已禁用" : "已启用");
        sw2.addEventListener("click", function () {
          var on = !sw2.classList.contains("on");
          send("plugins.action", { action: on ? "enable" : "disable", source: d.source, scope: d.scope, cwd: S.cwd || "" })
            .then(function (r) { PLG.data = r; renderList(); renderRight(); renderFoot(); toasts(on ? "已启用" : "已禁用"); })
            .catch(function (e) { toasts("操作失败：" + e.message, "error"); });
        });
        var up = el("button", "btn", "更新");
        up.addEventListener("click", function () {
          up.disabled = true; up.textContent = "更新中…";
          send("plugins.action", { action: "update", source: d.source, scope: d.scope, cwd: S.cwd || "" })
            .then(function (r) { PLG.data = r; renderList(); renderRight(); renderFoot(); toasts("已更新 " + d.source); })
            .catch(function (e) { toasts("更新失败：" + e.message, "error"); })
            .then(function () { up.disabled = false; up.textContent = "更新"; });
        });
        var rm = el("button", "btn btn-danger", "卸载");
        rm.addEventListener("click", function () {
          rm.disabled = true; rm.textContent = "卸载中…";
          send("plugins.action", { action: "remove", source: d.source, scope: d.scope, cwd: S.cwd || "" })
            .then(function (r) {
              PLG.data = r; PLG.sel = firstKey();
              renderList(); renderRight(); renderFoot();
              toasts("已卸载 " + d.source);
            })
            .catch(function (e) { toasts("卸载失败：" + e.message, "error"); })
            .then(function () { rm.disabled = false; rm.textContent = "卸载"; });
        });
        act2.appendChild(sw2); act2.appendChild(lb2);
        act2.appendChild(el("div", "plg-spacer"));
        if (d.canCheckForUpdates) {
          var ck1 = el("button", "btn", "检查更新");
          ck1.title = "只检查这一个包";
          ck1.addEventListener("click", function () { runCheck(d.source, ck1, "检查更新"); });
          act2.appendChild(ck1);
        }
        act2.appendChild(up); act2.appendChild(rm);
        right.appendChild(act2);

        if (d.status === "missing") {
          var fix = el("button", "btn", "安装");
          fix.addEventListener("click", function () {
            fix.disabled = true; fix.textContent = "安装中…";
            send("plugins.action", { action: "install", source: d.source, scope: d.scope, cwd: S.cwd || "" })
              .then(function (r) { PLG.data = r; renderList(); renderRight(); renderFoot(); toasts("已安装"); })
              .catch(function (e) { toasts("安装失败：" + e.message, "error"); })
              .then(function () { fix.disabled = false; fix.textContent = "安装"; });
          });
          right.appendChild(fix);
        }
      }
    }

    addBtn.addEventListener("click", function () {
      if (PLG.view === "add") { PLG.view = "detail"; addBtn.classList.remove("on"); }
      else { PLG.view = "add"; addBtn.classList.add("on"); }
      renderList(); renderRight();
    });

    function load() {
      return send("plugins.list", { cwd: S.cwd || "" }).then(function (r) {
        PLG.data = r || {};
        if (!PLG.sel) PLG.sel = firstKey();
        renderList(); renderRight(); renderFoot();
        return r;
      }, function (e) {
        toasts("读取插件失败：" + e.message, "error");
        right.innerHTML = "";
        right.appendChild(el("div", "hint-box", "读取插件失败：" + e.message));
      });
    }

    load();
  }

  /* ================= 选中文字提问浮窗 ================= */
  // 用 mouseup 而不是 selectionchange：后者在拖选/收起选区时都会报，
  // 会在用户还没选完时就弹。mouseup 才对应“选完了”。
  function bindSelectionPopup() {
    var pop = $("sel-pop");
    if (!pop) return;

    function placeAndShow(sel) {
      var r0 = sel.rangeCount ? sel.getRangeAt(0) : null;
      // 文字取 range 的 toString，不用 String(sel)：文档没焦点时（无头自检里就是这样）
      // Chromium 会让 selection.toString() 返回空串，但 range 本身有文字。
      var text = String(r0 ? r0.toString() : sel).trim();
      var inModal = $("modal") && !$("modal").hidden;
      if (!S.selectionPopup || text.length < 2 || inModal || !r0) {
        pop.hidden = true;
        return;
      }
      var r = r0.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) { pop.hidden = true; return; }
      pop.textContent = "就此提问";
      pop.style.left = Math.max(8, Math.min(window.innerWidth - 80, r.left + r.width / 2 - 34)) + "px";
      pop.style.top = Math.max(8, r.top - 30) + "px";
      pop.hidden = false;
      pop.onmousedown = function (e) {
        e.preventDefault();
        $("input").value = '关于这段内容：\n\n"' + text.slice(0, 500) + '"\n\n';
        $("input").focus();
        pop.hidden = true;
      };
    }

    function onUp() {
      var sel = window.getSelection();
      // 等一帧：programmatic 选区和拖选结束都在本次事件后才有稳定的 rect
      setTimeout(function () { placeAndShow(sel); }, 0);
    }
    document.addEventListener("mouseup", onUp);
    // 键盘选择（Shift+方向键）不以 mouseup 结尾，用 keyup 兜底
    document.addEventListener("keyup", function (e) {
      if (e.shiftKey || e.key === "Shift") onUp();
    });
    document.addEventListener("mousedown", function (e) {
      if (!pop.hidden && e.target !== pop) pop.hidden = true;
    });
    document.addEventListener("scroll", function () { pop.hidden = true; }, true);
  }

  /* ================= 上传 ================= */
  // 网页侧读文件成 base64 发给 Rust 落盘（WebView2 里没有直接写文件的权限）。
  function uploadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    var dir = S.cwd || "~";
    var done = 0;
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onerror = function () { reject(new Error("读文件失败: " + f.name)); };
          fr.onload = function () {
            var b64 = String(fr.result).split(",")[1] || "";
            send("fs.write", { dir: dir, name: f.name, dataBase64: b64 }).then(resolve, reject);
          };
          fr.readAsDataURL(f);
        }).then(function (r) {
          done++;
          toasts("已上传 " + r.name + " (" + fmtNum(r.size) + ")");
        }, function (e) {
          toasts("上传失败 " + f.name + ": " + e.message, "error");
        });
      });
    });
    chain.then(function () {
      if (done) {
        toasts("共上传 " + done + " 个文件到 " + dir);
        loadTree(dir);
      }
    });
  }

  /* ================= 顶栏按钮 ================= */
  function refreshState() {
    return send("pi.call", { type: "get_state" }).then(function (r) {
      if (!r.success) return;
      S.model = r.data.model;
      // 活会话（pi 子进程正在跑的那条）与「用户点开在看的那条」是两回事：
      // 之前混用一个字段，导致打开历史会话后一刷新就被活会话顶掉（面板里的
      // 消息数/Token 全 0、项目目录也跑到 pi 进程的 cwd）。这里分开存。
      var prevLive = S.liveSession;
      S.liveSession = r.data.sessionFile || null;
      if (!S.activeSession || S.activeSession === prevLive) S.activeSession = S.liveSession;
      // 会话标题的唯一可靠来源：当前会话用 pi 实时报的 sessionName，
      // 其余会话用索引/首条消息的。索引是别的进程写的，拿到的新名字不一定落盘。
      if (r.data.sessionName) S.sessionName = r.data.sessionName;
      S.streaming = !!r.data.isStreaming;
      if (r.data.thinkingLevel) S.thinkLevel = r.data.thinkingLevel;
      renderModelBtn();
      $("st-left").textContent = S.streaming ? "● 正在运行" : "· 空闲";
      updateRunState();
      renderSessions();
      return refreshStats();
    });
  }

  function generateTitle() {
    // 优先级：最后一条 assistant 正文 > 第一条 user 正文。
    // 实测很多回合末条只有 thinking/工具块，text 为空，得回退到用户首句。
    return send("pi.call", { type: "get_last_assistant_text" }).then(function (r) {
      var t = (r.data && r.data.text) || "";
      if (t) return t;
      return send("pi.call", { type: "get_messages" }).then(function (ms) {
        var m = (ms.data && ms.data.messages) || [];
        for (var i = 0; i < m.length; i++) {
          if (m[i].role !== "user") continue;
          var c = m[i].content;
          if (typeof c === "string" && c.trim()) return c;
          if (c && c.length) {
            for (var j = 0; j < c.length; j++) {
              if (c[j] && c[j].type === "text" && c[j].text) return c[j].text;
            }
          }
        }
        return "";
      });
    }).then(function (t) {
      var name = t ? t.replace(/\s+/g, " ").trim().slice(0, 24) : "新会话";
      return send("pi.call", { type: "set_session_name", params: { name: name } })
        .then(function (res) {
          res = res || {};
          res._name = name;
          return res;
        });
    }).then(function (res) {
      toasts("已生成标题");
      // set_session_name 只改 pi 进程内的名字，索引文件由 pi 自己落盘，可能滞后。
      // 所以先向 pi 要一次实时状态，把新名字立刻显示出来，再刷会列表。
      return refreshState()
        .then(loadSessions)
        .then(function () { return res; });
    }).catch(function (e) { toasts(e.message, "error"); throw e; });
  }

  function showSystem() {
    return send("pi.call", { type: "get_state" }).then(function (r) {
      var d = r.data || {};
      var txt = [
        "会话 ID: " + (d.sessionId || "—"),
        "会话名: " + (d.sessionName || "—"),
        "会话文件: " + (d.sessionFile || "—"),
        "模型: " + (d.model ? d.model.name + " (" + d.model.id + ")" : "—"),
        "服务商: " + (d.model ? d.model.provider : "—"),
        "上下文窗口: " + (d.model ? fmtNum(d.model.contextWindow) : "—"),
        "思考等级: " + (d.thinkingLevel || "—"),
        "引导模式: " + (d.steeringMode || "—"),
        "后续模式: " + (d.followUpMode || "—"),
        "自动压缩: " + (d.autoCompactionEnabled ? "开" : "关"),
        "消息数: " + (d.messageCount || 0),
        "运行中: " + (d.isStreaming ? "是" : "否")
      ].join("\n");
      toasts("系统信息已输出到消息流");
      var node = newMessageEl("assistant");
      node.body.innerHTML = "<pre><code>" + esc(txt) + "</code></pre>";
    });
  }

  function showTools() {
    return send("pi.call", { type: "get_session_stats" }).then(function (r) {
      var d = r.data || {};
      var txt = [
        "工具调用: " + (d.toolCalls || 0),
        "工具结果: " + (d.toolResults || 0),
        "用户消息: " + (d.userMessages || 0),
        "助手消息: " + (d.assistantMessages || 0),
        "总消息: " + (d.totalMessages || 0),
        "",
        "用量: 入 " + fmtNum(d.tokens && d.tokens.input) +
          " / 出 " + fmtNum(d.tokens && d.tokens.output) +
          " / 缓存读 " + fmtNum(d.tokens && d.tokens.cacheRead),
        "上下文: " + ((d.contextUsage && d.contextUsage.percent) || 0) + "% / " +
          fmtNum(d.contextUsage && d.contextUsage.contextWindow),
        "成本: " + (d.cost || 0)
      ].join("\n");
      var node = newMessageEl("assistant");
      node.body.innerHTML = "<pre><code>" + esc(txt) + "</code></pre>";
    });
  }

  function showHistory() {
    return send("pi.call", { type: "get_entries" }).then(function (r) {
      var es = (r.data && r.data.entries) || [];
      var node = newMessageEl("assistant");
      var lines = es.map(function (e) {
        var role = (e.message && e.message.role) || e.type;
        var txt = "";
        if (e.message) {
          if (typeof e.message.content === "string") txt = e.message.content;
          else if (Array.isArray(e.message.content)) {
            txt = e.message.content.filter(function (c) { return c.type === "text"; })
              .map(function (c) { return c.text; }).join(" ");
          }
        }
        return e.id + "  [" + role + "]  " + txt.replace(/\s+/g, " ").slice(0, 90);
      });
      node.body.innerHTML = "<p>会话共 " + es.length + " 条条目（含压缩前历史）：</p><pre><code>" +
        esc(lines.join("\n")) + "</code></pre>";
      scrollDown(true);
    });
  }

  /* ================= 斜杠命令面板 =================
     版式对齐参考实现：顶部「斜杠命令 · N 个命令」+ 右上 Tab / Enter，正文按
     内置 / 扩展 / 提示词 / 技能 分组，每组三列卡片网格。
     数据两个来源：
       1) 内置 6 条，行为在本文件里直接落地（compact 走 pi RPC，reload 重启 pi 子进程，
          session 打开用量详情面板，copy 读最后一条助手回复，name 写会话名，clone 派生子会话）；
       2) 扩展 / 提示词 / 技能来自 pi 的 get_commands，选中只填进输入框，
          由 pi 自己在 prompt 里解析参数，不在这里猜语义。
     键盘：/ 触发 · ↑↓ / Tab 移动 · Enter 选中 · Esc 关闭。
     鼠标：卡片可点。卡片的 mousedown 被挡掉，否则点一下输入框先失焦、面板先关。 */
  var SLASH_BUILTINS = [
    { name: "clone", source: "builtin", description: "将当前分支复制为独立新会话" },
    { name: "compact", source: "builtin", description: "压缩上下文，可选附加说明" },
    { name: "copy", source: "builtin", description: "复制最后一条助手消息" },
    { name: "name", source: "builtin", description: "设置会话显示名称" },
    { name: "reload", source: "builtin", description: "重新加载扩展、技能、提示词和工具" },
    { name: "session", source: "builtin", description: "显示会话消息、Token 和费用统计" }
  ];
  var SLASH_GROUPS = [
    ["builtin", "内置"],
    ["extension", "扩展"],
    ["prompt", "提示词"],
    ["skill", "技能"]
  ];
  var SLASH = { all: null, loading: null, items: [], nodes: [], cur: 0, query: null };

  function slashDesc(it) { return it.description ? String(it.description) : ""; }

  /* 输入框里正在敲的命令名：只有「/ 开头且后面还没敲空格」才算在过滤。
     出现空格就是开始写参数了，面板让位，回车按普通流程走。 */
  function slashQuery() {
    var m = /^\/([A-Za-z0-9_:\-]*)$/.exec($("input").value);
    return m ? m[1].toLowerCase() : null;
  }

  function closeSlashPalette() {
    var p = $("slash-pop");
    if (!p || p.hidden) return;
    p.hidden = true;
    SLASH.query = null;
    SLASH.nodes = [];
  }

  function loadSlashCommands() {
    if (SLASH.all) return Promise.resolve(SLASH.all);
    if (SLASH.loading) return SLASH.loading;
    SLASH.loading = send("pi.call", { type: "get_commands" })
      .then(function (r) {
        var cs = (r && r.data && r.data.commands) || [];
        SLASH.all = cs.filter(function (c) { return c && c.name; }).map(function (c) {
          return {
            name: String(c.name),
            description: c.description || "",
            source: c.source || "extension"
          };
        });
        return SLASH.all;
      })
      .catch(function (e) {
        SLASH.loading = null;   // 失败允许下次再试
        toasts("命令列表读取失败：" + ((e && e.message) || e), "error");
        return [];
      });
    return SLASH.loading;
  }

  function renderSlashPalette() {
    var body = $("slash-body");
    var q = SLASH.query || "";
    var items = SLASH_BUILTINS.concat(SLASH.all || []).filter(function (it) {
      // 只按命令名过滤：描述里带 comp 的命令（acp-decompress、compress…）一堆，
      // 带上描述搜会把结果冲成十几张卡片，反而找不到想敲的那条。
      if (!q) return true;
      return it.name.toLowerCase().indexOf(q) >= 0;
    });
    SLASH.items = items;
    SLASH.nodes = [];
    body.innerHTML = "";
    $("slash-title").textContent = "斜杠命令 · " + items.length + " 个命令";
    if (!items.length) {
      body.appendChild(el("div", "slash-empty", "无匹配命令"));
      return;
    }
    var idx = 0;
    SLASH_GROUPS.forEach(function (g) {
      var list = items.filter(function (it) { return it.source === g[0]; });
      if (!list.length) return;
      var sec = el("div", "slash-sec");
      sec.appendChild(el("span", "", g[1]));
      sec.appendChild(el("span", "n", String(list.length)));
      body.appendChild(sec);
      var grid = el("div", "slash-grid");
      list.forEach(function (it) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "slash-item";
        btn.appendChild(el("span", "nm", "/" + it.name));
        btn.appendChild(el("span", "ds", slashDesc(it) || "—"));
        btn.title = "/" + it.name + (it.source === "builtin" ? "" : "（" + it.source + " 命令）");
        var mine = idx++;
        btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
        btn.addEventListener("click", function () { applySlashItem(mine); });
        grid.appendChild(btn);
        SLASH.nodes.push(btn);
      });
      body.appendChild(grid);
    });
    if (SLASH.cur > items.length - 1) SLASH.cur = items.length - 1;
    if (SLASH.cur < 0) SLASH.cur = 0;
    markSlashCur();
  }

  function markSlashCur() {
    for (var i = 0; i < SLASH.nodes.length; i++) {
      SLASH.nodes[i].classList.toggle("on", i === SLASH.cur);
    }
    var n = SLASH.nodes[SLASH.cur];
    if (n && n.scrollIntoView) n.scrollIntoView({ block: "nearest" });
  }

  /* 输入变化时同步面板。命令表是懒加载的：第一次弹面板要等 get_commands 回来，
     回来时如果输入框已经变了就丢弃这次渲染，避免闪一下旧结果。 */
  function syncSlash() {
    var q = slashQuery();
    if (q === null) { closeSlashPalette(); return; }
    if ($("slash-pop").hidden !== false) SLASH.cur = 0;
    closeChipPop();
    closeModelPop();
    if (SLASH.query !== q) SLASH.cur = 0;   // 命令名一变，高亮回第一条
    SLASH.query = q;
    loadSlashCommands().then(function () {
      if (slashQuery() !== SLASH.query) return;
      renderSlashPalette();
      $("slash-pop").hidden = false;
    });
  }

  function moveSlash(d) {
    if (!SLASH.items.length) return;
    SLASH.cur = Math.max(0, Math.min(SLASH.items.length - 1, SLASH.cur + d));
    markSlashCur();
  }

  /* 键盘在面板上时先吃掉按键；返回 true 表示这条已经处理，别再走回车发送 */
  function slashKeys(e) {
    var p = $("slash-pop");
    if (!p || p.hidden) return false;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault(); moveSlash(1); return true;
    }
    if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault(); moveSlash(-1); return true;
    }
    if (e.key === "Escape") {
      e.preventDefault(); closeSlashPalette(); return true;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && SLASH.items.length) {
      // 有候选项就先把选中项填进输入框（/name、/compact 还要接参数，不直接跑）
      e.preventDefault();
      applySlashItem(SLASH.cur);
      return true;
    }
    return false;
  }

  function applySlashItem(i) {
    var it = SLASH.items[i];
    if (!it) return;
    var ta = $("input");
    // 不吃参数的四条直接执行，省一次回车
    var bare = it.source === "builtin" && ["clone", "copy", "reload", "session"].indexOf(it.name) >= 0;
    if (bare) {
      ta.value = "";
      ta.style.height = "auto";
      closeSlashPalette();
      runBuiltinSlash(it.name, "");
      return;
    }
    ta.value = "/" + it.name + " ";
    ta.focus();
    ta.style.height = "auto";
    closeSlashPalette();
    if (it.source !== "builtin") toasts("已插入 /" + it.name + "，补完参数后回车");
  }

  /* 回车时整条就是内置命令（/name 张三、/compact 只留结论）→ 就地执行，不发成 prompt */
  function builtinFromInput() {
    var m = /^\/([A-Za-z0-9_:\-]+)(?:\s+([\s\S]*))?$/.exec($("input").value.trim());
    if (!m) return null;
    for (var i = 0; i < SLASH_BUILTINS.length; i++) {
      if (SLASH_BUILTINS[i].name === m[1]) return { name: m[1], arg: (m[2] || "").trim() };
    }
    return null;
  }

  function runBuiltinSlash(name, arg) {
    if (name === "compact") {
      if (S.streaming) { toasts("运行中不能压缩上下文", "warn"); return Promise.resolve(); }
      $("chip-compact").disabled = true;
      toasts("正在压缩上下文…");
      return send("pi.call", { type: "compact", params: arg ? { customInstructions: arg } : {} })
        .then(function (r) { if (!r || !r.success) throw new Error((r && r.error) || "压缩失败"); })
        .catch(function (e) { toasts((e && e.message) || "压缩失败", "error"); })
        .then(function () {
          $("chip-compact").disabled = !!S.streaming;
          return refreshStats();
        });
    }
    if (name === "session") { openStatsPop(); return Promise.resolve(); }
    if (name === "copy") {
      return send("pi.call", { type: "get_last_assistant_text" })
        .then(function (r) {
          var t = (r && r.data && r.data.text) || "";
          if (!t.trim()) { toasts("还没有可复制的助手回复", "warn"); return; }
          copyText(t);
          toasts("已复制最后一条助手消息（" + t.length + " 字）");
        })
        .catch(function (e) { toasts("复制失败：" + ((e && e.message) || e), "error"); });
    }
    if (name === "name") {
      if (!arg) { toasts("用法：/name 会话名称", "warn"); return Promise.resolve(); }
      return send("pi.call", { type: "set_session_name", params: { name: arg } })
        .then(function () { toasts("会话名称：" + arg); return refreshState(); })
        .then(loadSessions)
        .catch(function (e) { toasts("改名失败：" + ((e && e.message) || e), "error"); });
    }
    /* pi 没有 reload 这个 RPC，重新加载扩展/技能/提示词只能重启子进程，
       重启后不接回会话就成空白新会话，看着像记录被清了 —— 和切工具预设同一条路子。 */
    if (name === "reload") {
      if (S.streaming) { toasts("运行中不能重新加载，请先停止", "warn"); return Promise.resolve(); }
      var back = S.liveSession || S.activeSession;
      toasts("正在重新加载…");
      return send("pi.restart")
        .then(function () {
          SLASH.all = null; SLASH.loading = null;   // 命令集可能变了
          if (!back) { S.liveSession = null; return null; }
          return send("pi.call", { type: "switch_session", params: { sessionPath: back } })
            .then(function () { S.liveSession = back; });
        })
        .then(function () { return rebuildFromMessages(); })
        .then(function () { return refreshState(); })
        .then(function () { toasts("已重新加载扩展、技能、提示词（pi 已重启）"); })
        .catch(function (e) { toasts("重新加载失败：" + ((e && e.message) || e), "error"); });
    }
    if (name === "clone") {
      if (S.streaming) { toasts("运行中不能克隆分支", "warn"); return Promise.resolve(); }
      toasts("正在克隆当前分支…");
      // clone 在 pi 侧已经把当前会话换成新分支了，返回值只有 {cancelled}，
      // 要拿新会话路径只能再问一次 get_state；不管的话界面会停在一条死会话上。
      return send("pi.call", { type: "clone", params: {} })
        .then(function (r) {
          if (!r || !r.success) throw new Error((r && r.error) || "克隆失败");
          if (r.data && r.data.cancelled) { toasts("当前分支还不能克隆", "warn"); return null; }
          return refreshState().then(function () {
            var p = S.liveSession;
            if (!p) { toasts("已克隆成新会话，从左侧列表打开", "warn"); return null; }
            return openSession(p).then(function () { toasts("已克隆为独立新会话"); });
          });
        })
        .catch(function (e) { toasts("克隆失败：" + ((e && e.message) || e), "error"); });
    }
    toasts("未实现的内置命令：" + name, "warn");
    return Promise.resolve();
  }

  function bindSlash() {
    var ta = $("input");
    // 点面板以外的地方（含发送按钮）就收起来
    document.addEventListener("mousedown", function (e) {
      var p = $("slash-pop");
      if (p.hidden) return;
      if (p.contains(e.target) || e.target === ta) return;
      closeSlashPalette();
    });
    ta.addEventListener("blur", function () { setTimeout(closeSlashPalette, 0); });
  }

  /* ================= 右侧导轨：用户消息小方块 + 可拖动滑块 =================
     参考实现的这条导轨有三个东西：每条用户消息一个小方块（鼠标悬停给预览，点一下跳过去）、
     表示当前视口的滑块（按住能拖）、以及点轨道空白直接跳。这里按同样的语义实现，
     但把「每条消息的绝对 y」缓存在 MINI.docY 里，滚动时只更新位置，不逐条量 DOM，
     几百条消息也不会把滚动拖慢。 */
  var MINI = { nodes: [], elms: [], docY: [], raf: 0, drag: null, tip: -1 };

  function miniNodes() {
    return Array.prototype.slice.call(streamInner.querySelectorAll(".msg.user"));
  }

  function miniText(node) {
    var b = node.querySelector(".bubble");
    return oneLine(b ? b.textContent : node.textContent, 80) || "(空消息)";
  }

  /* 悬停小方块时预览卡里的「回答文字」：下一条 assistant 消息的正文，去掉工具卡片和思考块 */
  function miniAnswerText(node) {
    var next = node.nextElementSibling;
    while (next && !(next.classList && next.classList.contains("msg"))) next = next.nextElementSibling;
    if (!next || !next.classList.contains("assistant")) return "";
    var body = next.querySelector(".body");
    if (!body) return "";
    var c = body.cloneNode(true);
    var junk = c.querySelectorAll(".tc, [class*='think'], [class*='thk']");
    for (var i = 0; i < junk.length; i++) {
      if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    }
    return oneLine(c.textContent, 900);
  }

  /* 导轨显隐同时管住原生滚动条：导轨在，就不留第二根滑块 */
  function miniVisible(on) {
    var mini = $("mini");
    if (mini) mini.hidden = !on;
    if (streamBox && streamBox.classList) streamBox.classList.toggle("has-mini", !!on);
    if (!on) hideMiniTip();
  }

  /* 重建小方块。条数没变、首尾节点也没换时复用现有 DOM，只重算位置 —— 
     实时追加消息会频繁触发这里，重建 DOM 会丢 hover 状态。 */
  function buildMini() {
    var mini = $("mini"), marks = $("mini-marks");
    if (!mini || !marks) return;
    var nodes = miniNodes();
    MINI.nodes = nodes;
    if (!nodes.length) {
      MINI.elms = [];
      MINI.docY = [];
      miniVisible(false);
      return;
    }
    var same = MINI.elms.length === nodes.length && MINI.dom0 === nodes[0];
    if (!same) {
      marks.innerHTML = "";
      MINI.elms = [];
      nodes.forEach(function (n, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "mini-mark";
        b.addEventListener("mousedown", function (e) { e.preventDefault(); });
        b.addEventListener("click", function (e) {
          e.preventDefault();
          e.stopPropagation();
          jumpMini(i);
        });
        b.addEventListener("mouseenter", function () { showMiniTip(i); });
        b.addEventListener("mouseleave", hideMiniTip);
        marks.appendChild(b);
        MINI.elms.push(b);
      });
      MINI.dom0 = nodes[0];
    }
    measureMini();
    renderMini();
  }

  /* 量消息在滚动内容里的绝对 y。只在这里和改窗口大小时量，滚动态不调用。 */
  function measureMini() {
    var top = streamBox.getBoundingClientRect().top - streamBox.scrollTop;
    MINI.docY = MINI.nodes.map(function (n) {
      var r = n.getBoundingClientRect();
      return (r.top - top) + r.height / 2;
    });
  }

  function renderMini() {
    var mini = $("mini"), thumb = $("mini-thumb");
    if (!mini || !thumb) return;
    var viewH = streamBox.clientHeight;
    var scrollH = streamBox.scrollHeight;
    // 只有一两条消息、或者整页就装得下：这条导轨没有信息量，收起来
    if (MINI.elms.length < 2 || scrollH <= viewH + 4 || viewH < 120) {
      miniVisible(false);
      return;
    }
    miniVisible(true);
    mini.style.top = (streamBox.scrollTop + 8) + "px";   // 抵消滚动，钉在视口里
    var railH = viewH - 16;
    mini.style.height = railH + "px";
    var maxMark = Math.max(0, railH - 4);
    for (var i = 0; i < MINI.elms.length; i++) {
      var y = MINI.docY[i] / scrollH * railH - 2;
      MINI.elms[i].style.top = Math.max(0, Math.min(maxMark, y)) + "px";
    }
    var th = Math.max(22, Math.round(railH * Math.min(1, viewH / scrollH)));
    var maxTop = Math.max(0, railH - th);
    var denom = Math.max(1, scrollH - viewH);
    thumb.hidden = false;
    thumb.style.height = th + "px";
    thumb.style.top = Math.round(maxTop * Math.max(0, Math.min(1, streamBox.scrollTop / denom))) + "px";
    // 高亮「当前读到的这一条」：视口顶部往上一点算当前
    var cur = 0;
    for (i = 0; i < MINI.docY.length; i++) {
      if (MINI.docY[i] - 12 <= streamBox.scrollTop + 60) cur = i;
    }
    for (i = 0; i < MINI.elms.length; i++) MINI.elms[i].classList.toggle("on", i === cur);
    if (MINI.tip >= 0) placeMiniTip();
  }

  function scheduleMini() {
    if (MINI.raf) return;
    MINI.raf = requestAnimationFrame(function () { MINI.raf = 0; renderMini(); });
  }

  function showMiniTip(i) {
    var tip = $("mini-tip");
    if (!tip || !MINI.nodes[i]) return;
    MINI.tip = i;
    var node = MINI.nodes[i];
    tip.textContent = "";
    var head = document.createElement("div");
    head.className = "t-round";
    head.textContent = "第 " + (i + 1) + " 轮 / 共 " + MINI.nodes.length + " 轮";
    tip.appendChild(head);
    var q = document.createElement("div");
    q.className = "t-q";
    q.textContent = miniText(node);
    tip.appendChild(q);
    var a = miniAnswerText(node);
    if (a) {
      var ab = document.createElement("div");
      ab.className = "t-a";
      ab.textContent = a;
      tip.appendChild(ab);
    }
    tip.hidden = false;
    placeMiniTip();
  }

  function placeMiniTip() {
    var tip = $("mini-tip");
    var m = MINI.elms[MINI.tip];
    if (!tip || tip.hidden || !m) return;
    var railH = $("mini-rail").clientHeight;
    var mt = parseFloat(m.style.top) || 0;
    var maxTop = Math.max(0, railH - tip.offsetHeight);
    tip.style.top = Math.max(0, Math.min(maxTop, mt - 2)) + "px";
  }

  function hideMiniTip() {
    MINI.tip = -1;
    var t = $("mini-tip");
    if (t) t.hidden = true;
  }

  function jumpMini(i) {
    if (MINI.docY[i] === undefined) return;
    streamBox.scrollTo({ top: Math.max(0, MINI.docY[i] - streamBox.clientHeight * 0.25), behavior: "smooth" });
  }

  function bindMini() {
    var mini = $("mini"), rail = $("mini-rail"), thumb = $("mini-thumb");
    if (!mini || !rail || !thumb) return;
    streamBox.addEventListener("scroll", scheduleMini);

    function scrollToY(clientY, grab) {
      var r = rail.getBoundingClientRect();
      var maxTop = Math.max(1, r.height - thumb.getBoundingClientRect().height);
      var x = Math.max(0, Math.min(1, (clientY - r.top - grab) / maxTop));
      streamBox.scrollTop = Math.max(0, streamBox.scrollHeight - streamBox.clientHeight) * x;
    }
    function onMove(e) { if (MINI.drag) scrollToY(e.clientY, MINI.drag); }
    function onUp() {
      MINI.drag = null;
      mini.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    function startDrag(e, grab) {
      MINI.drag = grab;
      mini.classList.add("dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      scrollToY(e.clientY, grab);
      renderMini();
      e.preventDefault();
    }
    thumb.addEventListener("mousedown", function (e) {
      startDrag(e, e.clientY - thumb.getBoundingClientRect().top);
    });
    // 点轨道空白：滑块中心跳过去，并接着拖（跟浏览器原生滚动条一个手感）
    rail.addEventListener("mousedown", function (e) {
      if (MINI.drag) return;
      if (e.target === thumb || (e.target.classList && e.target.classList.contains("mini-mark"))) return;
      startDrag(e, thumb.getBoundingClientRect().height / 2);
    });
    // 窗口尺寸变了：小方块位置和滑块长度都得重算
    window.addEventListener("resize", buildMini);
    // 消息流增删（实时消息、切换会话、往上加载历史）后重建
    if (window.MutationObserver) {
      new MutationObserver(function () {
        if (MINI.raf) return;
        MINI.raf = requestAnimationFrame(function () { MINI.raf = 0; buildMini(); });
      }).observe(streamInner, { childList: true });
    }
  }

  /* ================= 事件绑定 ================= */
  function bind() {
    // 先把配置拉回来并应用（主题/字号/宽度），再绑事件
    loadSettings().then(function (s) {
      applySettings(s);
      bindSelectionPopup();
    }).catch(function (e) { console.warn("设置加载失败", e); });
    // 输入框
    var ta = $("input");
    ta.addEventListener("input", function () {
      ta.style.height = "auto";
      ta.style.height = Math.min(180, ta.scrollHeight) + "px";
      syncSlash();
    });
    ta.addEventListener("keydown", function (e) {
      if (slashKeys(e)) return;
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        var bi = builtinFromInput();
        if (bi) {
          ta.value = "";
          ta.style.height = "auto";
          closeSlashPalette();
          runBuiltinSlash(bi.name, bi.arg);
          return;
        }
        // 空闲 = 普通发送；运行中 Enter = 立即引导，Alt+Enter = 排队后续消息（对齐参考实现）
        if (!S.streaming) submit(null);
        else submit(e.altKey ? "follow" : "steer");
      }
    });
    $("btn-steer").addEventListener("click", function () { submit("steer"); });
    $("btn-follow").addEventListener("click", function () { submit("follow"); });
    $("btn-send").addEventListener("click", function () { submit(); });
    // 思考等级 / 工具预设胶囊（都靠 stopPropagation 挡住上面的空白关闭）
    $("chip-think").addEventListener("click", function (e) {
      e.stopPropagation();
      if ($("model-pop").hidden === false) closeModelPop();
      if ($("chip-think").disabled) return;
      openChipPop("think");
    });
    $("chip-preset").addEventListener("click", function (e) {
      e.stopPropagation();
      if ($("chip-preset").disabled) return;
      openChipPop("preset");
    });
    $("chip-compact").addEventListener("click", function () {
      if (S.streaming) { toasts("运行中不能压缩上下文", "warn"); return; }
      $("chip-compact").disabled = true;
      toasts("正在压缩上下文…");
      send("pi.call", { type: "compact", params: {} })
        .then(function (r) {
          if (!r.success) throw new Error(r.error || "压缩失败");
        })
        .catch(function (e) { toasts((e && e.message) || "压缩失败", "error"); })
        .then(function () {
          $("chip-compact").disabled = !!S.streaming;
          return refreshStats();
        });
    });
    $("btn-sound").addEventListener("click", function () {
      S.sound = !S.sound;
      renderChips();
      if (S.sound) beep();   // 顺手试听一声
       send("settings.set", { soundEnabled: S.sound }).catch(function (e) {
         console.warn("[settings] 保存提示音开关失败：" + ((e && e.message) || e));
       });
    });
    $("btn-stop").addEventListener("click", function () {
      send("pi.send", { type: "abort", params: {} })
        .then(function () { S.streaming = false; updateRunState(); toasts("已请求停止"); })
        .catch(function (e) { toasts(e.message, "error"); });
    });
     $("btn-devtools").addEventListener("click", function () {
       send("app.devtools").catch(function (e) { console.warn("[devtools] 打开失败：" + ((e && e.message) || e)); });
     });

    // 输入框左下的图片按钮：点选图片。多选，不触发上传到目录。
    $("btn-attach").addEventListener("click", function () {
      var inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/*";
      inp.multiple = true;
      inp.addEventListener("change", function () { addImageFiles(inp.files); inp.value = ""; });
      inp.click();
    });
    // 粘贴图片
    ta.addEventListener("paste", function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var fs = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind !== "file") continue;
        var f = items[i].getAsFile();
        if (f && /^image\//.test(f.type || "")) fs.push(f);
      }
      if (fs.length) { e.preventDefault(); addImageFiles(fs); }
    });
    // 拖入图片
    ["dragenter", "dragover"].forEach(function (ev) {
      $("composer").addEventListener(ev, function (e) { e.preventDefault(); $("composer").classList.add("dragover"); });
    });
    $("composer").addEventListener("dragleave", function () { $("composer").classList.remove("dragover"); });
    $("composer").addEventListener("drop", function (e) {
      e.preventDefault();
      $("composer").classList.remove("dragover");
      addImageFiles(e.dataTransfer && e.dataTransfer.files);
    });
    // 模型下拉
    $("model-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      var p = $("model-pop");
      if (p.hidden) { send("pi.call", { type: "get_available_models" }).then(function (r) {
        if (r.success) { S.models = (r.data && r.data.models) || []; openModelPop(); }
        else openModelPop();
      }).catch(function () { openModelPop(); }); }
      else closeModelPop();
    });
    // 点空白 / Esc 关闭下拉
    document.addEventListener("click", function (e) {
      var p = $("model-pop");
      if (!p.hidden && !p.contains(e.target) && e.target !== $("model-btn")) closeModelPop();
      closeChipPop();
    });
    // 胶囊下拉里的点击不能在冒泡阶段被上面的空白关闭逻辑吃掉：
    // 重填 innerHTML 后被点的那颗按钮已经脱离文档，contains(target) 必为 false。
    $("chip-pop").addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var p = $("model-pop");
      if (!p.hidden) { closeModelPop(); return; }
      if (CHIP_POP) { closeChipPop(); return; }
      var m = $("modal");
      if (m && !m.hidden) closeModal();
    });

    // 侧栏
    $("toggle-sidebar").addEventListener("click", function () {
    $("sidebar").classList.toggle("collapsed");
    /* 窄屏抽屉拉开时让右面板让位，不然全屏浮层会把抽屉盖住 */
    if (layoutMode() === "mobile" && !sbCollapsed() && RP.open) rpHide();
    syncBackdrop();
    fitMeter();   // 主区宽度变了，顶栏自适应要重算
  });
  // 窗口尺寸变化同样会影响顶栏可用宽度（之前根本没有 resize 监听）。
  window.addEventListener("resize", fitMeter);
    $("btn-new").addEventListener("click", function () {
      // 先把 pi 子进程挪到当前在用的工作目录，再新建：
      // pi 按 cwd 落会话文件，不挪的话新会话会落到 pi 原来的目录里。
      piUseCwd(S.cwd || "").then(function () {
        return send("pi.call", { type: "new_session" });
      }).then(function () {
        S.liveSession = null;   // 新会话的文件名由 refreshState 回报
        streamInner.innerHTML = ""; liveNode = null;
        S.images = []; renderAttachStrip();
        closeModelPop();
        toasts("已新建会话");
        return refreshState().then(loadSessions);
      }).catch(function (e) { toasts(e.message, "error"); });
    });
    $("btn-search").addEventListener("click", function () {
      var b = $("search-box");
      b.hidden = !b.hidden;
      if (!b.hidden) $("search-input").focus();
    });
    $("search-input").addEventListener("input", renderSessions);

    // 会话历史分页
    $("hist-more").addEventListener("click", loadEarlier);

    // 目录选择模态
    $("dp-close").addEventListener("click", closeDirPicker);
    $("dp-cancel").addEventListener("click", closeDirPicker);
    $("dp-ok").addEventListener("click", dpAccept);
    $("dp-go").addEventListener("click", dpGoTyped);
    $("dp-up").addEventListener("click", dpUp);
    $("dp-path").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); dpGoTyped(); }
    });
    // 点遮罩关闭
    $("dir-pick").addEventListener("click", function (e) {
      if (e.target === $("dir-pick")) closeDirPicker();
    });
    // 捕获阶段：抢在外层 Escape 处理器前面，Esc 只关目录选择框
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("dir-pick").hidden) {
        e.stopPropagation();
        closeDirPicker();
      }
    }, true);

    bindWorkspace();
  bindStatsPop();
    bindDrafts();
    bindWorktrees();
    $("btn-git-root").addEventListener("click", function () {
      send("fs.gitroot").then(function (r) {
        if (r.root) wsPick(r.root); else toasts("未找到 Git 仓库根目录", "warn");
      }).catch(function (e) { toasts(e.message, "error"); });
    });
    $("fs-refresh").addEventListener("click", function () {
      var b = $("fs-refresh");
      loadTree(S.cwd).then(function () {
        // 照参考实现：刷完把图标换成绿勾晃一下，让人知道真刷新过
        b.classList.add("done");
        b.innerHTML = "";
        b.appendChild(icon("i-check"));
        b.title = "已刷新";
        setTimeout(function () {
          b.classList.remove("done");
          b.innerHTML = "";
          b.appendChild(icon("i-rotate"));
          b.title = "刷新文件浏览器";
        }, 1800);
      });
    });
    $("fs-term").addEventListener("click", function () {
      send("fs.term", { path: S.cwd }).then(function (r) {
        toasts("已在 " + (r && r.shell ? r.shell : "终端") + " 打开工作区终端");
      }).catch(function (e) { toasts(e.message, "error"); });
    });
    $("fs-search").addEventListener("click", function () { fsSearchToggle(); });
    $("fs-clear").addEventListener("click", function () {
      $("fs-query").value = "";
      fsRunSearch();
      $("fs-query").focus();
    });
    $("fs-query").addEventListener("input", function () {
      clearTimeout(FSS.timer);
      FSS.timer = setTimeout(fsRunSearch, 220);
    });
    $("fs-query").addEventListener("keydown", function (e) {
      if (e.key === "Escape") fsSearchToggle(false);
    });
    $("fs-upload").addEventListener("click", function () {
      var inp = document.createElement("input");
      inp.type = "file";
      inp.multiple = true;
      inp.addEventListener("change", function () { uploadFiles(inp.files); });
      inp.click();
    });
    // 拖文件到窗口任意位置即上传到当前目录
    ["dragover", "drop"].forEach(function (evt) {
      document.addEventListener(evt, function (e) { e.preventDefault(); });
    });
    document.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        uploadFiles(e.dataTransfer.files);
      }
    });
    $("files-toggle").addEventListener("click", function () {
      var t = $("file-tree");
      t.hidden = !t.hidden;
      this.classList.toggle("closed", t.hidden);
    });

    // 左下入口
    $("open-models").addEventListener("click", function () { openModal("models"); });
    $("open-skills").addEventListener("click", function () { openModal("skills"); });
    $("open-settings").addEventListener("click", function () { openModal("general"); });

    // 顶栏
    $("tb-history").addEventListener("click", showHistory);
    $("tb-title").addEventListener("click", generateTitle);
    $("tb-system").addEventListener("click", showSystem);
    $("tb-tools").addEventListener("click", showTools);

    $("modal-close").addEventListener("click", closeModal);
    $("modal").addEventListener("click", function (e) { if (e.target === $("modal")) closeModal(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("modal").hidden) closeModal();
       if (e.key === "F12") {
         e.preventDefault();
         send("app.devtools").catch(function (er) { console.warn("[devtools] 打开失败：" + ((er && er.message) || er)); });
       }
    });

    bindSlash();
    bindMini();
  bindScrollFollow();
  }

  /* ================= 启动 ================= */
  /* ================= Git 工作树 =================
     参考实现顶栏有 worktree 切换器；移植版原来只有「仅 Git 仓库根目录」一个按钮。
     菜单复用工作目录下拉（.ws-menu）的样式，挂在侧栏 .sb-git-row 里。 */
  function wtClose() {
    $("wt-menu").hidden = true;
    $("btn-worktrees").classList.remove("open");
  }

  function wtItem(label, on, tip, onPick) {
    var b = el("button", "ws-item" + (on ? " on" : ""));
    b.type = "button";
    var tick = el("span", "ws-tick");
    if (on) tick.appendChild(icon("i-check"));
    b.appendChild(tick);
    b.appendChild(icon("i-layers"));
    var lb = el("span", "ws-label");
    var inner = document.createElement("span");
    inner.style.unicodeBidi = "plaintext";
    inner.textContent = label;
    lb.appendChild(inner);
    b.appendChild(lb);
    b.title = tip || label;
    b.addEventListener("click", function (e) { e.stopPropagation(); wtClose(); onPick(); });
    return b;
  }

  function renderWtMenu(items, root) {
    var box = $("wt-menu");
    box.innerHTML = "";
    var cur = normDirJs(S.cwd);
    var scroll = el("div", "ws-scroll");
    items.forEach(function (it) {
      var name = it.branch || (it.detached ? "(游离 HEAD)" : it.path);
      var on = normDirJs(it.path) === cur;
      scroll.appendChild(wtItem(name + " · " + (it.head || ""), on,
        it.path + (it.bare ? "（裸仓库）" : ""),
        function () { wsPick(it.path); }));
    });
    if (!items.length) scroll.appendChild(el("div", "empty", "没有工作树"));
    box.appendChild(scroll);
    box.appendChild(el("div", "ws-sep"));

    // 删除当前工作树：先点一次变确认文案，再点才真删（主仓库不能删）
    var here = items.filter(function (it) { return normDirJs(it.path) === cur; })[0];
    if (here && normDirJs(here.path) !== normDirJs(root)) {
      var del = el("button", "ws-item action");
      del.type = "button";
      del.appendChild(el("span", "ws-label", "删除当前工作树…"));
      var armed = false;
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        var l = del.querySelector(".ws-label");
        if (!armed) {
          armed = true;
          if (l) l.textContent = "再点一次确认删除 " + (here.branch || here.path);
          setTimeout(function () {
            if (!armed) return;
            armed = false;
            var l2 = del.querySelector(".ws-label");
            if (l2) l2.textContent = "删除当前工作树…";
          }, 4000);
          return;
        }
        del.disabled = true;
        send("git.worktreeRemove", { cwd: S.cwd, path: here.path })
          .then(function () { wtClose(); toasts("已删除工作树 " + here.path, "ok"); return wsPick(root); })
          .catch(function (err) { del.disabled = false; toasts("删除失败：" + err.message, "error"); });
      });
      box.appendChild(del);
      box.appendChild(el("div", "ws-sep"));
    }

    // 新建：分支名 + 目录，默认落在仓库同级的 <仓库名>-<分支>
    var repoName = String(root || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "repo";
    var parent = String(root || "").replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "");
    var form = el("div", "wt-form");
    form.addEventListener("click", function (e) { e.stopPropagation(); });  // 别把菜单点关了
    var bi = el("input", "wt-in");
    bi.type = "text";
    bi.placeholder = "新分支名";
    bi.value = "wt-" + Date.now().toString(36).slice(-4);
    var pit = el("input", "wt-in");
    pit.type = "text";
    pit.placeholder = "工作树目录";
    function defPath() {
      var b = String(bi.value || "wt").replace(/[\\/:*?"<>|]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
      return parent + "\\" + repoName + "-" + b;
    }
    pit.value = defPath();
    bi.addEventListener("input", function () { pit.value = defPath(); });
    var ok = el("button", "btn btn-block", "新建工作树");
    ok.type = "button";
    ok.addEventListener("click", function (e) {
      e.stopPropagation();
      var branch = bi.value.trim();
      var p = pit.value.trim();
      if (!branch) { toasts("请填分支名", "warn"); return; }
      if (!p) { toasts("请填工作树目录", "warn"); return; }
      ok.disabled = true;
      send("git.worktreeAdd", { cwd: S.cwd, path: p, branch: branch })
        .then(function () { wtClose(); toasts("已新建工作树 " + p, "ok"); return wsPick(p); })
        .catch(function (err) { ok.disabled = false; toasts("新建失败：" + err.message, "error"); });
    });
    form.appendChild(bi);
    form.appendChild(pit);
    form.appendChild(ok);
    box.appendChild(form);
  }

  function bindWorktrees() {
    $("btn-worktrees").addEventListener("click", function (e) {
      e.stopPropagation();
      var box = $("wt-menu");
      if (!box.hidden) { wtClose(); return; }
      wsClose();
      send("git.worktrees", { cwd: S.cwd }).then(function (r) {
        renderWtMenu((r && r.items) || [], (r && r.root) || "");
        box.hidden = false;
        $("btn-worktrees").classList.add("open");
      }).catch(function (err) {
        var m = String((err && err.message) || err);
        if (m.indexOf("not a git repository") >= 0) m = "当前目录不在 Git 仓库里";
        else if (m.indexOf("program not found") >= 0 || m.indexOf("未安装 git") >= 0) m = "没找到 git 命令：工作树功能需要先装 git 并加进 PATH";
        toasts(m, "warn");
      });
    });
    document.addEventListener("click", function () { if (!$("wt-menu").hidden) wtClose(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("wt-menu").hidden) wtClose();
    });
  }

  function boot() {
    bind();
    rpInit();
    updateRunState();
    loadProviderNames(); // 预热服务商显示名，模型弹窗的组头要用

    send("pi.start")
      .then(function () { return new Promise(function (r) { setTimeout(r, 1200); }); })
      .then(function () { return refreshState(); })
      .then(function () { return send("pi.call", { type: "get_available_models" }); })
      .then(function (r) {
        S.models = (r.data && r.data.models) || [];
        return send("pi.call", { type: "get_available_thinking_levels" });
      })
      .then(function (r) {
        var d = (r && r.success && r.data) || null;
        if (d && d.levels && d.levels.length) S.thinkLevels = d.levels;
        return send("app.home");
      })
      .then(function (h) {
        S.home = h.home;
        WS.home = h.home || "";
        WS.def = h.defaultDir || "";
        return loadTree("~").then(function (r) {
          // 把 ~ 记进最近列表：之后切走再打开菜单，顺序就和参考截图一样
          // （当前目录在最上面打勾，~ 排第二）
          if (r && r.path) { wsPush(r.path); wsSyncLabel(r.display || r.path, r.path); }
          return r;
        });
      })
      .then(loadSessions)
      .then(maybeRestoreSession)
      .then(restoreDraft)
      .then(function () {
        $("st-left").textContent = "· 已就绪";
        // 截图/验收：启动就打开指定设置分页（可带选中项：open=agents:explore）
        var m = /[?&]open=([a-z]+)(?::([a-z0-9_-]+))?/.exec(location.search);
        // open=dirpick / open=wsmenu：启动就摆出「选择目录」模态 / 工作目录下拉（截图验收用）
        if (m && m[1] === "dirpick") openDirPicker(S.cwd);
        else if (m && m[1] === "wsmenu") { $("ws-btn").click(); }
        else if (m && ["general", "models", "skills", "agents", "extensions"].indexOf(m[1]) >= 0) {
          openModal(m[1], m[2] || null);
        }
        if (/[?&]rp=([^&]+)/.test(location.search)) {
          // 截图/验收：启动就在右侧面板打开指定文件（可带 mode：rp=<路径>&rpmode=diff）
          // rp=outline -> 直接打开右侧「对话大纲」
          var rpArg = decodeURIComponent(/[?&]rp=([^&]+)/.exec(location.search)[1]);
          if (rpArg === "outline") {
            RP.active = RP_OUTLINE;
            rpShow();
          } else {
          rpOpenFile(rpArg);
          var rm = /[?&]rpmode=(preview|source|diff)/.exec(location.search);
          if (rm) {
            var rt = rpActive();
            if (rt) rt.mode = rm[1];
          }
          }
        }
        if (/[?&]stream=1/.test(location.search)) {
          // 截图/验收：启动就摆成「运行中」的输入区（不真发消息）
          S.streaming = true;
          updateRunState();
          setTimeout(function () { S.streaming = true; updateRunState(); }, 3000);
        }
        if (/[?&]pop=model/.test(location.search)) {
          // 截图/验收：启动就展开模型选择弹窗（模型列表要等 RPC，所以延后一点）
          setTimeout(function () { if (S.models.length) openModelPop(); }, 3200);
        }
        if (/[?&]pop=stats/.test(location.search)) {
          // 截图/验收：启动就展开右上角用量详情（等会话切完、get_session_stats 回来后）
          setTimeout(function () { openStatsPop(); }, 3200);
        }
        // 自检本体在 assets/selftest.js，下面只负责「按需加载 + 传作用域」
        if (/[?&]selftest=2/.test(location.search)) startSelfTest(2);
        else if (/[?&]selftest=3/.test(location.search)) {
          // ?selftest=3&only=^set\.  —— 只跑匹配的步骤，调单个用例时不用等全套 47s。
          var only = /[?&]only=([^&]*)/.exec(location.search);
          startSelfTest(3, new RegExp(only ? decodeURIComponent(only[1]) : "^plugins\\."));
        }
        else if (/[?&]selftest=1/.test(location.search)) startSelfTest(1);
      })
      .catch(function (e) {
        toasts("启动失败：" + e.message, "error");
        $("st-left").textContent = "× " + e.message;
        if (/[?&]selftest=1/.test(location.search)) {
          send("app.report", { ok: false, stage: "boot", error: e.message });
        }
      });
  }

  /* 启动时恢复上次的会话。
     坑：我们自己拉起的 `pi --mode rpc` 子进程会立刻新建一个空会话并把它报成当前会话，
     而 session.list 里它排第一且 messageCount=1（只有一行 session 头）。
     所以：先看 pi 当前会话是否真开过工，没开过就切到最近一个真有内容的会话。 */
  function maybeRestoreSession() {
    return send("pi.call", { type: "get_state" })
      .then(function (st) {
        var curId = (st.data && st.data.sessionId) || "";
        var cur = null;
        for (var j = 0; j < S.sessions.length; j++) {
          if (S.sessions[j].id === curId) { cur = S.sessions[j]; break; }
        }
        // 当前会话已有正文，不动它
        if (cur && cur.messages > 1) return null;

        var target = null;
        for (var i = 0; i < S.sessions.length; i++) {
          var s = S.sessions[i];
          if (s.id === curId) continue;
          if (s.messages > 1) { target = s; break; }
        }
        if (!target) return null;

        return openSession(target.path);
      })
      .catch(function (e) { console.warn("恢复会话失败", e); });
  }

  /* ================= 自检／验收代码（?selftest=1/2/3）=================
     自检本体已拆到 assets/selftest.js（2000+ 行、只在开发态跑）：生产态不下载、不解析。
     这里只留「按需加载 + 把本作用域符号传进去」的胶水。
     维护：新增自检用到的前端符号时，在 selftestScope() 里补一行，selftest.js 里补同名形参。 */
  var SELFTEST_URL = "https://pi.local/selftest.js";
  function selftestScope() {
    return {
      $: $,
      ARG_ZH: ARG_ZH,
      FONT_FALLBACK: FONT_FALLBACK,
      FONT_LEGACY: FONT_LEGACY,
      FONT_MONO_FALLBACK: FONT_MONO_FALLBACK,
      FONT_PROBE_MISSING: FONT_PROBE_MISSING,
      FONT_SYSTEM: FONT_SYSTEM,
      HIST_PAGE: HIST_PAGE,
      HL_SHELL: HL_SHELL,
      LAY: LAY,
      MAX_NOTICES: MAX_NOTICES,
      RP: RP,
      LIVE_TOOLS: LIVE_TOOLS,
      S: S,
      SET: SET,
      THINK_LABEL: THINK_LABEL,
      WS: WS,
      addImageFiles: addImageFiles,
      addUserMsg: addUserMsg,
      appendText: appendText,
      applyLayout: applyLayout,
      applySettings: applySettings,
      b64Bytes: b64Bytes,
      buildSessionMd: buildSessionMd,
      closeChipPop: closeChipPop,
      closeDirPicker: closeDirPicker,
      closeModal: closeModal,
      closeModelPop: closeModelPop,
      doDelete: doDelete,
      draftFlush: draftFlush,
      draftGet: draftGet,
      draftSave: draftSave,
      draftState: function () {
        var p = S.activeSession || "";
        return { key: DRAFT_KEY, text: draftGet(p), count: Object.keys(draftsAll()).length };
      },
      emitEvent: emitEvent,
      endStream: endStream,
      el: el,
      esc: esc,
      fetchAllMessages: fetchAllMessages,
      finishTool: finishTool,
      fontLabel: fontLabel,
      fontList: function () { return FONT_LIST; },
      fontSelect: fontSelect,
      fontResolves: fontResolves,
      fontStack: fontStack,
      forkFrom: forkFrom,
      fsRunSearch: fsRunSearch,
      fsSearchToggle: fsSearchToggle,
      generateTitle: generateTitle,
      hlApplyPre: hlApplyPre,
      hlCode: hlCode,
      hlLangOfPath: hlLangOfPath,
      hlReady: hlReady,
      hlSplit: hlSplit,
      lastUiResponse: function () { return LAST_UI_RESPONSE; },
      layoutMode: layoutMode,
      loadEarlier: loadEarlier,
      loadFonts: loadFonts,
      loadTree: loadTree,
      maybeRestoreSession: maybeRestoreSession,
      md: md,
      msgToMd: msgToMd,
      normDirJs: normDirJs,
      noticeClose: noticeClose,
      noticeList: noticeList,
      noticeLive: noticeLive,
      noticeQueue: noticeQueue,
      on: on,
      openChipPop: openChipPop,
      openDirPicker: openDirPicker,
      openModal: openModal,
      openModelPop: openModelPop,
      openSession: openSession,
      pickForkEntry: pickForkEntry,
      presetLabel: presetLabel,
      renderAttachStrip: renderAttachStrip,
      renderChips: renderChips,
      renderModelBtn: renderModelBtn,
      renderSessions: renderSessions,
      renderWtMenu: renderWtMenu,
      restoreDraft: restoreDraft,
      rpApply: rpApply,
      rpActive: rpActive,
      rpCloseTab: rpCloseTab,
      rpHide: rpHide,
      rpOpenFile: rpOpenFile,
      rpOpenUrl: rpOpenUrl,
      rpShow: rpShow,
      safeFileName: safeFileName,
      sanitizeModelsConfig: sanitizeModelsConfig,
      saveSetting: saveSetting,
      sbClamp: sbClamp,
      scrollState: function () { return { stick: SCROLL.stick, unread: SCROLL.unread, gap: bottomGap() }; },
      send: send,
      setInputText: setInputText,
      setToolInput: setToolInput,
      showHistory: showHistory,
      showSystem: showSystem,
      showTools: showTools,
      streamInner: streamInner,
      stopLiveTools: stopLiveTools,
      stripAnsi: stripAnsi,
      submit: submit,
      syncBackdrop: syncBackdrop,
      thinkBlock: thinkBlock,
      toasts: toasts,
      toolCard: toolCard,
      toolPreview: toolPreview,
      toolZh: toolZh,
      unwrapEl: unwrapEl,
      updateRunState: updateRunState,
      usageLine: usageLine,
      wsPick: wsPick,
      wtClose: wtClose,
      wtItem: wtItem,
      zhResult: zhResult,
    };
  }
  function loadSelfTest(cb) {
    if (window.__piSelfTestModule) return cb(window.__piSelfTestModule);
    var s = document.createElement("script");
    s.src = SELFTEST_URL;
    s.onload = function () {
      if (window.__piSelfTestModule) cb(window.__piSelfTestModule);
      else toasts("自检脚本没注册模块：assets/selftest.js", "error");
    };
    s.onerror = function () { toasts("自检脚本加载失败：assets/selftest.js", "error"); };
    document.head.appendChild(s);
  }
  // mode 1=全套自检 2=真实对话自检 3=只跑 only 正则匹配的步骤
  function startSelfTest(mode, only) {
    loadSelfTest(function (mod) {
      var api = mod(selftestScope());
      if (mode === 2) api.live();
      else api.run(only);
    });
  }

  /* ================= 右侧面板：文件 / 网页查看器 =================
     语义照 pi-web 的右侧 FileViewer + TabBar：
       · 点文件树 / 搜索结果里的文件 = 在这里开页签（可关、中键关），跟会话区互不干扰
       · 工具条：相对路径 · 语言/N 行/大小 · 绿点（正监视）· 视图模式 · 提及 · 换行 · 另存为
       · 左边界可拖宽（宽度写 localStorage，双击复位）；窗口太窄时面板浮在对话区上
       · 按 kind 分派：text / markdown / html / pdf / image / audio / video / 对比(diff)
     图片音视频交给 pi-file.local 协议按 URL 直接加载，不经 JS 桥搬 base64。 */
  var FILE_HOST = "https://pi-file.local";
  var RP = {
    open: false, tabs: [], active: null, w: 0, drag: null,
    MIN: 300, MAX: 1200, CHAT_MIN: 340, OVERLAY_AT: 760, MAX_LINES: 5000,
    WKEY: "pi-rpanel-w", TKEY: "pi-rpanel-tabs"
  };

  /* ---- 响应式布局（照 pi-web 的 panel-layout 三档） ----
     desktop ≥960：侧栏与右面板都在文档流内；
     compact 641–959：侧栏在流内，右面板改成浮层盖住对话区（点遮罩关掉）；
     mobile ≤640：侧栏变抽屉（默认收起，顶栏第一个按钮拉开），右面板全屏。
     侧栏宽度走 CSS 变量 --sidebar-width，夹在 180–480 且保证对话区至少 LAY.CHAT_MIN。 */
  var LAY = {
    MOBILE_MAX: 640, SPLIT_MIN: 960,
    CHAT_MIN: 420, CHAT_MIN_TIGHT: 300,
    SB_DEF: 268, SB_MIN: 180, SB_MAX: 480,
    KEY: "pi-sidebar-w"
  };
  var LAST_MODE = "";
  /* body 上挂着 --ui-zoom（界面字体缩放），侧栏 / 右面板会跟着一起等比放大，
     但 window.innerWidth 与 offsetWidth 都是未缩放的 CSS px —— 算「还剩多少宽度」
     必须先把 zoom 除掉，否则大字号下侧栏 + 右面板会把对话区挤成 0（顶栏被裁）。 */
  function uiZoom() {
    var z = parseFloat(getComputedStyle(document.body).zoom);
    return (isFinite(z) && z > 0) ? z : 1;
  }
  /* 面板留在文档流里时，对话区至少还要留 LAY.CHAT_MIN_TIGHT（未缩放 CSS px） */
  function rpFitsInline(vw) {
    var avail = (vw || window.innerWidth) / uiZoom();
    var pw = Math.max(RP.w || 0, RP.MIN);
    return avail - sbW() - pw - LAY.CHAT_MIN_TIGHT >= -1;
  }
  function layoutMode(vw) {
    vw = vw || window.innerWidth;
    if (vw <= LAY.MOBILE_MAX) return "mobile";
    if (vw < LAY.SPLIT_MIN) return "compact";
    return "desktop";
  }
  function sbW() { var s = $("sidebar"); return (s && s.offsetWidth) || LAY.SB_DEF; }
  function sbCollapsed() { var s = $("sidebar"); return !!(s && s.classList.contains("collapsed")); }
  function sbMaxW(vw) {
    vw = vw || window.innerWidth;
    if (layoutMode(vw) !== "desktop") return LAY.SB_MAX;
    /* 预算按未缩放 CSS px 算（渲染宽度 = CSS px × zoom） */
    var avail = vw / uiZoom();
    /* 面板是浮层时不占文档流宽度，别从侧栏预算里扣它 */
    var pw = (RP.open && rpFitsInline(vw)) ? RP.w : 0;
    return Math.min(LAY.SB_MAX, Math.max(LAY.SB_MIN, avail - LAY.CHAT_MIN - pw));
  }
  function sbClamp(w, vw) { return Math.round(Math.max(LAY.SB_MIN, Math.min(sbMaxW(vw), w))); }
  function sbSetW(w) {
    var v = sbClamp(w);
    document.documentElement.style.setProperty("--sidebar-width", v + "px");
    try { localStorage.setItem(LAY.KEY, String(v)); } catch (e) {}
    syncBackdrop();
  }
  /* 窄窗里浮着的面板（抽屉/浮层）要盖一层遮罩，点它就收起来；桌面档不用遮罩 */
  function syncBackdrop() {
    var bd = $("rp-backdrop");
    if (!bd) return;
    var mode = layoutMode();
    var need = (mode === "mobile" && !sbCollapsed()) || (RP.open && (mode !== "desktop" || !rpFitsInline()));
    bd.classList.toggle("show", need);
    /* 遮罩也从顶栏下面开始，顶栏按钮不被它挡住（浮层面板同理，见 rpApply） */
    var tb = document.querySelector(".topbar");
    var tbH = (need && tb) ? tb.offsetHeight : 0;
    bd.style.top = tbH ? tbH + "px" : "";
  }
  /* 窗口尺寸变化 / 启动时算一遍：进出窄屏自动收放侧栏 */
  function applyLayout() {
    var mode = layoutMode();
    var sb = $("sidebar");
    if (sb) {
      if (mode === "mobile" && LAST_MODE !== "mobile") sb.classList.add("collapsed");
      else if (mode !== "mobile" && LAST_MODE === "mobile") sb.classList.remove("collapsed");
    }
    LAST_MODE = mode;
    if (RP.open) rpApply();
    syncBackdrop();
  }
  /* 侧栏右缘拖动条：面板在左侧，往右拖 = 变宽（与 rpBindResizer 镜像） */
  function sbBindResizer() {
    var rz = $("sb-resizer");
    if (!rz) return;
    function endDrag(e) {
      rz.classList.remove("is-resizing");
      document.body.classList.remove("sb-resizing");
      syncBackdrop();
      try { if (e && e.pointerId != null) rz.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    rz.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || layoutMode() === "mobile") return;
      e.preventDefault();
      rz.dataset.x = String(e.clientX);
      rz.dataset.w = String(sbW());
      rz.classList.add("is-resizing");
      document.body.classList.add("sb-resizing");
      try { rz.setPointerCapture(e.pointerId); } catch (err) {}
    });
    rz.addEventListener("pointermove", function (e) {
      if (!rz.classList.contains("is-resizing")) return;
      var x0 = parseFloat(rz.dataset.x), w0 = parseFloat(rz.dataset.w);
      if (!isFinite(x0) || !isFinite(w0)) return;
      sbSetW(w0 + (e.clientX - x0));
    });
    rz.addEventListener("pointerup", endDrag);
    rz.addEventListener("pointercancel", endDrag);
    rz.addEventListener("lostpointercapture", function () { endDrag(null); });
    rz.addEventListener("dblclick", function () { sbSetW(LAY.SB_DEF); });
    rz.addEventListener("keydown", function (e) {
      var d = e.shiftKey ? 40 : 12;
      if (e.key === "ArrowRight") sbSetW(sbW() + d);
      else if (e.key === "ArrowLeft") sbSetW(sbW() - d);
      else if (e.key === "Home") sbSetW(LAY.SB_MIN);
      else if (e.key === "End") sbSetW(LAY.SB_MAX);
      else if (e.key === "Enter") sbSetW(LAY.SB_DEF);
    });
  }

  function rpSize(n) {
    n = n || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
    return (n / 1073741824).toFixed(2) + " GB";
  }
  function rpFileUrl(p) { return FILE_HOST + "/" + encodeURIComponent(p); }
  function rpIdOf(t) { return (t.kind === "web" ? "web:" : "file:") + (t.url || t.path); }
  function rpById(id) {
    if (id === RP_OUTLINE) return olTab();
    for (var i = 0; i < RP.tabs.length; i++) if (RP.tabs[i].id === id) return RP.tabs[i];
    return null;
  }

  /* ================= 右侧「对话大纲」（照 pi-web 的 ChatMinimap 预览面板做）=================
     每轮：编号 01/02… + 用户问题（最多 4 行）+ 回答的 A 标记 + 回答里的 h1/h2/h3。
     点任意一行把聊天滚到那条消息；聊天滚动时高亮当前所在的轮次。整块只有一个滚动条。 */
  var RP_OUTLINE = "outline";
  var OL = { turns: [], located: 0, dirty: true, top: 0, left: 0, mounted: false, count: -1,
             obs: null, timer: null, raf: 0 };

  function olIsActive() { return RP.active === RP_OUTLINE; }
  function olTab() {
    return { id: RP_OUTLINE, kind: "outline", label: "大纲", loaded: true,
             meta: "对话大纲", top: OL.top, left: OL.left, ckind: null, text: "" };
  }
  function olFlat(n) { return String(n ? n.textContent : "").replace(/\s+/g, " ").trim(); }

  /* 扫聊天 DOM 建大纲：用户消息 = 一轮；回答 = 该轮下的 A + 标题列表 */
  function olBuild() {
    OL.dirty = false;
    OL.turns = [];
    var msgs = streamBox.querySelectorAll(".msg.user, .msg.assistant"), cur = null, no = 0;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.classList.contains("user")) {
        no++;
        var ub = m.querySelector(".bubble-text") || m.querySelector(".bubble");
        cur = { no: no, el: m, text: olFlat(ub), answers: [] };
        OL.turns.push(cur);
        continue;
      }
      var bol = m.querySelector(".body");
      if (!bol) continue;
      var items = [], hs = bol.querySelectorAll("h1, h2, h3");
      for (var j = 0; j < hs.length; j++) {
        items.push({ level: Number(hs[j].tagName.charAt(1)), text: olFlat(hs[j]), el: hs[j] });
      }
      if (!items.length) {
        var ps = bol.querySelectorAll("p");
        for (var k = 0; k < ps.length; k++) {                 // 跳过工具卡片里的 p
          if (ps[k].closest && ps[k].closest(".tc")) continue;
          var s = olFlat(ps[k]);
          if (!s) continue;
          items.push({ level: 0, text: s.length > 96 ? s.slice(0, 96) + "…" : s, el: ps[k] });
          break;
        }
      }
      if (!items.length) continue;                            // 纯工具回声不占位
      if (!cur) { cur = { no: 0, el: m, text: "", answers: [] }; OL.turns.push(cur); }
      cur.answers.push({ el: m, items: items });
    }
  }

  function olJump(node) {
    if (!node || !node.getBoundingClientRect || !streamBox) return;
    var d = node.getBoundingClientRect().top - streamBox.getBoundingClientRect().top;
    streamBox.scrollTop = Math.max(0, streamBox.scrollTop + d - 6);
    olLocate();
  }

  /* 高亮当前所在轮次：最后一个 top 已越过聊天顶部的用户消息 */
  function olLocate() {
    var body = $("rp-body");

    if (!RP.open || !olIsActive() || !body || !OL.turns.length) return;
    var ref = streamBox.getBoundingClientRect().top + 28, best = 0;
    for (var i = 0; i < OL.turns.length; i++) {
      var T = OL.turns[i];
      if (!T.no || !T.el || !T.el.isConnected) continue;
      if (T.el.getBoundingClientRect().top <= ref) best = T.no; else break;
    }
    OL.located = best;
    var rows = body.querySelectorAll(".rpo-turn");
    for (var k = 0; k < rows.length; k++) {
      rows[k].classList.toggle("located", Number(rows[k].getAttribute("data-no")) === best);
    }
  }

  function olRender(host) {
    if (OL.dirty) olBuild();
    host.className = "rp-body rpo-body";
    host.innerHTML = "";
    if (!OL.turns.length) {
      host.appendChild(el("div", "rp-empty", "还没有对话消息"));
      OL.mounted = true;
      return;
    }
    var box = el("div", "rpo");
    OL.turns.forEach(function (T) {
      var row = el("div", "rpo-turn");
      row.setAttribute("data-no", String(T.no));
      row.appendChild(el("div", "rpo-no", T.no ? (T.no < 10 ? "0" + T.no : String(T.no)) : ""));
      var c = el("div", "rpo-c");
      if (T.text) {
        var u = el("button", "rpo-user");
        u.type = "button";
        u.title = T.text;
        u.appendChild(el("span", "rpo-utext", T.text));
        u.addEventListener("click", function () { olJump(T.el); });
        c.appendChild(u);
      }
      T.answers.forEach(function (A) {
        var aw = el("div", "rpo-ans");
        var ab = el("button", "rpo-a", "A");
        ab.type = "button";
        ab.title = "跳到这条回答";
        ab.addEventListener("click", function () { olJump(A.el); });
        aw.appendChild(ab);
        var list = el("div", "rpo-items");
        A.items.forEach(function (it) {
          var b = el("button", "rpo-item", it.text);
          b.type = "button";
          b.title = it.text;
          b.setAttribute("data-level", it.level ? String(it.level) : "p");
          b.addEventListener("click", function () { olJump(it.el); });
          list.appendChild(b);
        });
        aw.appendChild(list);
        c.appendChild(aw);
      });
      row.appendChild(c);
      box.appendChild(row);
    });
    host.appendChild(box);
    host.scrollTop = OL.top || 0;
    requestAnimationFrame(function () {
      olLocate();
      if (OL.mounted) { OL.top = host.scrollTop; return; }
      OL.mounted = true;
      var cur = box.querySelector(".rpo-turn.located") || box.querySelector(".rpo-turn");
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest" });
      OL.top = host.scrollTop;
      olLocate();
    });
  }

  /* 聊天在下边长时：消息条数变了才重建，否则只挪高亮（省开销） */
  function olWatch() {
    if (OL.obs || !window.MutationObserver || !streamBox) return;
    OL.count = streamBox.querySelectorAll(".msg").length;
    OL.obs = new MutationObserver(function () {
      if (!RP.open || !olIsActive() || OL.timer) return;
      OL.timer = setTimeout(function () {
        OL.timer = null;
        if (!RP.open || !olIsActive()) return;
        var b = $("rp-body"), n = streamBox.querySelectorAll(".msg").length;
        if (n !== OL.count) {
          OL.count = n;
          OL.dirty = true;
          if (b) OL.top = b.scrollTop;
          rpRender();
        } else {
          if (b) OL.top = b.scrollTop;
          olLocate();
        }
      }, 600);
    });
    OL.obs.observe(streamBox, { childList: true, subtree: true });
    streamBox.addEventListener("scroll", function () {
      if (!RP.open || !olIsActive() || OL.raf) return;
      OL.raf = requestAnimationFrame(function () { OL.raf = 0; olLocate(); });
    });
  }
  function rpActive() { return RP.active ? rpById(RP.active) : null; }
  function rpHostOf(u) { var m = /^https?:\/\/([^/]+)/.exec(String(u)); return m ? m[1] : String(u); }
  function rpBaseName(p) { return String(p).split(/[\\/]/).pop() || String(p); }

  /* ---- 宽度 / 布局：跟参考实现同一套算法 ---- */
  function rpSidebarW() { var s = $("sidebar"); return (s && s.offsetWidth) || 0; }
  function rpMaxW() {
    var vw = window.innerWidth;
    /* 浮层/全屏档：面板不吃文档流宽度，宽度不再受对话区限制 */
    if (layoutMode(vw) !== "desktop") return RP.MAX;
    /* vw 是未缩放 CSS px，先除 zoom 换成布局宽度，再扣侧栏与对话区下限 */
    return Math.max(RP.MIN, Math.min(RP.MAX, vw / uiZoom() - LAY.CHAT_MIN_TIGHT - rpSidebarW()));
  }
  function rpClamp(w) { return Math.round(Math.max(RP.MIN, Math.min(rpMaxW(), w))); }
  function rpDefW() { return Math.min(Math.max(Math.round(window.innerWidth * 0.34), 320), 560); }
  function rpApply() {
    if (!RP.open) return;
    var pan = $("right-panel");
    var desk = layoutMode() === "desktop";
    /* 桌面档也可能放不下（界面字体放大后侧栏 + 面板吃光宽度）：这时退化成浮层，
       不再把对话区压成 0 宽。 */
    var fixed = !desk || !rpFitsInline();
    pan.classList.toggle("overlay", fixed);
    $("rp-resizer").hidden = fixed;
    if (desk) {
      /* 桌面档：夹一下宽度，保证对话区至少留 LAY.CHAT_MIN_TIGHT */
      RP.w = rpClamp(RP.w);
      pan.style.setProperty("--right-panel-width", RP.w + "px");
    }
    /* 浮层别盖住顶栏：桌面档的浮层绝对定位在 .layout 里，窄屏浮层由媒体查询定位
       （fixed + top:0）。两种情况都要写内联 top = 顶栏高度 —— 否则浮层把顶栏（含 ▤
       切换按钮）整条压住，而面板里只有文件页签才渲染 ✕，用户就再也关不掉了。 */
    var tb = document.querySelector(".topbar");
    var tbH = tb ? tb.offsetHeight : 0;
    pan.style.top = (fixed && tbH) ? tbH + "px" : "";
  }
  function rpSetW(w) { RP.w = w; rpApply(); syncBackdrop(); }

  /* ---- 显隐 ---- */
  function rpShow() {
    RP.open = true;
    if (!RP.active || !rpById(RP.active)) RP.active = RP_OUTLINE;
    /* 全新配置（第一次跑 / 拷到别的机器）时还没读过 localStorage，RP.w 是 0，
       面板会以 0 宽“打开”看不见 —— 这里兜一下默认宽度。 */
    if (!RP.w || !isFinite(RP.w) || RP.w < RP.MIN) RP.w = rpDefW();
    $("right-panel").hidden = false;
    $("rp-resizer").hidden = false;
    $("btn-panel").classList.add("on");
    /* 窄屏面板是全屏浮层，抽屉让位 */
    if (layoutMode() === "mobile") $("sidebar").classList.add("collapsed");
    rpApply();
    syncBackdrop();
    rpRender();
  }
  function rpHide() {
    RP.open = false;
    $("right-panel").hidden = true;
    $("rp-resizer").hidden = true;
    $("btn-panel").classList.remove("on");
    syncBackdrop();
    rpSaveState();
  }
  function rpToggle() { if (RP.open) rpHide(); else rpShow(); }

  /* ---- 打开 / 关闭页签 ---- */
  function rpOpenFile(path) {
    var id = "file:" + path;
    var t = rpById(id);
    if (!t) {
      t = { id: id, kind: "file", path: path, label: rpBaseName(path), ckind: null, text: "",
            mode: null, wrap: false, loaded: false, meta: "", patch: "", hasDiff: false,
            diffTried: false, top: 0, left: 0, lines: 0, size: 0, truncated: false };
      RP.tabs.push(t);
    }
    RP.active = id;
    if (!RP.open) rpShow(); else rpRender();
    return t;
  }
  function rpOpenUrl(url, label) {
    var id = "web:" + url;
    var t = rpById(id);
    if (!t) {
      t = { id: id, kind: "web", url: url, label: label || rpHostOf(url), loaded: true,
            meta: "网页", ckind: null, text: "", top: 0, left: 0 };
      RP.tabs.push(t);
    }
    RP.active = id;
    if (!RP.open) rpShow(); else rpRender();
    return t;
  }
  function rpCloseTab(id) {
    var i = -1;
    for (var k = 0; k < RP.tabs.length; k++) if (RP.tabs[k].id === id) i = k;
    if (i < 0) return;
    var t = RP.tabs[i];
     if (t.kind === "file") {
       send("fs.unwatch", { path: t.path }).catch(function (e) { console.warn("[fs] 取消监听失败：" + ((e && e.message) || e)); });
     }
    RP.tabs.splice(i, 1);
    if (RP.active === id) RP.active = RP.tabs.length ? RP.tabs[Math.min(i, RP.tabs.length - 1)].id : null;
    if (!RP.tabs.length) { rpHide(); return; }
    rpRender();
  }

  /* ---- 滚动位置：切页签回来还在原来的位置 ---- */
  function rpSaveScroll() {
    var b = $("rp-body"); if (!b) return;
    if (olIsActive()) { OL.top = b.scrollTop; OL.left = b.scrollLeft; return; }
    var t = rpActive(); if (!t) return;
    t.top = b.scrollTop; t.left = b.scrollLeft;
  }
  function rpActivate(id) {
    if (id === RP.active) return;
    rpSaveScroll();
    RP.active = id;
    rpRender();
  }

  /* ---- 渲染 ---- */
  function rpRenderTabs() {
    var bar = $("rp-tabs");
    bar.innerHTML = "";
    var pin = el("div", "rp-tab pin" + (olIsActive() ? " active" : ""));
    pin.title = "对话大纲：点任意一行跳到那条消息";
    var pk = el("span", "tkind");
    pk.appendChild(icon("i-layers"));
    pin.appendChild(pk);
    pin.appendChild(el("span", "tname", "大纲"));
    pin.addEventListener("click", function () { rpActivate(RP_OUTLINE); });
    bar.appendChild(pin);
    RP.tabs.forEach(function (t) {
      var tab = el("div", "rp-tab" + (t.id === RP.active ? " active" : ""));
      tab.title = t.kind === "web" ? t.url : t.path;
      var k = t.kind === "web" ? null : fileKind(t.label);
      var ki = el("span", "tkind");
      ki.appendChild(icon(k ? k[2] : "i-globe"));
      tab.appendChild(ki);
      tab.appendChild(el("span", "tname", t.label));
      var x = el("button", "tclose");
      x.type = "button"; x.title = "关闭";
      x.appendChild(icon("i-x"));
      x.addEventListener("click", function (e) { e.stopPropagation(); rpCloseTab(t.id); });
      tab.appendChild(x);
      tab.addEventListener("click", function () { rpActivate(t.id); });
      tab.addEventListener("auxclick", function (e) { if (e.button === 1) { e.preventDefault(); rpCloseTab(t.id); } });
      bar.appendChild(tab);
    });
  }

  function rpRender() {
    if (!RP.open) return;
    rpRenderTabs();
    var body = $("rp-body"), tb = $("rp-toolbar"), t = rpActive();
    if (olIsActive()) {
      tb.hidden = true;
      olWatch();
      olRender(body);
      rpSaveState();
      return;
    }
    if (!t) {
      tb.hidden = true;
      body.className = "rp-body";
      body.innerHTML = "";
      body.appendChild(el("div", "rp-empty", "在左侧文件树里点一个文件，就在这里打开"));
      rpSaveState();
      return;
    }
    tb.hidden = false;
    $("rp-path").textContent = t.kind === "web" ? t.url : relPathOf(t.path);
    $("rp-path").title = t.kind === "web" ? t.url : t.path;
    $("rp-meta").textContent = t.meta || (t.kind === "web" ? "网页" : "读取中…");
    $("rp-live").hidden = t.kind !== "file";
    $("rp-mention").hidden = t.kind !== "file";
    $("rp-download").hidden = t.kind !== "file";
    $("rp-wrap").hidden = !(t.kind === "file" && (t.mode === "source" || (!t.mode && (t.ckind === "text" || !t.ckind))));
    $("rp-wrap").classList.toggle("on", !!t.wrap);
    rpRenderModes(t);
    if (t.kind === "file" && !t.loaded) {
      body.className = "rp-body";
      body.innerHTML = "";
      body.appendChild(el("div", "rp-empty", "读取中…"));
      rpSaveState();
      rpLoad(t).then(function () { if (rpActive() === t) rpRender(); })
        .catch(function (e) {
          if (rpActive() !== t) return;
          body.innerHTML = "";
          body.appendChild(el("div", "rp-empty", "打开失败：" + e.message));
        });
      return;
    }
    var full = t.kind === "web" || t.ckind === "image" || t.ckind === "video" ||
               t.ckind === "audio" || t.ckind === "pdf" || (t.ckind === "html" && t.mode !== "source");
    body.className = "rp-body" + (full ? " full" : "");
    body.innerHTML = "";
    rpPaint(t, body);
    body.scrollTop = t.top || 0;
    body.scrollLeft = t.left || 0;
    rpSaveState();
  }

  /* ---- 内容：按 kind 分派 ---- */
  function rpLoad(t) {
    return send("fs.read", { path: t.path }).then(function (r) {
      t.loaded = true;
      t.ckind = r.kind;
      t.text = r.text || "";
      t.lines = r.lines || 0;
      t.size = r.size || 0;
      t.truncated = !!r.truncated;
      t.meta = rpMeta(r);
      if (!t.mode) t.mode = (r.kind === "markdown" || r.kind === "html") ? "preview" : "source";
      if (r.kind === "text" && !t.diffTried) { t.diffTried = true; rpCheckDiff(t); }
      send("fs.watch", { path: t.path }).catch(function (e) { console.warn("[fs] 监听失败（文件不会自动刷新）：" + ((e && e.message) || e)); });
      return t;
    });
  }
  function rpMeta(r) {
    var a = [];
    if (r.language) a.push(r.language);
    if (r.lines) a.push(r.lines + " 行");
    if (r.size != null) a.push(rpSize(r.size));
    return a.join(" · ");
  }
  function rpCheckDiff(t) {
    send("git.diff", { path: t.path }).then(function (r) {
      t.patch = (r && r.patch) || "";
      t.hasDiff = !!t.patch.trim();
      if (rpActive() === t) rpRenderModes(t);
    }).catch(function () { t.hasDiff = false; });
  }
  function rpRenderModes(t) {
    var box = $("rp-modes");
    box.innerHTML = "";
    var list = [];
    if (t.kind === "file") {
      var k = t.ckind;
      if (k === "markdown" || k === "html") list = [["预览", "preview"], ["源", "source"]];
      else if (k === "text" || !k) list = [["源", "source"]];
      if (t.hasDiff) list.push(["对比", "diff"]);
    }
    if (list.length < 2) return;
    list.forEach(function (m) {
      var b = el("button", "rp-mode" + (t.mode === m[1] ? " on" : ""), m[0]);
      b.type = "button";
      b.addEventListener("click", function () { t.mode = m[1]; rpRender(); });
      box.appendChild(b);
    });
  }

  function rpPaint(t, host) {
    if (t.kind === "web") {
      host.appendChild(rpWebBar(t));
      var f = el("iframe", "rp-frame");
      f.src = t.url;
      host.appendChild(f);
      return;
    }
    var k = t.ckind || "text";
    if (k === "image") return rpMediaInto(host, t, "img");
    if (k === "video") return rpMediaInto(host, t, "video");
    if (k === "audio") return rpAudioInto(host, t);
    if (k === "pdf") return rpFrameInto(host, rpFileUrl(t.path));
    if (k === "archive" || k === "bin") return rpBinaryInto(host, t);
    if (k === "html" && t.mode !== "source") return rpFrameInto(host, rpFileUrl(t.path));
    if (k === "markdown" && t.mode === "preview") return rpMarkdownInto(host, t);
    if (t.mode === "diff") return rpDiffInto(host, t);
    rpTextInto(host, t);
  }

  // 逐行一条 flex，行号 sticky 在左（横向滚动时行号不动），跟 pi-web 的行号视图一致
  function rpTextInto(host, t) {
    if (t.truncated) host.appendChild(rpTruncBar(t));
    var raw = String(t.text || "");
    var lines = raw.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    raw = lines.join("\n");
    // 整段上色再按行切开：跨行注释/字符串不掉色；行数对不上/库缺失时退回纯文本
    var hl = hlReady() ? hlSplit(hlCode(raw, hlLangOfPath(t.path)), lines.length) : null;
    var box = el("div", "rp-code" + (t.wrap ? " wrap" : ""));
    function rowAt(i) {
      var row = el("div", "rp-line");
      row.appendChild(el("div", "no", String(i + 1)));
      var tx = el("div", "tx", "");
      if (hl) tx.innerHTML = hl[i];
      else tx.textContent = lines[i];
      row.appendChild(tx);
      return row;
    }
    var limit = Math.min(lines.length, RP.MAX_LINES);
    for (var i = 0; i < limit; i++) box.appendChild(rowAt(i));
    host.appendChild(box);
    if (lines.length > limit) {
      var bar = el("div", "rp-bar");
      bar.appendChild(el("span", "grow", "文件太长，先渲染前 " + limit + " 行（共 " + lines.length + " 行）"));
      var b = el("button", "rp-link", "展开余下 " + (lines.length - limit) + " 行");
      b.type = "button";
      b.addEventListener("click", function () {
        for (var j = limit; j < lines.length; j++) box.appendChild(rowAt(j));
        limit = lines.length;
        bar.parentNode.removeChild(bar);
      });
      bar.appendChild(b);
      host.appendChild(bar);
    }
  }

  function rpTruncBar(t) {
    var bar = el("div", "rp-bar");
    bar.appendChild(el("span", "grow", "文件较大，只读了前 1 MB（共 " + rpSize(t.size) + "）"));
    var b = el("button", "rp-link", "读完整文件");
    b.type = "button";
    b.addEventListener("click", function () {
      b.disabled = true;
      b.textContent = "读取中…";
      send("fs.read", { path: t.path, maxBytes: 67108864 }).then(function (r) {
        t.text = r.text || "";
        t.truncated = !!r.truncated;
        t.lines = r.lines || 0;
        t.size = r.size || t.size;
        t.meta = rpMeta(r);
        rpRender();
      }).catch(function (e) {
        b.disabled = false;
        b.textContent = "重试";
        toasts("读取失败：" + e.message, "error");
      });
    });
    bar.appendChild(b);
    return bar;
  }

  function rpDiffInto(host, t) {
    var patch = t.patch || "";
    if (!patch.trim()) { host.appendChild(el("div", "rp-empty", "没有未提交的改动")); return; }
    var box = el("div", "rp-diff");
    patch.split("\n").forEach(function (ln) {
      var cls = "d";
      if (/^@@/.test(ln)) cls += " hunk";
      else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(ln)) cls += " meta";
      else if (ln.charAt(0) === "+") cls += " add";
      else if (ln.charAt(0) === "-") cls += " del";
      var mark = /^[+-]/.test(ln) ? ln.charAt(0) : "";
      var d = el("div", cls);
      d.appendChild(el("span", "pre", mark));
      d.appendChild(el("span", "", mark ? ln.slice(1) : ln));
      box.appendChild(d);
    });
    host.appendChild(box);
  }

  function rpMarkdownInto(host, t) {
    var w = el("div", "msg assistant rp-md");
    var b = el("div", "body");
    b.innerHTML = md(t.text || "");
    w.appendChild(b);
    host.appendChild(w);
  }

  function rpMediaInto(host, t, what) {
    var w = el("div", "rp-media");
    var node = document.createElement(what);
    node.src = rpFileUrl(t.path);
    if (what === "video") node.controls = true;
    else node.alt = t.label;
    w.appendChild(node);
    host.appendChild(w);
  }
  function rpAudioInto(host, t) {
    var w = el("div", "rp-audio");
    w.appendChild(el("div", "nm", t.label + " · " + rpSize(t.size)));
    var a = document.createElement("audio");
    a.src = rpFileUrl(t.path);
    a.controls = true;
    w.appendChild(a);
    host.appendChild(w);
  }
  function rpFrameInto(host, url) {
    var f = el("iframe", "rp-frame");
    f.src = url;
    host.appendChild(f);
  }
  function rpBinaryInto(host, t) {
    host.appendChild(el("div", "rp-empty",
      (t.ckind === "archive" ? "压缩包" : "二进制文件") + "：" + t.label + " · " + rpSize(t.size) +
      "，不能当文本看。要拿出来就用工具条上的「另存为…」。"));
  }
  function rpWebBar(t) {
    var bar = el("div", "rp-bar");
    bar.appendChild(el("span", "grow", "内嵌网页视图（站点若禁止内嵌会显示空白）"));
    var b = el("button", "rp-link", "用系统浏览器打开");
    b.type = "button";
    b.addEventListener("click", function () {
      send("app.openUrl", { url: t.url }).catch(function (e) { toasts("打开失败：" + e.message, "error"); });
    });
    bar.appendChild(b);
    return bar;
  }

  // 正文里的链接统一在 document 上拦：本地路径 = 同一面板开文件页签，http(s) = 开网页页签，
  // Ctrl/中键 = 丢给系统浏览器。关键是一律 preventDefault——否则 WebView 会自己导航过去，整个应用就没了。
  function rpBindLinks() {
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      var href = a.getAttribute("href") || "";
      if (!href || href.charAt(0) === "#" || /^javascript:/i.test(href)) return;
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        if (e.ctrlKey) send("app.openUrl", { url: href }).catch(function (er) { toasts("打开链接失败：" + ((er && er.message) || er), "error"); });
        else rpOpenUrl(href);
        return;
      }
      if (/^[a-z][a-z0-9+.\-]*:/i.test(href) && !/^file:/i.test(href)) return;
      var path = href.replace(/^file:\/\/+/i, "").split("#")[0].split("?")[0];
      try { path = decodeURIComponent(path); } catch (err) { /* 原样用 */ }
      if (!path) return;
      e.preventDefault();
      rpOpenFile(path);
    }, true);
    document.addEventListener("auxclick", function (e) {
      if (e.button !== 1) return;
      var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
      if (!a) return;
      var href = a.getAttribute("href") || "";
      if (!/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      send("app.openUrl", { url: href }).catch(function (er) { toasts("打开链接失败：" + ((er && er.message) || er), "error"); });
    }, true);
  }

  /* ---- 状态持久化：关掉重开，页签和宽度都还在 ---- */
  function rpSaveState() {
    try {
      localStorage.setItem(RP.TKEY, JSON.stringify({
        open: RP.open, active: RP.active,
        tabs: RP.tabs.map(function (t) {
          return { kind: t.kind, path: t.path, label: t.label, url: t.url, mode: t.mode, wrap: !!t.wrap };
        })
      }));
    } catch (e) {}
  }
  function rpRestoreState() {
    var raw = null;
    try { raw = localStorage.getItem(RP.TKEY); } catch (e) {}
    if (!raw) return;
    var o = null;
    try { o = JSON.parse(raw); } catch (e) { return; }
    if (!o || !o.tabs || !o.tabs.length) return;
    RP.tabs = o.tabs.filter(function (t) { return t && (t.path || t.url); }).map(function (t) {
      var nt = {
        kind: t.kind === "web" ? "web" : "file", path: t.path, url: t.url,
        label: t.label || rpBaseName(t.path || t.url), mode: t.mode || null, wrap: !!t.wrap,
        ckind: null, text: "", meta: "", patch: "", hasDiff: false, diffTried: false,
        top: 0, left: 0, lines: 0, size: 0, truncated: false, loaded: t.kind === "web"
      };
      nt.id = rpIdOf(nt);
      return nt;
    });
    if (!RP.tabs.length) return;
    RP.active = rpById(o.active) ? o.active : RP.tabs[0].id;
    if (o.open) rpShow();
  }

  /* ---- 拖宽 ---- */
  function rpBindResizer() {
    var rz = $("rp-resizer");
    function remember() { try { localStorage.setItem(RP.WKEY, String(RP.w)); } catch (e) {} }
    function endDrag(e) {
      if (!RP.drag) return;
      RP.drag = null;
      rz.classList.remove("is-resizing");
      document.body.classList.remove("rp-resizing");
      remember();
      rpApply();
      try { if (e && e.pointerId != null) rz.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    rz.addEventListener("pointerdown", function (e) {
      if (e.button !== 0 || !RP.open) return;
      e.preventDefault();
      RP.drag = { x: e.clientX, w: $("right-panel").offsetWidth || RP.w };
      rz.classList.add("is-resizing");
      document.body.classList.add("rp-resizing");
      try { rz.setPointerCapture(e.pointerId); } catch (err) {}
    });
    rz.addEventListener("pointermove", function (e) {
      if (!RP.drag) return;
      // 面板在右侧：鼠标往左拖 = 变宽
      rpSetW(rpClamp(RP.drag.w + (RP.drag.x - e.clientX)));
    });
    rz.addEventListener("pointerup", endDrag);
    rz.addEventListener("pointercancel", endDrag);
    rz.addEventListener("lostpointercapture", function () { endDrag(null); });
    rz.addEventListener("dblclick", function () { rpSetW(rpClamp(rpDefW())); remember(); });
    rz.addEventListener("keydown", function (e) {
      var d = e.shiftKey ? 40 : 12;
      if (e.key === "ArrowLeft") rpSetW(rpClamp(RP.w + d));
      else if (e.key === "ArrowRight") rpSetW(rpClamp(RP.w - d));
      else if (e.key === "Home") rpSetW(rpClamp(RP.MIN));
      else if (e.key === "End") rpSetW(rpClamp(RP.MAX));
      else if (e.key === "Enter") rpSetW(rpClamp(rpDefW()));
      else return;
      e.preventDefault();
      remember();
    });
  }

  function rpInit() {
    $("btn-panel").addEventListener("click", rpToggle);
    $("rp-close").addEventListener("click", rpHide);
    $("rp-mention").addEventListener("click", function () {
      var t = rpActive();
      if (!t || t.kind !== "file") return;
      toasts("已提及 " + mentionPath(t.path));
    });
    $("rp-wrap").addEventListener("click", function () {
      var t = rpActive();
      if (!t) return;
      t.wrap = !t.wrap;
      rpRender();
    });
    $("rp-download").addEventListener("click", function () {
      var t = rpActive();
      if (!t || t.kind !== "file") return;
      send("fs.saveAs", { path: t.path }).then(function (r) {
        if (!r || r.canceled) return;
        toasts("已另存为 " + r.dest);
      }).catch(function (e) { toasts("另存为失败：" + e.message, "error"); });
    });
    var w = 0;
    try { w = parseInt(localStorage.getItem(RP.WKEY) || "", 10); } catch (e) {}
    RP.w = rpClamp(isFinite(w) && w > 0 ? w : rpDefW());
    /* 侧栏宽度恢复 + 首帧布局（窄窗直接以抽屉形态起，不留一帧展开的残影） */
    var sw = NaN;
    try { sw = parseInt(localStorage.getItem(LAY.KEY) || "", 10); } catch (e) {}
    if (isFinite(sw) && sw > 0) document.documentElement.style.setProperty("--sidebar-width", sbClamp(sw) + "px");
    rpBindResizer();
    sbBindResizer();
    rpBindLinks();
    LAST_MODE = layoutMode();
    if (LAST_MODE === "mobile") $("sidebar").classList.add("collapsed");
    /* 遮罩：点它收起浮层/抽屉（mobile 优先收抽屉） */
    var bd = $("rp-backdrop");
    if (bd) bd.addEventListener("click", function () {
      if (layoutMode() === "mobile" && !sbCollapsed()) { $("sidebar").classList.add("collapsed"); syncBackdrop(); return; }
      if (RP.open) rpHide();
    });
    syncBackdrop();
    window.addEventListener("resize", applyLayout);
    // 文件在磁盘上变了 → 面板里正开着的这份跟着刷新（工具条绿点闪一下）
    on("fs.changed", function (d) {
      if (!d || !d.path) return;
      var t = null;
      for (var i = 0; i < RP.tabs.length; i++) {
        if (RP.tabs[i].kind === "file" && RP.tabs[i].path === d.path) t = RP.tabs[i];
      }
      if (!t) return;
      var live = $("rp-live");
      if (live && !live.hidden) {
        live.style.background = "#fff";
        setTimeout(function () { live.style.background = ""; }, 180);
      }
      if (t.ckind !== "text" && t.ckind !== "markdown" && t.ckind !== "html") return;
      var wasActive = rpActive() === t;
      if (wasActive) rpSaveScroll();
      t.loaded = false;
      rpLoad(t).then(function () { if (wasActive) rpRender(); }).catch(function (e) { console.warn("[rp] 加载失败：" + ((e && e.message) || e)); });
    });
    rpRestoreState();
  }

  /* 底部状态条：文字由 pi 扩展上报（形如「DS cache 136/137 · 9.37M/9.82M 95.3% ⚠ compat」），
     这里把里面那几个固定英文词换成中文，其余数字原样保留 */
  var STATUS_EN = [
    [/\bDS cache\b/g, "DS 缓存"],
    [/\bcache\b/gi, "缓存"],
    [/\bcompat\b/gi, "兼容"],
    [/\bhits?\b/gi, "命中"],
    [/\btools?\b/gi, "工具"]
  ];
  /* 状态条与组件行的文字来自 pi 扩展 / LSP，可能带 ANSI 颜色转义；直接塞进 DOM 会原样
     显示成「[38;2;102;102;102mLSP Inactive[39m」。统一剥掉：CSI（ESC [ … 字母）、
     OSC（ESC ] … BEL/ST）、以及两字节 ESC 序列。 */
  var ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
  var ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  var ANSI_SHORT = /\x1b[@-Z\\-_]/g;
  function stripAnsi(s) {
    return String(s == null ? "" : s)
      .replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_SHORT, "");
  }
  function zhStatus(s) {
    if (!s) return s;
    s = stripAnsi(s);
    for (var i = 0; i < STATUS_EN.length; i++) s = s.replace(STATUS_EN[i][0], STATUS_EN[i][1]);
    return s;
  }

  /* ================= 扩展 UI：widget / dialog =================
     pi 的扩展通过 extension_ui_request 跟界面打交道，分两类：
     - setWidget / setStatus / notify / setTitle / set_editor_text：单向，Rust 侧转成 ui.* 事件
     - select / confirm / input / editor：要回包，Rust 侧转成 ui.dialog；前端回
       send("pi.ui_response", {type:"extension_ui_response", id, ...})（ipc.rs 的 pi.ui_response 直接写 pi 的 stdin）
     pi 自己也有 timeout：到点它用默认值继续、之后再回包会被忽略，所以这里超时也同步关窗。 */

  function renderWidgets() {
    var above = $("widgets-above"), below = $("widgets-below");
    if (!above || !below) return;
    above.innerHTML = "";
    below.innerHTML = "";
    Object.keys(S.uiWidgets).forEach(function (k) {
      var w = S.uiWidgets[k];
      var host = w.placement === "below" ? below : above;
      var box = el("div", "widget");
      (w.lines || []).forEach(function (line) {
        box.appendChild(el("div", "widget-line", stripAnsi(line)));
      });
      host.appendChild(box);
    });
    above.hidden = !above.childNodes.length;
    below.hidden = !below.childNodes.length;
  }
  on("ui.widget", function (d) {
    if (!d || !d.widgetKey) return;
    // widgetLines 缺失/null 表示移除这个 key 的 widget（pi 的 setWidget(key, undefined)）
    if (d.widgetLines == null) delete S.uiWidgets[d.widgetKey];
    else S.uiWidgets[d.widgetKey] = { lines: d.widgetLines, placement: d.widgetPlacement === "belowEditor" ? "below" : "above" };
    renderWidgets();
  });

  var LAST_UI_RESPONSE = null; // 自检用：最近一次扩展回包（只记录，不参与逻辑）
  function uiRespond(id, payload) {
    var msg = { type: "extension_ui_response", id: id };
    for (var k in payload) if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
    LAST_UI_RESPONSE = msg;
    send("pi.ui_response", msg).catch(function (e) {
      toasts("回包扩展失败：" + ((e && e.message) || e), "error");
    });
  }
  /* 扩展对话框：select / confirm / input / editor 四种形态。
     关闭方式（✕ / 背景 / Esc / 超时）一律回 cancelled，让 pi 立刻拿默认值继续，不留悬挂弹窗。 */
  function uiDialog(d) {
    var method = d.method || "input";
    var back = el("div", "ui-dlg-back");
    var box = el("div", "ui-dlg");
    var head = el("div", "ui-dlg-head");
    var title = d.title || (method === "confirm" ? "确认" : method === "select" ? "请选择" : "扩展请求");
    head.appendChild(el("div", "ttl", title));
    var x = el("button", "btn btn-icon", "\u2715");
    x.title = "取消";
    head.appendChild(x);
    box.appendChild(head);
    var body = el("div", "ui-dlg-body");
    box.appendChild(body);
    var foot = el("div", "ui-dlg-foot");
    box.appendChild(foot);

    var closed = false, timer = null;
    function finish(payload) {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("keydown", onKey, true);
      if (back.parentNode) back.parentNode.removeChild(back);
      uiRespond(d.id, payload);
    }
    function cancel() { finish({ cancelled: true }); }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    }
    x.addEventListener("click", cancel);
    back.addEventListener("click", function (e) { if (e.target === back) cancel(); });
    document.addEventListener("keydown", onKey, true);
    if (d.timeout && d.timeout > 0) timer = setTimeout(cancel, d.timeout);

    var focusEl = null;
    function addFoot(okText, onOk) {
      var no = el("button", "btn", "取消");
      var ok = el("button", "btn btn-new", okText);
      no.addEventListener("click", cancel);
      ok.addEventListener("click", onOk);
      foot.appendChild(no);
      foot.appendChild(ok);
      return ok;
    }

    if (method === "select") {
      var opts = d.options || [];
      if (!opts.length) body.appendChild(el("div", "hint", "（没有可选项）"));
      var list = el("div", "ui-opts");
      opts.forEach(function (o) {
        var value = typeof o === "string" ? o : (o && o.value != null ? o.value : "");
        var label = typeof o === "string" ? o : (o && (o.label || o.name) ? (o.label || o.name) : value);
        var desc = typeof o === "string" ? "" : ((o && (o.description || o.hint)) || "");
        var li = el("button", "li ui-opt");
        li.appendChild(el("span", "t", String(label)));
        if (desc) li.appendChild(el("span", "s", String(desc)));
        li.addEventListener("click", function () { finish({ value: value }); });
        list.appendChild(li);
        if (!focusEl) focusEl = li;
      });
      body.appendChild(list);
    } else if (method === "confirm") {
      body.appendChild(el("div", "ui-msg", d.message || ""));
      focusEl = addFoot("确定", function () { finish({ confirmed: true }); });
    } else if (method === "editor") {
      var ta = el("textarea", "ui-editor");
      ta.rows = 12;
      ta.value = d.prefill == null ? "" : String(d.prefill);
      body.appendChild(ta);
      focusEl = ta;
      addFoot("提交", function () { finish({ value: ta.value }); });
    } else {
      var inp = el("input", "ui-input");
      inp.type = "text";
      inp.placeholder = d.placeholder || "";
      body.appendChild(inp);
      focusEl = inp;
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); finish({ value: inp.value }); }
      });
      addFoot("确定", function () { finish({ value: inp.value }); });
    }

    back.appendChild(box);
    document.body.appendChild(back);
    if (focusEl) setTimeout(function () { try { focusEl.focus(); if (focusEl.select && focusEl.tagName !== "TEXTAREA") focusEl.select(); } catch (e) {} }, 0);
    return back;
  }
  on("ui.dialog", function (d) { if (d && d.id != null) uiDialog(d); });
  on("pi.parse_error", function (d) { toasts("pi 输出解析失败：" + ((d && d.error) || ""), "error"); });

  /* ---- pi 事件订阅 ---- */
  on("pi.event", handleEvent);
  on("pi.stderr", function (d) { console.warn("[pi stderr] " + d.line); });
  on("pi.exit", function () {
    S.streaming = false;
    S.liveSession = null;   // pi 没了，它那条会话也就不作数了
    updateRunState(); actClear(); toasts("pi 进程已退出", "warn");
  });
  on("ui.status", function (d) {
    if (d.statusText == null) delete S.uiStatus[d.statusKey];
    else S.uiStatus[d.statusKey] = zhStatus(d.statusText);
    var vals = Object.keys(S.uiStatus).map(function (k) { return S.uiStatus[k]; });
    $("st-right").textContent = vals.join(" · ");
  });
  on("ui.notify", function (d) { toasts(d.message, d.notifyType === "error" ? "error" : d.notifyType === "warning" ? "warn" : null); });
  on("ui.title", function (d) { if (d.title) document.title = d.title; });
  on("ui.editor_text", function (d) { if (d.text != null) { $("input").value = d.text; } });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();