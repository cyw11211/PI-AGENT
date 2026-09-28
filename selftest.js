/* Pi Agent Client —— 自检／验收代码（?selftest=1 全套 / ?selftest=2 真实对话 / ?selftest=3&only=正则 单步）
   为什么单独一个文件：这套自检 2000+ 行、只在开发态用。留在 app.js 里每次启动都要解析一遍，
   拆出去后主程序小一大截（解析更快、改前端时 diff 也干净）。生产态一次都不加载。

   怎么被加载：assets/app.js 的 loadSelfTest() 动态插入 <script src="https://pi.local/selftest.js">
   （res.rs 从磁盘 assets 目录读，磁盘没有才回退到编译期内嵌副本）。

   作用域约定：app.js 整体是 (function(){ "use strict"; ... })()，符号不外露，
   所以由 app.js 的 selftestScope() 把当前符号快照成对象传进来，这里展开成同名局部变量。
   下面这些自检代码与拆分前逐字一致，只套了这一层壳。
   新增自检要用到的前端符号：app.js 的 selftestScope() 加一行 + 这里加一个同名形参。 */
window.__piSelfTestModule = function (P) {
  "use strict";
  var $ = P.$, ARG_ZH = P.ARG_ZH, HIST_PAGE = P.HIST_PAGE, HL_SHELL = P.HL_SHELL, MAX_NOTICES = P.MAX_NOTICES, RP = P.RP, S = P.S, SET = P.SET, THINK_LABEL = P.THINK_LABEL, WS = P.WS, addImageFiles = P.addImageFiles, addUserMsg = P.addUserMsg, appendText = P.appendText, applySettings = P.applySettings, b64Bytes = P.b64Bytes, closeChipPop = P.closeChipPop, closeDirPicker = P.closeDirPicker, closeModal = P.closeModal, closeModelPop = P.closeModelPop, doDelete = P.doDelete, el = P.el, emitEvent = P.emitEvent, esc = P.esc, finishTool = P.finishTool, fsRunSearch = P.fsRunSearch, fsSearchToggle = P.fsSearchToggle, generateTitle = P.generateTitle, hlApplyPre = P.hlApplyPre, hlCode = P.hlCode, hlLangOfPath = P.hlLangOfPath, hlReady = P.hlReady, hlSplit = P.hlSplit, lastUiResponse = P.lastUiResponse, loadEarlier = P.loadEarlier, loadTree = P.loadTree, maybeRestoreSession = P.maybeRestoreSession, md = P.md, normDirJs = P.normDirJs, noticeClose = P.noticeClose, noticeList = P.noticeList, noticeLive = P.noticeLive, noticeQueue = P.noticeQueue, on = P.on, openChipPop = P.openChipPop, openDirPicker = P.openDirPicker, openModal = P.openModal, openModelPop = P.openModelPop, openSession = P.openSession, presetLabel = P.presetLabel, renderAttachStrip = P.renderAttachStrip, renderChips = P.renderChips, renderModelBtn = P.renderModelBtn, renderSessions = P.renderSessions, rpActive = P.rpActive, rpCloseTab = P.rpCloseTab, rpOpenFile = P.rpOpenFile, rpOpenUrl = P.rpOpenUrl, sanitizeModelsConfig = P.sanitizeModelsConfig, saveSetting = P.saveSetting, scrollState = P.scrollState, send = P.send, setToolInput = P.setToolInput, showHistory = P.showHistory, showSystem = P.showSystem, showTools = P.showTools, streamInner = P.streamInner, submit = P.submit, thinkBlock = P.thinkBlock, toasts = P.toasts, toolCard = P.toolCard, toolPreview = P.toolPreview, toolZh = P.toolZh, unwrapEl = P.unwrapEl, updateRunState = P.updateRunState, wsPick = P.wsPick, zhResult = P.zhResult, fontSelect = P.fontSelect, THEME_COLORS = P.THEME_COLORS, fontLabel = P.fontLabel, fontStack = P.fontStack, LAY = P.LAY, applyLayout = P.applyLayout, layoutMode = P.layoutMode, rpApply = P.rpApply, rpHide = P.rpHide, rpShow = P.rpShow, sbClamp = P.sbClamp, stripAnsi = P.stripAnsi, syncBackdrop = P.syncBackdrop, usageLine = P.usageLine, LIVE_TOOLS = P.LIVE_TOOLS, endStream = P.endStream, stopLiveTools = P.stopLiveTools;
  /* ================= 无头自检（?selftest=1） =================
     selftest=3 传入 only 正则时只跑名字匹配的步骤：
     全量自检里有的用例要真调模型（img.live 可等 90s+），
     排查单个分页时不应该被它们拖住。 */
  function runSelfTest(only) {
    var report = { ok: true, stage: "start", checks: [], t0: Date.now() };
    var steps = [];
    // 诊断用：每步跑完记一次文档焦点，失焦事件也记时间（sel.popup 需要窗口在前台才挂得上选区）
    var focusLog = [];
    try { window.addEventListener("blur", function () { focusLog.push({ n: "blur", f: false, t: Date.now() - report.t0 }); }); } catch (e) {}
    function focusTrace() {
      for (var i = 0; i < focusLog.length; i++) {
        if (focusLog[i].f === false) return focusLog[i].n + "@" + focusLog[i].t + "ms";
      }
      return "无";
    }
    // 每一步都挂 30s 上限：自检自己卡死会永远不写报告（整套跑完却拿不到 json，最难查）。
    // 超时按「该步失败」记账，后续步骤继续跑，报告一定能落盘。
    var STEP_TIMEOUT = 30000;
    // 自检夹具用的项目根：Cargo.toml 在 源码\ 那一层（文件树用例靠它认行）。
    // 项目以前在 D:\新建文件夹\pi-webview，搬走后夹具还指着旧路径，
    // 导致 fs.dir / fs.gitroot / fs.upload / rp.tree-open / rp.persist 一串假失败。
    var PROJ = "E:\\pi-webview-1.0";
    var PROJ_SRC = PROJ + "\\源码";
    var TMP_DIR = PROJ + "\\临时文件";
    // 轮询等待：子代理/插件分页要等后端回包，固定 sleep 拍脑袋必然拍空。
    // 返回第一个真值；超时返回 null（由调用方自己的断言报具体缺什么）。
    function until(fn, ms, stepMs) {
      var t0 = Date.now();
      return new Promise(function (res) {
        (function tick() {
          var v = null;
          try { v = fn(); } catch (e) { v = null; }
          if (v) return res(v);
          if (Date.now() - t0 > (ms || 4000)) return res(null);
          setTimeout(tick, stepMs || 80);
        })();
      });
    }
    function step(name, fn, timeoutMs) {
      if (only && !only.test(name)) return;
      steps.push(function () {
        var timer = null;
        var guard = new Promise(function (_res, rej) {
          timer = setTimeout(function () { rej(new Error("步骤超时 " + Math.round((timeoutMs || STEP_TIMEOUT) / 1000) + "s")); }, timeoutMs || STEP_TIMEOUT);
        });
        return Promise.race([Promise.resolve().then(fn), guard])
          .then(function (v) {
            clearTimeout(timer);
            focusLog.push({ n: name, f: document.hasFocus(), t: Date.now() - report.t0 });
            report.checks.push({ name: name, ok: true, value: v });
          })
          .catch(function (e) {
            clearTimeout(timer);
            focusLog.push({ n: name, f: document.hasFocus(), t: Date.now() - report.t0 });
            report.ok = false;
            report.checks.push({ name: name, ok: false, error: String(e && e.message || e) });
          });
      });
    }

    step("fs.home", function () { return send("fs.list", { path: "~" }).then(function (r) { return r.display; }); });
    step("fs.dir", function () {
      return send("fs.list", { path: PROJ_SRC }).then(function (r) {
        return r.entries.length + " entries";
      });
    });
    step("fs.gitroot", function () {
      return send("fs.gitroot", { path: PROJ_SRC }).then(function (r) { return String(r.root); });
    });
    // 上传：走真实 fs.write 落盘，再校验文件真在、字节数对得上。
    step("fs.upload", function () {
      var dir = TMP_DIR;
      var name = "selftest-upload.txt";
      var payload = "上传自检 " + Date.now();
      var b64 = btoa(unescape(encodeURIComponent(payload)));
      // 注意：中文 payload 的 JS .length 算的是 UTF-16 字符数，落盘的是 UTF-8 字节数。
      // 必须拿 UTF-8 字节数去比，否则中文会假报“字节数不对”。
      function utf8Len(str) {
        var n = 0;
        for (var i = 0; i < str.length; i++) {
          var c = str.charCodeAt(i);
          n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
        }
        return n;
      }
      var expect = utf8Len(payload);
      return send("fs.write", { dir: dir, name: name, dataBase64: b64 }).then(function (r) {
        if (r.size !== expect) throw new Error("字节数不对 " + r.size + " != " + expect);
        return send("fs.list", { path: dir }).then(function (l) {
          var hit = null;
          for (var i = 0; i < l.entries.length; i++) {
            if (l.entries[i].name === r.name) hit = l.entries[i];
          }
          if (!hit) throw new Error("落盘后列目录没找到 " + r.name);
          return "写入 " + r.name + " " + hit.size + " bytes";
        });
      });
    });
    step("session.list", function () {
      return send("session.list").then(function (r) { return r.sessions.length + " sessions @ " + r.dir; });
    });
    // 残缺会话守门：切换前 session.probe 必须先把它拦下来，而且不能真切过去。
    // 背景：pi 对缺会话头的碎片文件会抛 “Session file is not a valid pi session”，
    // 抛之前还会把扩展运行时拆掉重建，界面上连带弹两条与本次切换无关的扩展错误。
    step("session.probe", function () {
      var dir = "~/.pi/agent/sessions/_selftest";
      var name = "probe-broken.jsonl";
      var b64 = btoa('{"type":"toolResult","timestamp":"2026-09-21T01:46:44.000Z"}\n');
      var before = S.activeSession;
      return send("fs.write", { dir: dir, name: name, dataBase64: b64 })
        .then(function () { return send("session.probe", { path: dir + "/" + name }); })
        .then(function (r) {
          if (r.valid !== false) throw new Error("残缺会话没被拦下：" + JSON.stringify(r));
          var sorted = (S.sessions || []).slice().sort(function (a, b) { return (b.messages || 0) - (a.messages || 0); });
          if (!sorted.length) throw new Error("没有正常会话可对照");
          return send("session.probe", { path: sorted[0].path }).then(function (r2) {
            if (r2.valid !== true) throw new Error("正常会话被误杀：" + JSON.stringify(r2));
            // 真正走一遍 UI 入口：必须原地停下，不换会话
            return openSession(dir + "/" + name).then(function () {
              if (S.activeSession !== before) throw new Error("残缺会话竟然切换成功了");
              return "拦下残缺 · 放行正常 · 当前会话未变";
            });
          });
        })
        .then(function (v) {
          return send("fs.delete", { path: dir + "/" + name })
            .catch(function () {})
            .then(function () { return v; });
        });
    });
    // 打开最大的会话：走 openSession（磁盘 jsonl 尾部一页），具体分段耗时见 dbg 日志的
    // [历史] 与 [打开会话] 两行。
    step("open.speed", function () {
      if (!S.sessions.length) throw new Error("没有会话可开");
      var big = S.sessions.slice().sort(function (a, b) { return (b.messages || 0) - (a.messages || 0); })[0];
      var t0 = Date.now();
      return openSession(big.path).then(function () {
        return "最大会话 " + (big.messages || 0) + " 条 · 打开 " + (Date.now() - t0) + "ms · DOM " +
               streamInner.children.length + " 节点 · 已载 " + (S.hist ? S.hist.shown : 0) + " 条 · 按钮" +
               ($("hist-more").hidden ? "隐藏" : "显示");
      });
    });
    // 往上翻页：直接打协议层，拿两页的真实条数与字节偏移（不依赖会话够不够大）
    step("hist.page", function () {
      if (!S.sessions.length) throw new Error("没有会话");
      var big = S.sessions.slice().sort(function (a, b) { return (b.messages || 0) - (a.messages || 0); })[0];
      return send("session.tail", { path: big.path, limit: 5, before: 0 }).then(function (p1) {
        if (!p1.messages.length) throw new Error("尾部一页是空的");
        if (p1.messages.length > 5) throw new Error("limit 没生效：" + p1.messages.length);
        if (p1.total <= 5) return "跳过（最大会话只有 " + p1.total + " 条）";
        if (!p1.hasMore) throw new Error("还有更早的却报 hasMore=false（total=" + p1.total + "）");
        return send("session.tail", { path: big.path, limit: 5, before: p1.startByte }).then(function (p2) {
          if (!p2.messages.length) throw new Error("上一页是空的");
          if (p2.startByte >= p1.startByte) throw new Error("向上翻页偏移没变小");
          return "limit=5 → " + p1.messages.length + " 条/共 " + p1.total + " · 上一页 " + p2.messages.length +
                 " 条 · 偏移 " + p1.startByte + "→" + p2.startByte;
        });
      });
    });
    // 全卷最大的会话（不限当前目录）：真走一遍「点开历史」的 UI 路径，
    // 验证大会话也只渲染一页（DOM 有界）、向上翻页能接上。
    step("hist.big", function () {
      return send("session.list", {}).then(function (r) {
        var all = r.sessions || [];
        if (!all.length) throw new Error("索引里没有会话");
        var big = all.slice().sort(function (a, b) { return (b.messages || 0) - (a.messages || 0); })[0];
        // ① 协议层：只回一页，且要快
        var t0 = Date.now();
        return send("session.tail", { path: big.path, limit: HIST_PAGE, before: 0 }).then(function (p) {
          var ms = Date.now() - t0;
          if ((p.messages || []).length > HIST_PAGE) throw new Error("一页超了：" + p.messages.length);
          if (p.total <= 0) throw new Error("total 为 0");
          // ② UI 层：打开 + 渲染
          var t1 = Date.now();
          return openSession(big.path).then(function () {
            var openMs = Date.now() - t1;
            var dom = streamInner.children.length;
            if (!S.hist || S.hist.path !== big.path) throw new Error("历史状态没落在目标会话上");
            if (S.hist.shown > HIST_PAGE) throw new Error("首屏超一页：" + S.hist.shown);
            if (dom > HIST_PAGE * 3) throw new Error("DOM 没被限流：" + dom + " 节点");
            if ($("hist-more").hidden) throw new Error("还有更早的消息却没显示按钮");
            var was = S.hist.shown;
            // ③ 向上翻一页
            var t2 = Date.now();
            return loadEarlier().then(function () {
              if (S.hist.shown <= was) throw new Error("翻页没接上：还是 " + S.hist.shown + " 条");
              return "最大会话 " + (big.messages || 0) + " 条 · 取尾一页 " + ms + "ms · 打开(含 pi 切换) " +
                     openMs + "ms · DOM " + dom + " 节点 · 再翻一页 " + (Date.now() - t2) + "ms → " +
                     S.hist.shown + "/" + S.hist.total;
            });
          });
        });
      });
    });
    // 会话列表按目录过滤：session.list 带上 cwd 后只回本目录，并给出其它目录的数量
    step("sessions.cwd", function () {
      return send("session.list", { cwd: S.cwd }).then(function (r) {
        if (typeof r.otherCount !== "number") throw new Error("没回 otherCount");
        // 客户端也要自己校一遍：列表里不能混进别的目录的会话
        var self = normDirJs(S.cwd);
        if ((r.sessions || []).some(function (s) { return normDirJs(s.cwd) !== self; })) {
          throw new Error("列表里混进了别的目录的会话");
        }
        return (r.sessions || []).length + " 个 @ " + r.dir + " · 其它目录 " + r.otherCount;
      });
    });
    // 目录选择模态：开→路径框有值→列子目录→关
    step("dir.pick", function () {
      if ($("dir-pick").hidden === false) throw new Error("一开始就开着");
      return openDirPicker("~").then(function () {
        if ($("dir-pick").hidden) throw new Error("没打开");
        var p = $("dp-path").value;
        if (!p) throw new Error("路径框是空的");
        var rows = $("dp-list").querySelectorAll(".dp-row").length;
        if (!rows) throw new Error("~ 下没有列出任何子目录");
        closeDirPicker();
        if (!$("dir-pick").hidden) throw new Error("关不掉");
        return "路径=\"" + p.slice(0, 26) + "\" 子目录=" + rows + " 开关=ok";
      });
    });
    step("settings", function () {
      return send("settings.get").then(function (s) { return "piRunning=" + s.piRunning + " cfg=" + s.configPath; });
    });
    step("pi.state", function () {
      return send("pi.call", { type: "get_state" }).then(function (r) {
        if (!r.success) throw new Error(JSON.stringify(r));
        return r.data.model.id + " keys=" + Object.keys(r.data).length;
      });
    });
    step("pi.models", function () {
      return send("pi.call", { type: "get_available_models" }).then(function (r) { return r.data.models.length + " models"; });
    });
    step("pi.stats", function () {
      return send("pi.call", { type: "get_session_stats" }).then(function (r) {
        if (!r.success) throw new Error(JSON.stringify(r));
        return "messages=" + r.data.totalMessages;
      });
    });
    step("pi.commands", function () {
      return send("pi.call", { type: "get_commands" }).then(function (r) { return r.data.commands.length + " commands"; });
    });
    step("ui.meter", function () {
      return Promise.resolve($("m-in").textContent + "/" + $("m-window").textContent);
    });
    step("ui.restore", function () {
      // 直接跑真实的恢复路径，并报告 DOM 实际渲染出的节点数。
      // 只查 RPC 返回值会骗人（数据到了、DOM 为空）。
      return maybeRestoreSession().then(function () {
        return send("pi.call", { type: "get_messages" }).then(function (ms) {
          var m = (ms.data && ms.data.messages) || [];
          return "activeSession=" + (S.activeSession || "(空)").split("\\").pop() +
            " | stream children=" + streamInner.children.length +
            " | rawMsgs=" + m.length;
        });
      });
    });
    step("ui.restore.raw", function () {
      return send("pi.call", { type: "get_messages" }).then(function (ms) {
        var m = (ms.data && ms.data.messages) || [];
        return "rawMsgs=" + m.length + " | roles=" + m.slice(0, 4).map(function (x) { return x.role; }).join(",");
      });
    });
    step("ui.bootdump", function () {
      // 启动后直接看消息流首子节点，不需要切会话
      var nodes = streamInner.children;
      // 把与“空框”区域（主区上部）相交的所有元素找出来，避免看图猜元素
      var hits = [];
      var all = document.querySelectorAll("body *");
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        var r = e.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top < 140 && r.bottom > 30 && r.left > 270) {
          var st = getComputedStyle(e);
          hits.push(e.tagName + "." + e.className + "[" +
            [r.left, r.top, r.width, r.height].map(function (v) { return Math.round(v); }).join(",") +
            "] border=" + st.borderTopWidth + " bg=" + st.backgroundColor +
            " txt=\"" + (e.textContent || "").slice(0, 24) + "\"");
        }
      }
      return "streamInner n=" + nodes.length + " || " + hits.slice(0, 12).join(" ;; ");
    });
    step("ui.streamdump", function () {
      // 选中第一个会话，重建消息流，然后把前两个节点的结构回报，
      // 用于定位“空框”这类样式问题（截图看不出是哪个节点）
      var s = S.sessions[0];
      if (!s) throw new Error("无会话");
      return send("pi.call", { type: "switch_session", params: { sessionPath: s.path } }).then(function () {
        return new Promise(function (r) { setTimeout(r, 700); });
      }).then(function () {
        var nodes = streamInner.children;
        var out = [];
        for (var i = 0; i < Math.min(3, nodes.length); i++) {
          var n = nodes[i];
          out.push(n.className + "{" + n.outerHTML.replace(/\s+/g, " ").slice(0, 400) + "}");
        }
        return "total=" + nodes.length + " | " + out.join(" || ");
      });
    });
    step("ui.tree", function () {
      var n = $("file-tree").querySelectorAll(".node").length;
      if (n === 0) throw new Error("文件树为空");
      return n + " nodes";
    });
    step("ui.sessions", function () {
      return document.querySelectorAll("#session-list .sess").length + " rendered";
    });
    /* 会话行上的按钮按 title 找，不按下标——再加一个按钮就不会把下标全挪位 */
    function sessBtn(row, kw) {
      var bs = row.querySelectorAll(".sess-acts button");
      for (var i = 0; i < bs.length; i++) {
        if ((bs[i].title || "").indexOf(kw) === 0) return bs[i];
      }
      return null;
    }
    /* 会话行悬停按钮：默认必须不可见（否则行一直挤着三个图标），
       悬停才出来。JS 无法伪造 :hover，所以直接查 CSSOM 里那条规则。 */
    step("ui.sess.acts", function () {
      var rows = document.querySelectorAll("#session-list .sess");
      if (!rows.length) throw new Error("没有会话行");
      var acts = rows[0].querySelector(".sess-acts");
      if (!acts) throw new Error("第一行没有 .sess-acts");
      var btns = acts.querySelectorAll("button");
      if (btns.length !== 3) throw new Error("按钮数 " + btns.length + " != 3（导出/改名/删除）");
      if (!sessBtn(rows[0], "导出")) throw new Error("没有导出按钮");
      if (!sessBtn(rows[0], "重命名")) throw new Error("没有重命名按钮");
      if (getComputedStyle(acts).display !== "none") {
        throw new Error("未悬停时按钮应隐藏，实为 " + getComputedStyle(acts).display);
      }
      var hoverOk = false;
      for (var i = 0; i < document.styleSheets.length; i++) {
        var rules;
        try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
        for (var j = 0; j < rules.length; j++) {
          var r = rules[j];
          if (r.selectorText && r.selectorText.indexOf(".sess:hover .sess-acts") >= 0 && r.style.display === "flex") hoverOk = true;
        }
      }
      if (!hoverOk) throw new Error("CSS 里没有 .sess:hover .sess-acts{display:flex}");
      return btns.length + " 按钮 悬停规则=ok 默认隐藏=ok";
    });
    /* 改名：点铅笔→就地变输入框；Esc 不改任何东西（重命名要真写盘，
       自检里不能乱改用户已经命名的会话）。 */
    step("ui.sess.rename", function () {
      var row = document.querySelector("#session-list .sess");
      sessBtn(row, "重命名").click();
      return new Promise(function (r) { setTimeout(r, 120); }).then(function () {
        var input = document.querySelector("#session-list .sess-rename");
        if (!input) throw new Error("没有出现 .sess-rename 输入框");
        if (!input.value) throw new Error("输入框是空的（应该预填当前标题）");
        var before = input.value;
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return new Promise(function (r) { setTimeout(r, 120); }).then(function () {
          if (document.querySelector("#session-list .sess-rename")) throw new Error("Esc 后输入框还在");
          // 必须重新查：renderSessions() 会整列表重建，
          // 之前抓的 row 已经是脱离文档的旧节点，在它身上断言等于什么都没验。
          var fresh = document.querySelector("#session-list .sess");
          if (fresh.classList.contains("editing")) throw new Error("Esc 后 editing 类没摘");
          if (!fresh.querySelector(".sess-acts")) throw new Error("Esc 后按钮组没回来");
          return "预填=\"" + before.slice(0, 12) + "\" Esc 还原=ok";
        });
      });
    });
    /* 改名真写盘：把活动会话改成它现有名字（同值写入 = 不掳乱用户数据），
       只验证 set_session_name 这个调用形状真的被 pi 接受。
       不同值的那一路由已有的 topbar.title（生成标题）覆盖。 */
    step("ui.sess.rename.write", function () {
      return send("pi.call", { type: "get_state" }).then(function (st) {
        var cur = (st && st.data && st.data.sessionName) || S.sessionName || "";
        if (!cur) return "跳过（当前会话没有名字）";
        return send("pi.call", { type: "set_session_name", params: { name: cur } }).then(function (r) {
          if (!r || r.success === false) throw new Error("set_session_name 被拒: " + JSON.stringify(r));
          if (S.sessionName && S.sessionName !== cur) throw new Error("本地 sessionName 不一致");
          return "同值写入\"" + cur.slice(0, 14) + "\" 被接受";
        });
      });
    });
    /* 删除确认：点垃圾桶→整行换成「删除 xxx？+ 删除 / 取消」，点取消要原样恢复。
       自检绝不真删——真删那一步用下面 os.delete 拿临时文件自己验。 */
    step("ui.sess.del.confirm", function () {
      var row = document.querySelector("#session-list .sess");
      var title = row.querySelector(".sess-title").textContent;
      sessBtn(row, "删除").click();
      return new Promise(function (r) { setTimeout(r, 120); }).then(function () {
        var cur = document.querySelector("#session-list .sess");
        if (!cur.classList.contains("confirm")) throw new Error("没有进入 confirm 态");
        var ask = cur.querySelector(".sess-ask");
        if (!ask) throw new Error("没有 .sess-ask 提示语");
        if (ask.textContent.indexOf("删除") !== 0) throw new Error("提示语不对: " + ask.textContent);
        if (!cur.querySelector(".sess-confirm-btn")) throw new Error("没有确认删除按钮");
        var no = cur.querySelector(".sess-cancel-btn");
        if (!no) throw new Error("没有取消按钮");
        no.click();
        return new Promise(function (r) { setTimeout(r, 150); }).then(function () {
          var back = document.querySelector("#session-list .sess");
          if (back.classList.contains("confirm")) throw new Error("取消后还在 confirm 态");
          if (!back.querySelector(".sess-acts")) throw new Error("取消后按钮组没恢复");
          return "提示语=\"" + ask.textContent.slice(0, 16) + "\" 取消还原=ok（未真删）";
        });
      });
    });
    /* 草稿：输入 → 防抖落盘 → 取回回填；再单独验 draftFlush（切会话时靠它保命）。
       全程只动 localStorage 和输入框，不碰会话文件。 */
    step("ui.draft", function () {
      var path = S.activeSession;
      if (!path) return "跳过（没有活动会话）";
      var ta = $("input");
      var before = ta.value;
      P.draftSave(path, "");
      var text = "自检草稿 " + Date.now();
      ta.value = text;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      return new Promise(function (r) { setTimeout(r, 420); }).then(function () {
        var st = P.draftState();
        if (st.text !== text) throw new Error("防抖后没落盘: " + JSON.stringify(st.text));
        // draftFlush：不触发 input 事件也能存（切会话时走的就是这条路）
        ta.value = text + "-flush";
        P.draftFlush();
        if (P.draftGet(path) !== text + "-flush") throw new Error("draftFlush 没存: " + P.draftGet(path));
        ta.value = "";
        P.setInputText(P.draftGet(path));
        if (ta.value !== text + "-flush") throw new Error("回填失败: " + ta.value);
        if (!(parseInt(ta.style.height, 10) > 0)) throw new Error("回填后没自适应高度");
        P.draftSave(path, "");
        ta.value = before;
        if (P.draftState().text) throw new Error("清理失败，草稿还在");
        return "防抖落盘 · draftFlush · 回填自适应 全 ok（已清理）";
      });
    });
    /* 导出 Markdown：只验组装，绝不点导出按钮（会弹系统另存为对话框，自检卡死在等人点）。
       fetchAllMessages 会真读会话文件（含按 startByte 向前翻页），所以条数/正文都来自盘上。 */
    step("ui.sess.export", function () {
      var paths = [S.activeSession].filter(Boolean);
      [].slice.call(document.querySelectorAll("#session-list .sess")).forEach(function (d) {
        if (d.title) paths.push(d.title);
      });
      var tried = [];
      function attempt(i) {
        if (i >= paths.length) throw new Error("没有会话能读出消息（试过 " + tried.join(" / ") + "）");
        return P.fetchAllMessages(paths[i]).then(function (msgs) {
          tried.push(String(paths[i]).slice(-20) + "=" + msgs.length);
          if (!msgs.length) return attempt(i + 1);
          var text = P.buildSessionMd({ title: "自检导出", path: paths[i], cwd: S.cwd }, msgs);
          if (text.indexOf("# ") !== 0) throw new Error("Markdown 没以一级标题开头");
          if (text.indexOf("- 会话文件：`") < 0) throw new Error("缺「会话文件」行");
          if (text.indexOf("\n---\n") < 0) throw new Error("缺分隔线");
          if (text.indexOf("### ") < 0) throw new Error("正文里没有消息小节");
          if (text.indexOf("[object") >= 0) throw new Error("正文里混进了 [object …]");
          var bad = P.safeFileName('a/b\\c:d*e?f"g<h>i|j');
          if (/[\\/:*?"<>|]/.test(bad)) throw new Error("文件名没净化: " + bad);
          return msgs.length + " 条 -> " + text.length + " 字 Markdown（未弹对话框）";
        });
      }
      return attempt(0);
    });
    /* 从此处编辑：真点会把当前会话分叉掉，自检不能干这事。
       所以只验 ①用户气泡带操作条且默认隐藏、悬停规则真在 CSS 里 ②entry 匹配纯函数
       ③pi 侧 get_fork_messages 能读到候选（只读）。 */
    step("ui.fork.acts", function () {
      var wrap = document.querySelector("#stream .msg.user");
      if (!wrap) return "跳过（当前历史里没有用户消息）";
      if (!wrap._rawText) throw new Error("用户气泡没存 _rawText，无法定位 entry");
      var bar = wrap.querySelector(".msg-acts");
      if (!bar) throw new Error("用户气泡没有 .msg-acts 操作条");
      var bs = bar.querySelectorAll("button");
      if (bs.length !== 2) throw new Error("操作条按钮数 " + bs.length + " != 2（复制/从此处编辑）");
      if (getComputedStyle(bar).display !== "none") {
        throw new Error("未悬停时操作条应隐藏，实为 " + getComputedStyle(bar).display);
      }
      var hoverOk = false;
      for (var i = 0; i < document.styleSheets.length; i++) {
        var rules;
        try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
        for (var j = 0; j < rules.length; j++) {
          var r = rules[j];
          if (r.selectorText && r.selectorText.indexOf(".msg.user:hover .msg-acts") >= 0 && r.style.display === "flex") hoverOk = true;
        }
      }
      if (!hoverOk) throw new Error("CSS 里没有 .msg.user:hover .msg-acts{display:flex}");
      var list = [{ entryId: "a", text: "x" }, { entryId: "b", text: "y" }, { entryId: "c", text: "x" }];
      if (P.pickForkEntry(list, "x", 0).entryId !== "c") throw new Error("末尾匹配错（应从末尾数）");
      if (P.pickForkEntry(list, "x", 1).entryId !== "a") throw new Error("往前一条匹配错");
      if (P.pickForkEntry(list, "zzz", 0) !== null) throw new Error("找不到时应返回 null");
      if (P.pickForkEntry(list, "x", 5) !== null) throw new Error("越界应返回 null");
      return send("pi.call", { type: "get_fork_messages" }).then(function (r) {
        var n = (((r || {}).data || {}).messages || []).length;
        return "操作条 2 按钮 悬停规则=ok · 匹配纯函数 4 例 · pi 候选 " + n + " 条（未真 fork）";
      });
    });
    /* 工作树后端：拿已知在 git 仓库里的目录（源码目录）真跑一次 worktree list --porcelain。
       本机没装 git 时这条降级为「报错文案要人话」，并在返回值里写明断言未执行。 */
    step("git.worktrees", function () {
      return send("git.worktrees", { cwd: PROJ_SRC }).then(function (r) {
        var items = (r && r.items) || [];
        if (!items.length) throw new Error("没有工作树条目");
        var cur = items.filter(function (x) { return x.current; });
        if (cur.length !== 1) throw new Error("current 标记 " + cur.length + " 个（应为 1）");
        if (P.normDirJs(cur[0].path) !== P.normDirJs(r.root)) throw new Error("current 与 root 不一致: " + cur[0].path);
        if (!cur[0].head || cur[0].head.length !== 8) throw new Error("HEAD 缩写不对: " + cur[0].head);
        return items.length + " 个工作树 · root=" + String(r.root).slice(-20) + " · HEAD=" + cur[0].head;
      }, function (err) {
        var m = String((err && err.message) || err);
        if (/program not found|未安装 git|not recognized/i.test(m)) {
          return "跳过：本机没有 git 命令（" + m.slice(0, 36) + "）——条目/current/HEAD 断言未执行";
        }
        throw new Error("git.worktrees 失败: " + m);
      });
    });
    /* 工作树菜单：是仓库就列条目+新建表单（不真建），不是仓库就得给一句人话提示。
       本机没 git 时走的是「提示 + 不开菜单」这条真路径，UI 部分再用合成数据单独验一遍
       （renderWtMenu 是纯渲染，直接喂假条目；不碰磁盘也不调 git）。 */
    step("ui.wt.menu", function () {
      var btn = $("btn-worktrees");
      if (!btn) throw new Error("侧栏没有 #btn-worktrees");
      var box = $("wt-menu");
      if (!box) throw new Error("没有 #wt-menu");
      function warned() {
        return P.noticeLive().filter(function (n) {
          var t = n.textContent || "";
          return t.indexOf("Git 仓库") >= 0 || t.indexOf("git 命令") >= 0;
        })[0] || null;
      }
      function checkForm(rows, tag) {
        var on = box.querySelector(".ws-scroll .ws-item.on");
        if (rows >= 1 && !on) throw new Error(tag + "：当前工作树没打勾");
        var form = box.querySelector(".wt-form");
        if (!form) throw new Error(tag + "：没有新建表单");
        var ins = form.querySelectorAll(".wt-in");
        if (ins.length !== 2) throw new Error(tag + "：表单输入框 " + ins.length + " 个（应为 2）");
        if (!ins[0].value || !ins[1].value) throw new Error(tag + "：表单默认值没预填");
        ins[0].value = "selftest-branch";
        ins[0].dispatchEvent(new Event("input", { bubbles: true }));
        if (ins[1].value.indexOf("selftest-branch") < 0) throw new Error(tag + "：目录没跟分支名联动: " + ins[1].value);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        if (!box.hidden) throw new Error(tag + "：Esc 没关掉菜单");
        return tag + "：" + rows + " 条 · 勾=" + (on ? on.textContent.trim().slice(0, 16) : "-") + " · 表单联动=ok（未真建）";
      }
      btn.click();
      return until(function () { return !box.hidden || warned(); }, 3000).then(function (ok) {
        if (!ok) throw new Error("点了工作树按钮，菜单没开也没提示（S.cwd=" + S.cwd + "）");
        if (!box.hidden) return checkForm(box.querySelectorAll(".ws-scroll .ws-item").length, "真菜单（git 可用）");
        var msg = warned().textContent.trim();
        P.renderWtMenu([
          { path: S.cwd, head: "abc12345", branch: "main" },
          { path: "C:\\selftest-wt", head: "def67890", branch: "wt-x" }
        ], "C:\\selftest-root");
        box.hidden = false;
        if (box.querySelectorAll(".ws-scroll .ws-item").length !== 2) throw new Error("合成渲染没出 2 条工作树");
        if (!box.querySelector(".ws-item.action")) throw new Error("当前工作树不是 root 时应有「删除当前工作树」按钮");
        return "提示「" + msg.slice(0, 20) + "」=ok · " + checkForm(2, "合成数据");
      });
    });
    /* 工作目录下拉：当前目录打勾、固定两个动作项、Esc 关闭 */
    step("ui.ws.menu", function () {
      $("ws-btn").click();
      var box = $("ws-menu");
      if (box.hidden) throw new Error("点了没展开");
      var items = box.querySelectorAll(".ws-item");
      if (items.length < 3) throw new Error("菜单项过少 " + items.length);
      var first = items[0];
      if (!first.classList.contains("on")) throw new Error("当前目录没打勾");
      if (!first.querySelector(".ws-tick svg")) throw new Error("没有勾图标");
      var texts = [];
      for (var i = 0; i < items.length; i++) texts.push(items[i].textContent.trim());
      if (texts.join("|").indexOf("使用默认目录") < 0) throw new Error("缺「使用默认目录」");
      if (texts.join("|").indexOf("自定义路径…") < 0) throw new Error("缺「自定义路径…」");
      var label = $("ws-path").textContent.trim();
      if (!label) throw new Error("按钮上的路径是空的");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (!box.hidden) throw new Error("Esc 没关掉");
      return items.length + " 项 勾=" + first.textContent.trim().slice(0, 14) + " 按钮=\"" + label.slice(0, 14) + "\"";
    });
    /* 真切换：切到默认目录再切回 ~，并校验按钮文字/文件树根都跟着变 */
    step("ui.ws.switch", function () {
      if (!WS.def) return "跳过（未配置默认目录）";
      var home = S.cwd;
      return wsPick(WS.def).then(function (r) {
        if (S.cwd !== WS.def) throw new Error("cwd 没变: " + S.cwd);
        var label = $("ws-path").textContent.trim();
        if (label !== (r.display || r.path)) throw new Error("按钮文字没跟着变: " + label);
        if (!document.querySelector("#file-tree .node")) throw new Error("切完文件树是空的");
        return wsPick(home).then(function (r2) {
          if (S.cwd !== home) throw new Error("切回失败: " + S.cwd);
          return "切到默认目录再切回 ok（" + (r.display || r.path).slice(0, 20) + "）";
        });
      });
    });
    /* 真删盘：在一临时子目录里写一个 .jsonl，把它当成会话条目走 doDelete 全链路，
       最后断言 ①文件真没了（再删一次应报「找不到」）②已从 S.sessions 里摘掉。
       顺便验 fs.delete 的沙箱：项目目录下的文件必须被拒。 */
    step("os.delete", function () {
      var dir = "~/.pi/agent/sessions/_selftest";
      var name = "selftest-" + Date.now() + ".jsonl";
      var text = '{"title":"自检临时会话","name":"selfcheck"}\n{"role":"user","content":"x"}\n';
      var payload = btoa(unescape(encodeURIComponent(text)));
      return send("fs.write", { dir: dir, name: name, dataBase64: payload }).then(function (w) {
        var s = { path: w.path, title: "自检临时会话", name: "selfcheck", messages: 2, mtime: Date.now(), running: false };
        S.sessions = [s].concat(S.sessions);
        return doDelete(s).then(function () {
          var left = S.sessions.filter(function (x) { return x.path === w.path; });
          if (left.length) throw new Error("删完 S.sessions 里还在");
          return send("fs.delete", { path: w.path }).then(
            function () { throw new Error("文件没被删掉：第二次删居然还能成功"); },
            function (e) {
              if (!/找不到/.test(e.message)) throw new Error("第二次删报错不对: " + e.message);
              return send("fs.delete", { path: PROJ_SRC + "\\Cargo.toml" }).then(
                function () { throw new Error("沙箱没拦住：居然潜到了项目目录"); },
                function (e2) {
                  if (!/只允许删除/.test(e2.message)) throw new Error("沙箱报错不对: " + e2.message);
                  return "临时文件已删 + 二次删报找不到 + 项目目录被拒";
                }
              );
            }
          );
        });
      });
    });
    step("modal.tabs", function () {
      openModal("general");
      var n = $("modal-tabs").querySelectorAll(".tab").length;
      closeModal();
      if (n !== 5) throw new Error("分页数 " + n + " != 5");
      return n + " tabs";
    });
    // 逐个真开一遍五个分页，并把渲染出来的控件数量报出来。
    // 只有 DOM 真的长出来了才算数——“分页按钮存在”不等于“分页内容能渲染”。
    // 常规页是卡片 + 开关 + 滑块；其余四页是左列表 / 右详情。
    ["general", "models", "skills", "agents", "extensions"].forEach(function (tab) {
      step("modal." + tab, function () {
        // 不管断言过不过都要关掉弹窗：弹窗开着时选中浮窗按设计不弹，
        // 一步失败会传染给后面的 sel.popup（白查一趟）。
        function fin(v) { closeModal(); return v; }
        function boom(e) { closeModal(); throw e; }
        openModal(tab);
        // 子代理/插件两页要等后端回包（node 侧枚举包），固定 450ms 会拍空。
        // 但也不能拿上一页也有的东西当“渲染好了”的信号：renderTab 是先清空、
        // 再等 loadSettings 回来异步重建，切页那一瞬间 #modal-body 里还是上一页的 DOM。
        // 以前拿 .split-list .li 等，结果 modal.skills 拿着 models 页的 DOM 蒙混过关、
        // modal.agents 报「右栏无卡片」。所以每页等只有这一页才有的标记。
        var MARK = {
          general: ".card-row",
          models: ".split-list .md-pv",
          skills: ".split-right .sk-flabel",
          agents: ".split-right .sa-card",
          extensions: ".split-right .kv dt"
        }[tab];
        return until(function () {
          return $("modal-body").querySelector(MARK);
        }, 8000).then(function () {
          var body = $("modal-body");
          var rows = body.querySelectorAll(".card-row").length;
          var secs = body.querySelectorAll(".sec-title").length;
          var split = !!body.querySelector(".split-left");
          var text = body.textContent.replace(/\s+/g, " ").trim();
          if (tab === "general") {
            if (rows < 5 || secs < 4) throw new Error("常规页控件过少 rows=" + rows + " secs=" + secs);
          } else if (!split) {
            throw new Error(tab + " 未渲染左右分栏");
          }
          if (text.length < 20) throw new Error("空分页：" + tab);
          // 非通用页都是左列表 + 右详情，两侧都必须真有东西。
          // 以前只查了 .split 存在，右栏报错只剩一行提示也能过。
          var lis = body.querySelectorAll(".split-list .li").length;
          var trs = body.querySelectorAll(".split-right .table tr").length;
          // 右栏「真的有字段」的几种形态：dl.kv（插件页）、.sk-flabel（技能页）、
          // .md-fld（模型页）、label（其它表单）都算。以前只认前两种，
          // 模型页换成 .md-fld 后会被误报成「右详情为空」。
          var dts = body.querySelectorAll(".split-right .kv dt").length
            + body.querySelectorAll(".split-right .sk-flabel").length
            + body.querySelectorAll(".split-right .md-fld").length;
          var rtxt = (body.querySelector(".split-right") || { textContent: "<无右栏>" })
            .textContent.replace(/\s+/g, " ").trim().slice(0, 160);
          if (tab !== "general") {
            if (lis === 0) throw new Error(tab + " 左列表为空 :: " + rtxt);
            // 子代理页右栏是表单/只读卡（无 table / dl.kv），所以额外认 .sa-card。
            var cards = body.querySelectorAll(".split-right .sa-card").length;
            if (tab === "agents") {
              if (cards === 0) throw new Error("agents 右栏无卡片 :: " + rtxt);
              var head = body.querySelectorAll(".sa-head").length;
              if (head === 0) throw new Error("agents 缺少顶部开关栏");
              var segs = body.querySelectorAll(".split-list .grp").length;
              if (segs === 0) throw new Error("agents 左列表没有分组标题");
              // 内置详情必须带「创建副本」+ 只读字段；开关、并发数输入框得在
              var btns = body.querySelectorAll(".split-right .sa-cardhead .btn").length;
              var ros = body.querySelectorAll(".split-right .sa-ro").length;
              if (ros < 3) throw new Error("agents 内置详情只读字段过少 " + ros);
              if (!/创建副本/.test(body.textContent)) throw new Error("agents 缺少「创建副本」");
              var conc = body.querySelectorAll(".sa-headright input").length;
              if (conc === 0) throw new Error("agents 缺少并发数输入框");
              if (!/启用 Pi Web 内置子代理/.test(body.textContent)) throw new Error("agents 缺少标题文案");
            } else if (trs === 0 && dts === 0) {
              throw new Error(tab + " 右详情为空 :: " + rtxt);
            }
            // 模型页额外验：左栏齿轮行 + 模型行 + 「+ 模型」+ 底部「+ 添加 Provider」，
            // 右栏 ID/Name 输入框与「保存」；再点开选择器确认三组都在。
            if (tab === "models") {
              var gears = body.querySelectorAll(".split-list .md-pv .md-gear").length;
              var mds = body.querySelectorAll(".split-list .md-md:not(.md-add)").length;
              if (gears === 0) throw new Error("models 左栏没有 Provider 行");
              if (mds === 0) throw new Error("models 左栏没有模型行");
              if (!/\+ 模型/.test(body.textContent)) throw new Error("models 缺少「+ 模型」");
              if (!/\+ 添加 Provider/.test(body.textContent)) throw new Error("models 缺少「+ 添加 Provider」");
              if (body.querySelectorAll(".split-right .md-in").length < 2) {
                throw new Error("models 右栏输入框过少");
              }
              // 保存按钮在 #modal-foot，跟 #modal-body 是兄弟节点，不在 body 里，
              // 所以要单独取 footer 验（之前误在 body 里找，报了假失败）。
              var mfoot = $("modal-foot");
              var saveBtn = mfoot && mfoot.querySelector(".md-save");
              if (!saveBtn) throw new Error("models 底部没有保存按钮");
              if (saveBtn.textContent.indexOf("保存") < 0) {
                throw new Error("models 底部按钮文案=" + saveBtn.textContent);
              }
              if (mfoot.hidden) throw new Error("models 底部保存栏被隐藏");
              if (!mfoot.querySelector(".foot-stat")) throw new Error("models 底部缺少脏数据提示位");
              // 左栏与右栏必须真的对得上：选中的 Provider 名要出现在右栏 ID 输入框的
              // 所属块里（用 head 里的齿轮/名字核）。
              var rhead = body.querySelector(".split-right .md-head");
              if (!rhead) throw new Error("models 右栏没有标题栏");
            }
          }
          // 常规页要额外验：主题瓦片、开关、滑块三种控件都真的画出来了。
          // 光有行数不够——瓦片/开关渲染挂了照样能凑出 card-row。
          if (tab === "general") {
            var tiles = body.querySelectorAll(".tile").length;
            var sws = body.querySelectorAll(".sw").length;
            var sliders = body.querySelectorAll('input[type=range]').length;
            var radios = body.querySelectorAll(".radio-row").length;
            if (tiles < 6) throw new Error("主题瓦片少 tiles=" + tiles);
            if (sws < 3) throw new Error("开关少 sw=" + sws);
            if (sliders !== 3) throw new Error("滑块数 " + sliders + " != 3");
            if (radios < 1) throw new Error("语言单选为空");
            return fin("tiles=" + tiles + " sw=" + sws + " sliders=" + sliders +
              " radios=" + radios + " cardRows=" + rows + " secs=" + secs);
          }
          return fin("cardRows=" + rows + " secs=" + secs + " split=" + split +
            " li=" + lis + " tr=" + trs + " kv=" + dts);
        }).catch(boom);
      });
    });
    // 字号缩放：两个滑块都必须真的改变渲染尺寸，而不是只写进了配置。
    // 断言的关键是「写死的 px 也跟着变」——这正是之前「聊天字体大小」只改正文、
    // 代码块/工具卡片不动的原因，改用 zoom 后才能统一。
    step("set.uiFont", function () {
      var aside = document.querySelector("aside.sidebar") || document.querySelector("aside");
      if (!aside) throw new Error("找不到侧栏");
      // 先归零到默认值再量基准——上一次跑自检/手拖滑块会把 uiFontSize 留在
      // 非默认值上，直接量基准会拿到被缩放过的数（之前就据此报假失败）。
      var topbar = document.querySelector(".topbar");
      var topbarH0 = topbar.getBoundingClientRect().height;
      return saveSetting({ uiFontSize: SET.defaults.uiFontSize }, false).then(function () {
        var before = aside.getBoundingClientRect().width;
        topbarH0 = topbar.getBoundingClientRect().height;
        return saveSetting({ uiFontSize: 24 }, false).then(function () {
          var zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
          var after = aside.getBoundingClientRect().width;
          var topbarH1 = topbar.getBoundingClientRect().height;
          var exp = 24 / 13;
          if (Math.abs(zoom - exp) > 0.01) throw new Error("body zoom=" + zoom + " != " + exp.toFixed(4));
          if (Math.abs(after / before - exp) > 0.05) {
            throw new Error("侧栏宽未随界面缩放 " + before + " -> " + after + " (zoom=" + zoom + ")");
          }
          // 顶栏必须跟着等比变高（即不折行）。折行会让高度涨得比 zoom 快得多，
          // 「完整历史 / 生成标题」之前就在放大后被折成了两行。
          if (Math.abs(topbarH1 / topbarH0 - exp) > 0.15) {
            throw new Error("顶栏在放大后折行 " + topbarH0.toFixed(0) + " -> " + topbarH1.toFixed(0) +
              " (zoom=" + zoom.toFixed(3) + ")");
          }
          // 固定定位的遮罩在 zoom 下必须仍然铺满视口，否则设置面板会错位
          openModal("general");
          // 必须指名 #modal（设置面板）：选择目录的 #dir-pick 也是 .modal，
          // 用 querySelector(".modal") 会拿到隐藏的它（0x0），误报。
          var mk = document.getElementById("modal");
          var box = mk.getBoundingClientRect();
          if (box.width < innerWidth * 0.9 || box.height < innerHeight * 0.9) {
            throw new Error("遮罩未铺满视口 " + box.width.toFixed(0) + "x" + box.height.toFixed(0) +
              " vs " + innerWidth + "x" + innerHeight);
          }
          closeModal();
          return saveSetting({ uiFontSize: SET.defaults.uiFontSize }, false).then(function () {
            return "zoom=" + zoom.toFixed(3) + " 侧栏 " + before.toFixed(0) + "->" + after.toFixed(0) +
              " 顶栏高 " + topbarH0.toFixed(0) + "->" + topbarH1.toFixed(0) +
              " 遮罩=" + box.width.toFixed(0) + "x" + box.height.toFixed(0);
          });
        });
      });
    });
    // 界面放大后不允许任何区域溢出。这条是「字体调大后 UI 超出窗口」的回归用例：
    // body 上的 zoom 会把写死 px 的元素一起放大，放大后如果容器宽度不够就会溢出——
    // 表现就是顶栏右侧 token 计量被裁掉一半、底部输入区被推出视口。
    step("set.noOverflow", function () {
      function ov(el) { return el ? el.scrollWidth - el.clientWidth : 0; }
      function snap() {
        var de = document.documentElement;
        var topbar = document.querySelector(".topbar");
        var meter = document.getElementById("meter");
        var comp = document.querySelector(".composer");
        var st = document.querySelector(".statusbar");
        return {
          dx: de.scrollWidth - de.clientWidth,
          dy: de.scrollHeight - de.clientHeight,
          topbarOv: ov(topbar),
          meterOv: ov(meter),
          compBottom: comp ? comp.getBoundingClientRect().bottom : 0,
          stBottom: st ? st.getBoundingClientRect().bottom : 0,
          cells: meter ? [].slice.call(meter.children).filter(function (c) { return !c.hidden; }).length : 0,
          filesH: (function () { var f = document.querySelector(".sb-files"); return f ? f.getBoundingClientRect().height : 0; })(),
          sbH: (function () { var s = document.querySelector(".sidebar"); return s ? s.getBoundingClientRect().height : 0; })(),
          compact: document.querySelector(".topbar").classList.contains("compact")
        };
      }
      return saveSetting({ uiFontSize: 11 }, false).then(function () {
        var b = snap();
        return saveSetting({ uiFontSize: 24 }, false).then(function () {
          var a = snap();
          var msgs = [];
          var notes = [];
          if (a.dx > 0) msgs.push("整页横向溢出 " + a.dx + "px（11px 时 " + b.dx + "）");
          if (a.dy > 0) msgs.push("整页纵向溢出 " + a.dy + "px（11px 时 " + b.dy + "）");
          if (a.topbarOv > 0) msgs.push("顶栏内容被裁 " + a.topbarOv + "px");
          if (a.meterOv > 0) msgs.push("token 计量被裁 " + a.meterOv + "px");
          if (a.compBottom > innerHeight + 1) msgs.push("输入区越出底部 " + (a.compBottom - innerHeight).toFixed(0) + "px");
          if (a.stBottom > innerHeight + 1) msgs.push("状态栏越出底部 " + (a.stBottom - innerHeight).toFixed(0) + "px");
          // 设置面板是 fixed + vh/vw 的另一个重灾区：放大后必须仍然整体落在视口内。
          openModal("general");
          var mb = document.querySelector("#modal .modal-box");
          var mbox = mb.getBoundingClientRect();
          if (mbox.width > innerWidth + 1 || mbox.height > innerHeight + 1) {
            msgs.push("设置面板超出视口 " + mbox.width.toFixed(0) + "x" + mbox.height.toFixed(0) +
              " vs " + innerWidth + "x" + innerHeight);
          }
          if (mbox.width < innerWidth * 0.4) msgs.push("设置面板被挤得太窄 " + mbox.width.toFixed(0));
          closeModal();
          // 「字体小了界面一堆空白」：布局必须始终铺满视口，两端都不留白。
          // 这也是「所有界面跟着字号变大变小」的硬指标——11px 与 24px 下
          // 状态栏都必须压到视口底边，而不是 578/683 这种按 zoom 缩水的值。
          if (b.stBottom < innerHeight - 2) msgs.push("11px 底部留白 " + (innerHeight - b.stBottom).toFixed(0) + "px");
          if (a.stBottom < innerHeight - 2) msgs.push("24px 底部留白 " + (innerHeight - a.stBottom).toFixed(0) + "px");
          var sbh = document.querySelector(".sidebar").getBoundingClientRect().height;
          if (sbh < innerHeight - 2) msgs.push("侧栏未铺满高度 " + sbh.toFixed(0) + "/" + innerHeight);
          // 文件树高度上限是「占侧栏百分比」，两端应当占同样的视觉比例；
          // 写 42vh 时这里会是 243/442（vh 不吃 zoom，一头留白一头把会话列表挤掉）。
          // 比绝对 px 严格更靠谱：24px 时侧栏的布局高度变小，头部/底部这些
          // 定高块按比例占得更多，文件树自然略小——只要比例一致就是对的。
          var fh = document.querySelector(".sb-files");
          var fh0 = b.filesH, fh1 = fh ? fh.getBoundingClientRect().height : 0;
          var r0 = b.sbH ? fh0 / b.sbH : 0, r1 = a.sbH ? fh1 / a.sbH : 0;
          if (r0 && Math.abs(r1 - r0) > 0.05) {
            msgs.push("文件树占侧栏比例未跟着字号缩放 " + (r0 * 100).toFixed(1) + "% -> " + (r1 * 100).toFixed(1) + "%");
          }
          if (fh1 < 80) msgs.push("24px 下文件树被挤到 " + fh1.toFixed(0) + "px");
          notes.push("视口 " + innerWidth + "x" + innerHeight);
          notes.push("右面板 " + (RP.open ? "开 " + RP.w : "关"));
          notes.push("--sidebar-width=" + (document.documentElement.style.getPropertyValue("--sidebar-width") || "(unset)") +
            " 实际侧栏 " + Math.round(document.querySelector(".sidebar").getBoundingClientRect().width));
          notes.push("24px 顶栏余量 " + (a.topbarOv <= 0 ? "+" : "-") + Math.abs(a.topbarOv));
          notes.push("设置面板 " + mbox.width.toFixed(0) + "x" + mbox.height.toFixed(0));
          notes.push("计量格 " + b.cells + "->" + a.cells + (a.compact ? "（按钮已压成纯图标）" : ""));
          notes.push("文件树高 " + b.filesH.toFixed(0) + "->" + a.filesH.toFixed(0) +
            "（占侧栏 " + (r0 * 100).toFixed(0) + "%->" + (r1 * 100).toFixed(0) + "%）");
          notes.push("输入区 bottom " + b.compBottom.toFixed(0) + "->" + a.compBottom.toFixed(0));
          notes.push("状态栏 bottom " + b.stBottom.toFixed(0) + "->" + a.stBottom.toFixed(0));
          notes.push("整页溢出 " + b.dx + "/" + b.dy + " -> " + a.dx + "/" + a.dy);
          return saveSetting({ uiFontSize: SET.defaults.uiFontSize }, false).then(function () {
            if (msgs.length) throw new Error(msgs.join("；") + " ｜ " + notes.join(" · "));
            return notes.join(" · ");
          });
        });
      });
    });
    // pi 扩展（pi-cache-optimizer 等）会在切模型时推十几行的警告——
    // 就是用户截图里那块糊满右下角的东西。这里用真实文案复现，
    // 验证：长文折 3 行 / 可展开收起 / 同文同色去重 / 5 条上限 / 可关。
    step("ui.noticeshelf", function () {
      var long = "\uD83D\uDCA1 pi-cache-optimizer: workbuddy/deepseek-v4.1-flash is a third-party "
        + "OpenAI-compatible proxy but merged compat lacks sendSessionAffinityHeaders.\n"
        + "Edit %USERPROFILE%\\.pi\\agent\\models.json -> providers[\"workbuddy\"] -> compat (at the same level "
        + "as baseUrl/api/apiKey/models).\n\nSafe default suggestion: { \"sendSessionAffinityHeaders\": true }\n"
        + "- sendSessionAffinityHeaders: recommended for third-party proxies when supported.\n"
        + "- Keep existing authentication as-is; do not copy credentials, tokens, or API keys.";
      // 先清空上一次用例留下的卡（否则 live 里混着旧卡，"实得 2 张" 会是假阳性）
      noticeQueue.length = 0;
      noticeList().forEach(function (x) { noticeClose(x); });
      toasts(long, "warn");
      toasts(long, "warn");
      var live = noticeLive();
      if (live.length !== 1) throw new Error("同文同色未去重，实得 " + live.length + " 张");
      var n = live[0];
      var tx = n.querySelector(".tx");
      var h0 = n.getBoundingClientRect().height;
      if (!n.classList.contains("clamp")) throw new Error("长通知未默认折行");
      // -webkit-line-clamp 下 clientHeight = 上下 14px 内边距 + 3 行框（14×1.5×3）≈ 91，
      // scrollHeight 才是全文高度，两者一大一小才说明真截断了。
      if (tx.clientHeight > 110) throw new Error("折叠后文本高 " + tx.clientHeight + "px，不止 3 行");
      if (tx.scrollHeight <= tx.clientHeight) throw new Error("scrolHeight/clientHeight 未表现出截断，用例无效");
      var w = n.getBoundingClientRect().width;
      if (w > 621) throw new Error("通知卡超出 620px 上限：" + w.toFixed(0));
      if (h0 > 200) throw new Error("折叠后卡片仍过高 " + h0.toFixed(0) + "px");
      var btns = [].slice.call(n.querySelectorAll(".acts button"));
      var tg = btns.filter(function (b) { return b.textContent === "展开全文"; })[0];
      if (!tg) throw new Error("缺少「展开全文」按钮");
      if (!btns.some(function (b) { return b.textContent === "关闭"; })) throw new Error("缺少「关闭」按钮");
      tg.click();
      if (n.classList.contains("clamp")) throw new Error("点展开后仍折叠");
      var h1 = n.getBoundingClientRect().height;
      if (h1 <= h0) throw new Error("展开后卡片没变高 " + h0.toFixed(0) + " -> " + h1.toFixed(0));
      if (h1 > 501) throw new Error("展开后超出 500px 高度上限：" + h1.toFixed(0));
      tg.click();
      if (!n.classList.contains("clamp")) throw new Error("点收起后未折叠");
      // 溢出：上限 5 条，多的排队；同一时刻屏上不得超过 5 张
      for (var i = 0; i < 7; i++) toasts("溢出测试 " + i);
      var live2 = noticeLive();
      if (live2.length > MAX_NOTICES) throw new Error("屏上通知 " + live2.length + " 超过上限 " + MAX_NOTICES);
      noticeQueue.length = 0;
      noticeList().forEach(function (x) { noticeClose(x); });
      noticeQueue.length = 0;
      if (noticeList().length) throw new Error("全部关闭后仍有 " + noticeList().length + " 张残留");
      return "长文折 " + h0.toFixed(0) + "px -> 展开 " + h1.toFixed(0) + "px（上限 500）· 去重 ok · 屏上 " +
        live2.length + "/" + MAX_NOTICES + " · 关闭 ok";
    });
    step("set.chatFont", function () {
      var inner = document.querySelector(".stream-inner");
      if (!inner) throw new Error("找不到 .stream-inner");
      // 探针故意写死 12px——样式表里代码块/工具卡片就是这种写死 px，
      // 只改 font-size 的旧方案动不了它们，zoom 才能带动。
      var probe = document.createElement("div");
      probe.style.cssText = "font:12px/1 Consolas,monospace;white-space:nowrap";
      probe.textContent = "MMMMMMMMMMMMMMMMMMMM";
      inner.appendChild(probe);
      var h0 = probe.getBoundingClientRect().height;
      var ta = document.querySelector(".composer textarea");
      var f0 = ta ? parseFloat(getComputedStyle(ta).fontSize) : 0;
      // 同 set.uiFont：先归零到默认字号再量基准，否则上次跑剩下的值会把基准带偏。
      return saveSetting({ chatFontSize: SET.defaults.chatFontSize }, false).then(function () {
        h0 = probe.getBoundingClientRect().height;
        f0 = ta ? parseFloat(getComputedStyle(ta).fontSize) : 0;
        return saveSetting({ chatFontSize: 22 }, false);
      }).then(function () {
        var h1 = probe.getBoundingClientRect().height;
        var f1 = ta ? parseFloat(getComputedStyle(ta).fontSize) : 0;
        var ratio = h1 / h0;
        var exp = 22 / SET.defaults.chatFontSize;
        if (Math.abs(ratio - exp) > 0.05) {
          throw new Error("写死 px 未随聊天字号缩放 " + h0.toFixed(1) + "->" + h1.toFixed(1) +
            " ratio=" + ratio.toFixed(3) + " 期望 " + exp.toFixed(3));
        }
        if (Math.abs(f1 - 22) > 0.6) throw new Error("输入框字号=" + f1 + " 未跟随");
        probe.remove();
        return saveSetting({ chatFontSize: SET.defaults.chatFontSize }, false).then(function () {
          probe.remove();
          return "探针 " + h0.toFixed(1) + "->" + h1.toFixed(1) + " (" + ratio.toFixed(2) + "x)" +
            " 输入框 " + f0 + "->" + f1;
        });
      });
    });
    // 主题切换要真的换掉 CSS 变量（写配置 -> applySettings -> html[data-theme]）
    step("set.theme", function () {
      return Promise.all([
        saveSetting({ theme: "dark" }, false),
        saveSetting({ theme: "dark" }, false)   // 并发两次也不该错乱
      ]).then(function () {
        var got = document.documentElement.getAttribute("data-theme");
        var bg = getComputedStyle(document.body).backgroundColor;
        if (got !== "dark") throw new Error("data-theme=" + got);
        return saveSetting({ theme: SET.defaults.theme }, false).then(function () {
          return "dark bg=" + bg + " -> 恢复 " + document.documentElement.getAttribute("data-theme");
        });
      });
    });

    /* ================= 主题 / 字体可读性 =================
       用户报的 BUG：「发送按钮在别的主题色下是白底白字，看不见」。
       根因是一堆控件把颜色写死成 #fff / #eef1f4，与主题无关。
       下面这组用 WCAG 对比度把「看不清」变成可判定的红/绿：
       以后谁再把颜色写死，对应主题一定会掉到 4.5 以下。 */
    // 探针：不依赖当前界面状态，临时造出带目标 class 的元素来量颜色。
    // 用 class 选择器是故意的——CSS 规则按 class 命中，不需要真的在插件页/对话框里。
    var CONTRAST_PROBES = [
      ["普通按钮", '<button class="btn">按钮</button>', ".btn"],
      ["发送按钮", '<button class="btn btn-send">发送</button>', ".btn-send"],
      ["对话框主按钮", '<button class="md-btn md-btn-primary">确定</button>', ".md-btn-primary"],
      ["对话框保存", '<button class="md-save">保存</button>', ".md-save"],
      ["分段控件选中", '<button class="md-segb on">选中</button>', ".md-segb.on"],
      ["插件主按钮", '<div class="plg-actions"><button class="btn btn-primary">安装</button></div>', ".plg-actions .btn-primary"],
      ["插件更新按钮", '<div class="split-foot"><button class="btn btn-upd">全部更新</button></div>', ".split-foot .btn-upd"],
      ["回到底部计数", '<div class="jump-bottom"><button class="jb-count">3</button></div>', ".jump-bottom .jb-count"],
      ["选中芯片", '<span class="chip on">思考</span>', ".chip.on"],
      ["状态徽标", '<span class="badge on">已启用</span>', ".badge.on"]
    ];
    // 注意：color-mix() 的结果在 Chromium 里序列化成 `color(srgb r g b / a)`（分量是 0..1），
    // 不是 rgb()/rgba()。只认 rgb 的话 --ok-soft / --warn-soft 这类半透明底会被静默丢掉，
    // 对比度会退化成「白底」算出一个假通过的高分。两种写法都要认。
    function rgbaOf(s) {
      s = String(s);
      if (s === "transparent") return [0, 0, 0, 0];
      var m = s.match(/^rgba?\(([^)]+)\)/);
      if (m) {
        var p = m[1].split(/[,\s\/]+/).filter(function (x) { return x !== ""; });
        if (p.length < 3) return null;
        return [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]), p.length > 3 ? parseFloat(p[3]) : 1];
      }
      m = s.match(/^color\(srgb\s+([^)]+)\)/);
      if (m) {
        var q = m[1].split(/[\s\/]+/).filter(function (x) { return x !== ""; });
        if (q.length < 3) return null;
        return [parseFloat(q[0]) * 255, parseFloat(q[1]) * 255, parseFloat(q[2]) * 255, q.length > 3 ? parseFloat(q[3]) : 1];
      }
      return null;
    }
    // top over bottom（按 alpha 合成）
    function over(top, bottom) {
      var a = top[3] + bottom[3] * (1 - top[3]);
      if (a <= 0) return [0, 0, 0, 0];
      var mix = function (i) { return (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a; };
      return [mix(0), mix(1), mix(2), a];
    }
    // 元素实际呈现的底色：从 html 一路叠到元素自己。
    // 必须真叠：--accent-soft / --ok-soft / --warn-soft 都是 color-mix 出来的半透明色，
    // 直接拿 backgroundColor 当底色算对比度会得出完全错误的结论。
    function backdropOf(elm) {
      var chain = [];
      for (var n = elm; n && n.nodeType === 1; n = n.parentElement) {
        var c = rgbaOf(getComputedStyle(n).backgroundColor);
        if (c && c[3] > 0) chain.push(c);
      }
      var acc = [255, 255, 255, 1];   // 兜底：窗口默认白底
      for (var i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
      return acc;
    }
    function relLum(c) {
      var f = function (v) {
        v = v / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    }
    function ratioOf(a, b) {
      var x = relLum(a), y = relLum(b);
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    }
    // 苹果主题：必须真在设置页里可选（后端 THEMES 漏加的话前端根本渲染不出来）
    step("ui.theme.apple", function () {
      return send("settings.get").then(function (s) {
        var ids = (s.themes || []).map(function (t) { return t[0]; });
        if (ids.indexOf("apple") < 0) throw new Error("后端主题列表里没有 apple：" + ids.join(","));
        var before = document.documentElement.getAttribute("data-theme");
        document.documentElement.setAttribute("data-theme", "apple");
        var cs = getComputedStyle(document.documentElement);
        var accent = cs.getPropertyValue("--accent").trim();
        var bgv = cs.getPropertyValue("--bg").trim();
        var radius = cs.getPropertyValue("--radius").trim();
        var bodyBg = getComputedStyle(document.body).backgroundColor;
        if (before) document.documentElement.setAttribute("data-theme", before);
        else document.documentElement.removeAttribute("data-theme");
        if (accent !== "#0071e3") throw new Error("--accent=" + accent);
        if (bgv !== "#ffffff") throw new Error("--bg=" + bgv);
        if (radius !== "10px") throw new Error("--radius=" + radius);
        if (bodyBg !== "rgb(255, 255, 255)") throw new Error("body 背景未跟随：" + bodyBg);
        return "apple accent=" + accent + " bg=" + bgv + " radius=" + radius + " body=" + bodyBg;
      });
    });
    // 造一个真实聊天结构里的元素：.msg.assistant .body pre / code 这些规则
    // 只在这个上下文里生效，挂在 body 上量不出真东西。量完由调用方删掉。
    function fontScopeProbe(tag) {
      var host = document.createElement("div");
      host.className = "msg assistant";
      host.setAttribute("data-font-probe", "1");
      host.innerHTML = '<div class="body"></div>';
      var node = document.createElement(tag);
      node.textContent = "x";
      host.firstChild.appendChild(node);
      (streamInner || document.body).appendChild(host);
      node.__piHost = host;
      return node;
    }
    // 轮询等待：settings.set 回包后才 applySettings，改完字体要等一拍。
    // 不能用文件里另一个 stage 的同名 waitFor（不在本函数作用域内）。
    function fontWaitFor(fn, ms) {
      var t0 = Date.now();
      return new Promise(function (res, rej) {
        (function tick() {
          var v = null;
          try { v = fn(); } catch (e) { v = null; }
          if (v) return res(v);
          if (Date.now() - t0 > ms) return rej(new Error("等超时 " + ms + "ms"));
          setTimeout(tick, 40);
        })();
      });
    }
    // 全界面审计：可见元素里，除了等宽区，任何元素的 font-family 都得带上当前
    // 界面字体。一条断言覆盖「界面 + 聊天正文 + 表单控件」，不用枚举几十个选择器
    // （枚举法漏一个就等于没测）。
    function fontScopeAudit(name) {
      var all = document.querySelectorAll("*");
      var bad = [], mono = 0, total = 0;
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        // <html> 不带 font-family（字体写在 body 上），预览框和探针自己指定字体，
        // 都不算「没跟随」——它们本来就不该跟随。
        if (e === document.documentElement) continue;
        if (!e.getClientRects().length) continue;
        if (e.closest && (e.closest("[data-font-probe], .font-probe, .font-prev"))) continue;
        var f = getComputedStyle(e).fontFamily || "";
        total++;
        if (f.indexOf(name) >= 0) continue;
        if (/monospace|JetBrains Mono|Fira Code|Consolas/.test(f)) { mono++; continue; }
        bad.push(e.className && typeof e.className === "string" ? e.className : e.tagName);
      }
      return { total: total, mono: mono, bad: bad };
    }
    // 系统字体候选：fonts.list 要走通 DirectWrite，族名不重复、不混哨兵值，
    // 且「浏览器实测能不能解析」这个探针本身要认得岀不存在的族名——否则整张表
    // 都是安慰剂（写进 CSS 却静默回落，界面上完全看不出来）。
    step("ui.font.list", function () {
      return send("fonts.list").then(function (r) {
        var fams = (r && r.families) || [];
        if (fams.length < 50) throw new Error("系统字体族太少：" + fams.length);
        if (fams.indexOf(P.FONT_SYSTEM) >= 0) throw new Error("族名里混进了哨兵值 " + P.FONT_SYSTEM);
        if (P.fontResolves(P.FONT_PROBE_MISSING)) throw new Error("探针把不存在的族名判成可用");
        var seen = {}, dup = null;
        fams.forEach(function (n) { if (seen[n]) dup = n; seen[n] = 1; });
        if (dup) throw new Error("族名重复：" + dup);
        return P.loadFonts().then(function (all) {
          var ok = all.filter(function (f) { return f.ok; }).length;
          if (ok === 0) throw new Error("实测没有一个族名能解析");
          var hit = fams.filter(function (n) { return /苹方|PingFang|HarmonyOS|MiSans|OPPO Sans/.test(n); });
          return "系统 " + fams.length + " 族 / 实测可用 " + ok + " / 探针 " + P.FONT_PROBE_MISSING + "=false / 已装族命中 " + hit.length + ": " + hit.join(",");
        });
      });
    });
    // 字体：界面与代码合并成一个下拉框（用户要求）。断言走真实控件——
    // 改 select.value + 派发 change，看 body 的 font-family 与 --font-mono 是否都跟着变，
    // 再看聊天代码块是不是真用上了它。只比 CSS 字符串会把「写进去但静默回落」判成通过。
    step("ui.font.pick", function () {
      return send("settings.get").then(function (s) {
        return P.loadFonts().then(function (all) {
          var usable = all.filter(function (f) { return f.ok; });
          if (usable.length < 2) throw new Error("可用字体太少：" + usable.length + "/" + all.length);
          openModal("general");
          return fontWaitFor(function () { return document.querySelector("select.font-sel"); }, 4000).then(function () {
            var sel = document.querySelector("select.font-sel");
            if (!sel) throw new Error("设置页没有字体下拉框 select.font-sel");
            return fontWaitFor(function () { return sel.options.length >= all.length + 1; }, 4000).then(function () {
              if (sel.options.length !== all.length + 1) throw new Error("下拉框选项 " + sel.options.length + " != 字体表 " + (all.length + 1));
              var pick = [usable[0].name, usable[usable.length - 1].name];
              var out = ["选项 " + sel.options.length];
              var run = function (i) {
                if (i >= pick.length) return Promise.resolve();
                var name = pick[i], found = false;
                for (var k = 0; k < sel.options.length; k++) if (sel.options[k].value === name) found = true;
                if (!found) throw new Error("下拉框里没有 " + name);
                sel.value = name;
                sel.dispatchEvent(new Event("change"));
                return fontWaitFor(function () { return getComputedStyle(document.body).fontFamily.indexOf(name) >= 0; }, 4000).then(function () {
                  if (!P.fontResolves(name)) throw new Error(name + " 实测解析不出字形");
                  var m = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
                  if (m.indexOf(name) < 0) throw new Error("代码字体没跟着换 --font-mono=" + m);
                  var pre = fontScopeProbe("pre");
                  var pf = getComputedStyle(pre).fontFamily;
                  pre.__piHost.remove();
                  if (pf.indexOf(name) < 0) throw new Error("聊天代码块没用上该字体 pre=" + pf);
                  out.push("界面+代码=" + name + "(check=" + document.fonts.check('15px "' + name + '"') + ")");
                  return run(i + 1);
                });
              };
              return run(0).then(function () {
                return saveSetting({ fontFamily: s.defaults.fontFamily, fontMono: s.defaults.fontMono }, false).then(function () {
                  return out.join(" / ") + " -> 恢复 " + getComputedStyle(document.body).fontFamily;
                });
              });
            });
          });
        });
      });
    });
    // 覆盖范围：字体改完后，全界面（含按钮、表单控件、聊天正文）都得跟着变，
    // 只允许等宽区（代码块 / 工具输出）继续用自己的字体。设置面板也一并开着测。
    step("ui.font.scope", function () {
      return P.loadFonts().then(function (all) {
        var usable = all.filter(function (f) { return f.ok; });
        if (!usable.length) throw new Error("没有可用字体");
        var name = usable[Math.min(3, usable.length - 1)].name;
        openModal("general");
        return saveSetting({ fontFamily: name }, false).then(function () {
          var audit = fontScopeAudit(name);
          if (audit.total < 20) throw new Error("可见元素太少，测不出覆盖范围：" + audit.total);
          if (audit.bad.length) throw new Error(audit.bad.length + " 个元素没跟随界面字体：" + audit.bad.slice(0, 5).join(" | "));
          return send("settings.get").then(function (s) {
            return saveSetting({ fontFamily: s.defaults.fontFamily }, false).then(function () {
              closeModal();
              return "族名 " + name + " 覆盖 " + audit.total + " 个可见元素（等宽区 " + audit.mono + " 个），未跟随 0 个";
            });
          });
        });
      });
    });
    // 每个主题 × 每个控件都要达到 WCAG AA（普通文字 4.5:1，大字/粗体 3:1）
    step("ui.theme.contrast", function () {
      // 探针自己也要被检：color-mix() 的计算值在 Chromium 里是 `color(srgb … / a)`。
      // 只认 rgb() 的话半透明底色（--ok-soft / --warn-soft …）会被静默丢掉，
      // 对比度退化成「白底」算出一个假通过的高分。先把解析器本身验一道。
      var pb = el("div");
      pb.style.cssText = "position:absolute;left:-9999px;background:color-mix(in srgb, rgb(26,127,55) 14%, transparent)";
      document.body.appendChild(pb);
      var cmRaw = getComputedStyle(pb).backgroundColor;
      var cmParsed = rgbaOf(cmRaw);
      pb.remove();
      if (!cmParsed) throw new Error("解析不了 color-mix 底色：" + cmRaw);
      if (!(cmParsed[3] > 0 && cmParsed[3] < 1)) throw new Error("color-mix 底色 alpha 不对：" + cmRaw);
      if (!rgbaOf("color(srgb 0.1 0.5 0.2 / 0.5)")) throw new Error("解析不了 color(srgb …) 写法");
      if (!rgbaOf("rgba(1, 2, 3, 0.5)")) throw new Error("解析不了 rgba() 写法");
      if (!rgbaOf("rgb(1, 2, 3)")) throw new Error("解析不了 rgb() 写法");
      var box = el("div");
      box.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden";
      document.body.appendChild(box);
      var before = document.documentElement.getAttribute("data-theme");
      var bad = [], checked = 0, worst = { r: 99, t: "", s: "" }, themes = [];
      try {
        themes = (SET.themes || []).map(function (t) { return t[0]; });
        if (themes.length < 6) throw new Error("主题列表过少 " + themes.join(","));
        themes.forEach(function (id) {
          document.documentElement.setAttribute("data-theme", id);
          CONTRAST_PROBES.forEach(function (p) {
            box.innerHTML = p[1];
            var node = box.querySelector(p[2]);
            if (!node) throw new Error("探针元素没造出来：" + p[0]);
            var cs = getComputedStyle(node);
            var fg = rgbaOf(cs.color);
            var bg = backdropOf(node);
            if (!fg) throw new Error("取不到前景色：" + p[0] + " " + cs.color);
            if (bg[3] < 1) bg = over(bg, [255, 255, 255, 1]);
            if (fg[3] < 1) fg = over(fg, bg);   // 文字自己带透明度时先合成到底色上
            var r = ratioOf(fg, bg);
            checked++;
            var fs = parseFloat(cs.fontSize);
            var fw = cs.fontWeight === "bold" ? 700 : (parseInt(cs.fontWeight, 10) || 400);
            var need = (fs >= 18.66 || (fw >= 600 && fs >= 14.66)) ? 3.0 : 4.5;
            if (r < worst.r) worst = { r: r, t: id, s: p[0] };
            if (r + 1e-9 < need) bad.push(id + " " + p[0] + " " + r.toFixed(2) + ":1 < " + need);
          });
        });
      } finally {
        if (before) document.documentElement.setAttribute("data-theme", before);
        else document.documentElement.removeAttribute("data-theme");
        box.remove();
      }
      if (bad.length) throw new Error(bad.join(" | "));
      return themes.length + " 主题 × " + (checked / themes.length) + " 控件，最低 " +
        worst.r.toFixed(2) + ":1（" + worst.t + " " + worst.s + "）；color-mix 序列化=" + cmRaw;
    });
    // 两个滑块要真的改变聊天区宽度与字号。
    // 字号现在走 zoom，max-width 会预先除以 zoom，所以断言看的是
    // 「maxWidth × zoom」反算出来的实际渲染宽度，而不是 maxWidth 字面值。
    step("set.slider", function () {
      return saveSetting({ chatWidth: 1120, chatFontSize: 18 }, false).then(function () {
        var inner = document.querySelector(".stream-inner");
        var w = getComputedStyle(inner).maxWidth;
        var z = parseFloat(getComputedStyle(inner).zoom) || 1;
        var eff = parseFloat(w) * z;
        var f = getComputedStyle(document.querySelector(".composer textarea")).fontSize;
        if (Math.abs(eff - 1120) > 2) {
          throw new Error("聊天宽度未生效 反算=" + eff.toFixed(1) + " w=" + w + " zoom=" + z);
        }
        if (f !== "18px") throw new Error("输入框字号未跟随 f=" + f);
        return saveSetting({
          chatWidth: SET.defaults.chatWidth, chatFontSize: SET.defaults.chatFontSize
        }, false).then(function () {
          var n = getComputedStyle(document.querySelector(".stream-inner")).maxWidth;
          return "宽 1120(zoom=" + z.toFixed(3) + ") 字号 " + f + " -> 恢复 maxW=" + n;
        });
      });
    });
    // 绿色版回写：配置文件必须真的落在 exe 同级目录，而不是临时目录
    step("set.persist", function () {
      return Promise.all([send("settings.get"), send("app.bootstrap")]).then(function (a) {
        var s = a[0] || {};
        var b = a[1] || {};
        var p = s.configPath || "";
        if (!/pi-webview\.config\.json$/.test(p)) throw new Error("配置路径异常 " + p);
        // 判据必须用 bootstrap 报的 exe 目录，不能写死 release 路径：
        // 绿色目录叫任意名字都应该通过。
        var dir = (b.exeDir || "").replace(/[\\/]+$/, "");
        if (!dir) throw new Error("bootstrap 未报 exeDir");
        if (p.replace(/[\\/]+$/, "").indexOf(dir + "\\") !== 0)
          throw new Error("配置未落在 exe 同级目录：" + p + " vs " + dir);
        return dir + " -> " + p;
      });
    });
    // 技能页左列表数量必须与 skills.list 一致（不是固定值，别把用户装的技能数写死）
    step("probe.skills", function () {
      return send("skills.list", {}).then(function (r) {
        var a = (r && r.skills) || [];
        // 阈值只保证「装了的技能都扫到了」：数量取决于本机装了哪些包。
        // 以前写死 10，那是开发机的技能数；本机只有 npm 包里自带的几个，必然假失败。
        if (a.length < 5) throw new Error("技能过少 " + a.length);
        var noPath = a.filter(function (x) { return !/SKILL\.md$/.test(x.path || ""); }).length;
        if (noPath) throw new Error(noPath + " 个技能缺 SKILL.md 路径");
        // scoped 包（node_modules\@scope\pkg\skills）以前整包漏扫，这里点名守住。
        var scoped = a.filter(function (x) { return /node_modules\\@/.test(x.path || ""); }).length;
        return a.length + " 个（scoped " + scoped + "） :: " + a.slice(0, 3).map(function (x) { return x.name; }).join(",");
      });
    });
    // skill: 前缀去掉后必须能在 skills.list 里命中（否则右栏路径还是空的）
    step("probe.skillidx", function () {
      return send("skills.list", {}).then(function (lr) {
        var idx = {};
        ((lr && lr.skills) || []).forEach(function (s) { idx[s.name] = s; });
        return send("pi.call", { type: "get_commands" }).then(function (r) {
          var cs = ((r && r.data && r.data.commands) || [])
            .filter(function (c) { return c.source === "skill"; });
          var miss = cs.filter(function (c) {
            return !idx[String(c.name || "").replace(/^skill:/, "")];
          }).map(function (c) { return c.name; });
          if (miss.length) throw new Error(miss.length + " 个技能回扫不到 :: " + miss.slice(0, 6).join(","));
          return cs.length + " 个技能全部命中 SKILL.md";
        });
      });
    });
    // 模型页后端：内建 Provider 目录必须真的读得到（要起 node 跑 pi 的 ModelRuntime），
    // 并且 models.json 要能读-改-写回环。改完必须原样还回去，不能留脏。
    step("probe.models", function () {
      return send("models.catalog", {}).then(function (c) {
        var ps = (c && c.providers) || [];
        if (ps.length < 20) throw new Error("内建 Provider 过少 " + ps.length);
        var sub = ps.filter(function (p) { return p.oauth; });
        if (sub.length < 3) throw new Error("OAuth 订阅 Provider 过少 " + sub.length);
        var noid = ps.filter(function (p) { return !p.id; }).length;
        if (noid) throw new Error(noid + " 个 Provider 缺 id");
        var nooo = sub.filter(function (p) { return !p.oauthName; }).length;
        if (nooo) throw new Error(nooo + " 个订阅 Provider 缺 oauthName");
        var noCnt = ps.filter(function (p) { return typeof p.modelCount !== "number"; }).length;
        if (noCnt) throw new Error(noCnt + " 个 Provider 缺 modelCount");

        // sanitize() 的契约：pi 的 applyModelsJson 会拒绝空壳条目，
        // 所以写盘前必须去空串、去空 models、丢掉整条空 Provider。
        var dirtyCfg = { providers: {
          "empty-shell": {},
          "name-only": { name: "x" },
          "blank-strings": { baseUrl: "", apiKey: "", api: "", models: [] },
          "keep-me": { baseUrl: "https://example.invalid/v1", models: [
            { id: "", name: "" }, { id: "ok", model: "" }] }
        } };
        var s = sanitizeModelsConfig(JSON.parse(JSON.stringify(dirtyCfg)));
        if (s.dropped.length !== 3) throw new Error("sanitize 应丢 3 条，实丢 " + s.dropped.length);
        if (s.config.providers["keep-me"].models.length !== 1) {
          throw new Error("sanitize 未剔除空 ID 模型");
        }
        if ("model" in s.config.providers["keep-me"].models[0]) {
          throw new Error("sanitize 未剔除模型里的空串字段");
        }

        return send("models.read", {}).then(function (r) {
          var orig = JSON.parse(JSON.stringify(r.config || { providers: {} }));
          var tmp = JSON.parse(JSON.stringify(orig));
          tmp.providers = tmp.providers || {};
          tmp.providers["selftest-prov"] = {
            api: "openai-completions", baseUrl: "https://example.invalid/v1",
            apiKey: "SELFTEST_KEY",
            models: [{ id: "selftest-model", name: "Selftest", contextWindow: 128000, maxTokens: 16384,
              reasoning: true, input: ["text", "image"],
              thinkingLevelMap: { high: null, low: "low" } }]
          };
          var put = function (cfg) { return send("models.write", { config: cfg }); };
          return put(tmp).then(function () {
            return send("models.read", {});
          }).then(function (r2) {
            var p = ((r2.config || {}).providers || {})["selftest-prov"];
            if (!p) throw new Error("写回后回读不到 selftest-prov");
            if (p.apiKey !== "SELFTEST_KEY") throw new Error("apiKey 未持久化");
            var m = (p.models || [])[0] || {};
            if (m.id !== "selftest-model") throw new Error("模型未持久化");
            if (m.reasoning !== true) throw new Error("reasoning 未持久化");
            if (!m.thinkingLevelMap || m.thinkingLevelMap.high !== null) {
              throw new Error("thinkingLevelMap 的 null 未保留");
            }
            return put(orig);
          }).then(function () {
            return send("models.read", {});
          }).then(function (r3) {
            if (((r3.config || {}).providers || {})["selftest-prov"]) {
              throw new Error("还原失败，selftest-prov 仍在");
            }
            return ps.length + " 个 Provider（订阅 " + sub.length + "）| 读改写回环 + 还原 ok";
          });
        });
      });
    });
    // 模型页 UI：「+ 添加 Provider」弹出的选择器要有 自定义 / 订阅服务 / API KEY 三组，
    // 且卡片是从内建目录真拉出来的（不是写死的）。目录要起 node，给 30s 等。
    step("ui.modelspick", function () {
      openModal("models");
      var body = $("modal-body");
      var t0 = Date.now();
      function waitCatalog() {
        return new Promise(function (r) { setTimeout(r, 800); }).then(function () {
          if (body.querySelectorAll(".split-list .md-pv").length === 0 && Date.now() - t0 < 20000) {
            return waitCatalog();
          }
        });
      }
      return waitCatalog().then(function () {
        var add = body.querySelector(".split-foot .split-add");
        if (!add) throw new Error("找不到「+ 添加 Provider」按钮");
        add.click();
        var t1 = Date.now();
        function waitPick() {
          return new Promise(function (r) { setTimeout(r, 700); }).then(function () {
            var n = body.querySelectorAll(".md-pickcard").length;
            if (n < 8 && Date.now() - t1 < 30000) return waitPick();
          });
        }
        return waitPick().then(function () {
          var grps = [].map.call(body.querySelectorAll(".md-pickgrp"), function (x) { return x.textContent; });
          var cards = body.querySelectorAll(".md-pickcard").length;
          if (grps.indexOf("自定义") < 0) throw new Error("选择器缺「自定义」组");
          if (grps.indexOf("API 密钥") < 0) throw new Error("选择器缺「API 密钥」组 :: " + grps.join("/"));
          if (cards < 8) throw new Error("选择器卡片过少 " + cards);
          // 再回到模型详情，确认左栏点模型能出 ID/Name/能力/规格
          var md = body.querySelector(".split-list .md-md:not(.md-add)");
          if (md) {
            md.click();
            return new Promise(function (r) { setTimeout(r, 200); }).then(function () {
              var t = body.querySelector(".split-right").textContent;
              if (!/能力/.test(t) || !/模型规格/.test(t)) throw new Error("模型详情缺「能力 / 模型规格」");
              return grps.join("/") + " | 卡片=" + cards + " | 模型详情 ok";
            });
          }
          return grps.join("/") + " | 卡片=" + cards + "（本机无自定义模型，跳过详情）";
        });
      });
    });
    // 「导入模型…」链路。以前没填 Base URL 时按钮直接 disabled，点了毫无反应。
    // 现在两条路都要通：内建 Provider 读 pi 本地模型表；非内建缺 Base URL 要给可读错误。
    // 注意：本步会临时替掉整份 providers 再还原（与 ui.models 同套路）。
    step("ui.modelsimport", function () {
      var orig = null, builtinId = null;
      var altName = "zzz-not-a-builtin-provider";
      var put = function (c) { return send("models.write", { config: c }); };
      var waitSel = function (sel, ms) {
        var t0 = Date.now();
        return new Promise(function (res, rej) {
          (function loop() {
            var n = document.querySelector(sel);
            if (n) return res(n);
            if (Date.now() - t0 > ms) return rej(new Error("等不到 " + sel));
            setTimeout(loop, 300);
          })();
        });
      };
      // closeModal 只把 #modal 藏起来，里面的 DOM 还是上一次的；openModal 又要先等
      // models.read 回来才重画。所以不能只等「有 .md-pv」——会拿到上一轮的残留面板。
      // 必须等左栏出现目标 Provider 名字，且右栏真的画出了 provider 详情。
      var openWith = function (name) {
        closeModal();
        openModal("models");
        var t0 = Date.now();
        return new Promise(function (res, rej) {
          (function loop() {
            var rows = document.querySelectorAll("#modal-body .split-list .md-pv");
            var hit = false;
            for (var i = 0; i < rows.length; i++) {
              if ((rows[i].textContent || "").indexOf(name) >= 0) { hit = true; break; }
            }
            var btn = document.querySelector("#modal-body .split-right .md-disc button");
            if (hit && btn) return res(btn);
            if (Date.now() - t0 > 25000) {
              return rej(new Error("等不到「" + name + "」的 Provider 详情（左行命中=" + hit +
                "，右栏按钮=" + !!btn + "）"));
            }
            setTimeout(loop, 300);
          })();
        });
      };
      var rightBtn = function () {
        var rr = document.querySelector("#modal-body .split-right");
        var b = document.querySelector("#modal-body .split-right .md-disc button");
        if (!b) {
          var diag = "md-disc=" + document.querySelectorAll("#modal-body .md-disc").length +
            " right=" + (rr ? rr.className : "null") +
            " text=" + (rr ? rr.textContent.slice(0, 160) : "");
          throw new Error("右栏没有「导入模型…」按钮 :: " + diag);
        }
        if (b.disabled) throw new Error("「导入模型…」按钮是 disabled");
        return b;
      };
      var restore = function () { return put(orig || { providers: {} }); };

      return send("models.read", {}).then(function (r) {
        orig = JSON.parse(JSON.stringify(r.config || { providers: {} }));
        return send("models.catalog", {});
      }).then(function (c) {
        var ids = ((c && c.providers) || []).map(function (x) { return x.id; });
        if (!ids.length) throw new Error("pi 内建目录为空");
        builtinId = ids.indexOf("openai") >= 0 ? "openai" : ids[0];
        var cfg1 = { providers: {} };
        cfg1.providers[altName] = { models: [] };
        return put(cfg1);
      }).then(function () { return openWith(altName); }).then(function () {
        // ① 非内建 + 没 Base URL：可点，且点了要给含「Base URL」的可读错误
        rightBtn().click();
        var t1 = Date.now();
        return new Promise(function (res, rej) {
          (function loop() {
            var err = document.querySelector("#modal-body .md-disc .md-err");
            if (err) {
              var t = err.textContent || "";
              if (t.indexOf("接口地址") < 0) return rej(new Error("错误提示没提接口地址: " + t));
              return res(t.trim());
            }
            if (document.querySelector("#modal-body .md-disc .md-disclist")) {
              return rej(new Error("非内建 Provider 却列出了模型，不该走本地表"));
            }
            if (Date.now() - t1 > 45000) {
              var d = document.querySelector("#modal-body .md-disc");
              return rej(new Error("点击 45s 后既无错误也无列表 :: disc=" +
                (d ? JSON.stringify((d.textContent || "").slice(0, 200)) : "null")));
            }
            setTimeout(loop, 300);
          })();
        });
      }).then(function () {
        var cfg2 = { providers: {} };
        cfg2.providers[builtinId] = { models: [] };
        return put(cfg2);
      }).then(function () { return openWith(builtinId); }).then(function () {
        // ② 内建 Provider + 没 Base URL：走 pi 本地模型表
        rightBtn().click();
        return waitSel("#modal-body .md-disc .md-disclist", 90000);
      }).then(function (list) {
        var rows = list.querySelectorAll(".md-discrow");
        if (rows.length < 1) throw new Error("内建模型表一行都没列出来");
        var info = document.querySelector("#modal-body .md-discinfo");
        var infoTxt = info ? info.textContent : "";
        if (infoTxt.indexOf("内置") < 0) throw new Error("数据来源不是内建目录: " + infoTxt);
        var q = function () {
          return document.querySelectorAll("#modal-body .split-list .md-md:not(.md-add)").length;
        };
        var before = q();
        rows[0].querySelector("input").click(); // 会触发 renderRight，后面的节点必须重新查
        var addBtn = document.querySelector("#modal-body .md-discfoot .md-btn-primary");
        if (!addBtn || addBtn.disabled) throw new Error("「添加所选」不可点");
        addBtn.click();
        var t0 = Date.now();
        return new Promise(function (res, rej) {
          (function loop() {
            if (!document.querySelector("#modal-body .md-disc .md-disclist")) return res();
            if (Date.now() - t0 > 60000) return rej(new Error("添加所选后导入面板没关闭"));
            setTimeout(loop, 300);
          })();
        }).then(function () {
          var after = q();
          if (after !== before + 1) {
            throw new Error("添加后左栏模型数 " + before + " -> " + after + "，应为 +1");
          }
          return builtinId + " | 表行数=" + rows.length + " | " + infoTxt.trim() +
            " | 左栏 " + before + "->" + after;
        });
      }).then(function (v) {
        return restore().then(function () { closeModal(); return v + " | models.json 已还原"; });
      }).catch(function (e) {
        return restore().catch(function () {}).then(function () { closeModal(); throw e; });
      });
    });
    // 「测试」按钮链路：以前 ipc 层把 provider 名字字符串直接当对象用，
    // p.get("baseUrl") 永远 null → 永远报「没有配置 baseUrl」。
    // 修后名字会先解析成 models.json 里的对象。验证不需要真网络：
    // 用回环丢弃端口，只要错误从「没有配置 baseUrl」变成「请求 … 失败」即证明解析通了。
    step("ui.modelstest", function () {
      var orig = null;
      var put = function (c) { return send("models.write", { config: c }); };
      var tn = "zzz-test-p", miss = "zzz-test-p-missing";
      return send("models.read", {}).then(function (r) {
        orig = JSON.parse(JSON.stringify(r.config || { providers: {} }));
        var c1 = { providers: {} };
        c1.providers[tn] = {
          api: "openai-completions", apiKey: "sk-selftest",
          baseUrl: "http://127.0.0.1:9/v1",
          models: [{ id: "m1", name: "M1" }]
        };
        return put(c1);
      }).then(function () {
        return send("models.test", { provider: tn, model: "m1" });
      }).then(function () {
        throw new Error("打 127.0.0.1:9 居然成功了，测试环境不对");
      }, function (e) {
        var msg = (e && e.message) || String(e);
        if (msg.indexOf("baseUrl") >= 0) {
          throw new Error("仍在报 baseUrl：名字→对象解析没生效 :: " + msg);
        }
        if (msg.indexOf("请求") < 0 && msg.indexOf("HTTP") < 0) {
          throw new Error("错误不是网络请求类（解析可能仍不对）:: " + msg);
        }
        return "存在·baseUrl 已带出 :: " + msg.slice(0, 60);
      }).then(function (v1) {
        return send("models.test", { provider: miss, model: "m1" }).then(function () {
          throw new Error("不存在的 Provider 竟然测试成功");
        }, function (e) {
          var msg = (e && e.message) || String(e);
          if (msg.indexOf("没有 Provider") < 0) {
            throw new Error("不存在的名字应报「没有 Provider」:: " + msg);
          }
          return v1 + " | 不存在名字报错 ok :: " + msg.slice(0, 50);
        });
      }).then(function (v) {
        return put(orig).then(function () { return v + " | models.json 已还原"; });
      }).catch(function (e) {
        return put(orig).catch(function () {}).then(function () { throw e; });
      });
    });
    // 子代理页要列真实条目：内置 3 个 + npm 子代理包自带的（pi-subagents 等）。
    // 返回结构换成 profiles[]，内置与包自带的必须同时在。
    step("probe.agents", function () {
      return send("agents.list", {}).then(function (r) {
        var a = (r && r.profiles) || [];
        var names = a.map(function (x) { return x.name; });
        ["general-purpose", "explore", "plan"].forEach(function (n) {
          if (names.indexOf(n) < 0) throw new Error("缺少内置子代理 " + n);
        });
        var pkg = a.filter(function (x) { return x.scope === "package"; });
        var scopes = {};
        a.forEach(function (x) { scopes[x.scope] = (scopes[x.scope] || 0) + 1; });
        return a.length + " 个 :: 内置=" + (scopes.builtin || 0) + " 包=" + pkg.length +
          " 全局=" + (scopes.global || 0) + " | 名前5=" + names.slice(0, 5).join(",");
      });
    });
    // 子代理写链路：新建 -> 读回 -> 改 enabled -> 删除，全程只碰临时目录，
    // 不动用户真实的 ~/.pi/agent/agents。
    step("probe.agents.crud", function () {
      var nm = "selftest-agent";
      var prof = {
        name: nm, displayName: "Selftest", description: "selftest",
        systemPrompt: "line1: with colon\nline2", tools: ["read", "grep", "ls"],
        loadSkills: true, loadExtensions: false, thinking: "low", maxTurns: 3,
        inheritContext: true, runInBackground: false, promptMode: "append", enabled: true
      };
      var dir = null;
      return send("agents.save", { scope: "global", profile: prof }).then(function (r) {
        var got = ((r && r.profiles) || []).filter(function (p) { return p.name === nm && p.scope === "global"; })[0];
        if (!got) throw new Error("保存后回读不到 " + nm);
        dir = got.filePath;
        if ((got.tools || []).join(",") !== "read,grep,ls") throw new Error("tools 回读不对: " + JSON.stringify(got.tools));
        if (got.loadSkills !== true || got.loadExtensions !== false) throw new Error("资源布尔回读不对");
        if (got.thinking !== "low" || got.maxTurns !== 3) throw new Error("thinking/maxTurns 回读不对");
        if (got.inheritContext !== true) throw new Error("inheritContext 回读不对");
        if ((got.systemPrompt || "").indexOf("line2") < 0) throw new Error("系统指令正文丢失: " + JSON.stringify(got.systemPrompt));
        return send("agents.setEnabled", { scope: "global", name: nm, enabled: false });
      }).then(function (r) {
        var got = ((r && r.profiles) || []).filter(function (p) { return p.name === nm && p.scope === "global"; })[0];
        if (!got) throw new Error("setEnabled 后条目消失");
        if (got.enabled !== false) throw new Error("enabled 未改成功");
        // 改 enabled 不能碰其他键
        if ((got.tools || []).join(",") !== "read,grep,ls") throw new Error("setEnabled 污染了 tools");
        return send("agents.delete", { scope: "global", name: nm });
      }).then(function (r) {
        var gone = !((r && r.profiles) || []).some(function (p) { return p.name === nm; });
        if (!gone) throw new Error("删除后仍在列表里");
        return send("app.reveal", { path: dir }).then(function () { return "ok"; })
          .catch(function () { return "ok"; });
      }).then(function () {
        return "新建/回读/enabled/删除 四项通过，临时文件已清（勿手动删 ~/.pi/agent/agents/selftest-agent.md，流程已自行删）";
      });
    });
    // 左侧栏底部：模型 / 技能 / 设置 三个入口都要能真开面板
    step("foot.entries", function () {
      var got = [];
      [["open-models", "models"], ["open-skills", "skills"], ["open-settings", "general"]].forEach(function (p) {
        $(p[0]).click();
        var on = $("modal").hidden === false;
        var tab = $("modal-tabs").querySelector(".tab.on");
        got.push(p[1] + "=" + (on && tab && tab.textContent ? "ok" : "FAIL"));
        if (!on) throw new Error(p[0] + " 未打开面板");
        if (on && (!tab || tab.textContent === "")) throw new Error(p[0] + " 未选中分页");
        closeModal();
      });
      return got.join(" ");
    });
    // 文件浏览器工具栏：折叠 / 刷新 / 仅 Git 仓库根目录 / ~ 都要有反应
    step("files.tools", function () {
      var tree = $("file-tree");
      var before = tree.querySelectorAll(".node").length;
      $("files-toggle").click();
      var folded = tree.style.display === "none" || tree.hidden;
      $("files-toggle").click();    // 展开回去
      $("fs-refresh").click();
      return new Promise(function (r) { setTimeout(r, 400); }).then(function () {
        return loadTree("~").then(function () {
          var after = tree.querySelectorAll(".node").length;
          if (before < 1 || after < 1) throw new Error("文件树节点为空");
          if (!folded) throw new Error("折叠按钮无效");
          return "折叠=ok 刷新=" + before + "->" + after + " nodes";
        });
      });
    });
    // 文件浏览器工具条：终端 / 搜索 / 上传 / 刷新 四个按钮，行内悬停动作齐备
    step("files.head", function () {
      ["fs-term", "fs-search", "fs-upload", "fs-refresh"].forEach(function (id) {
        var b = $(id);
        if (!b) throw new Error("缺按钮 " + id);
        if (!b.title) throw new Error(id + " 缺 title（悬停提示）");
      });
      var row = $("file-tree").querySelector(".node");
      if (!row) throw new Error("文件树一行都没有");
      if (!row.querySelector(".row-acts .row-act.mention")) throw new Error("行内缺「提及」按钮");
      // 行内动作只能是悬停才现（否则会一直挡着文件名），默认 opacity 必须真为 0
      var acts = row.querySelector(".row-acts");
      var op = getComputedStyle(acts).opacity;
      if (op !== "0") throw new Error("行内动作默认不隐藏，opacity=" + op);
      if (getComputedStyle(acts).pointerEvents !== "none") throw new Error("隐藏时仍可点到");
      if (!row.querySelector(".nm").title) throw new Error("文件名缺完整路径 tooltip");
      var fileRow = $("file-tree").querySelector(".node:not(.dir)");
      if (fileRow && !fileRow.querySelector(".row-act.dl")) throw new Error("文件行缺「另存为」按钮");
      return "4 个工具按钮 + 行内动作 ok（默认 opacity=" + op + "）";
    });
    // 文件搜索：真跑一次递归搜索，再清掉
    step("files.search", function () {
      if (!fsSearchToggle(true)) throw new Error("搜索面板没打开");
      if ($("fs-panel").hidden) throw new Error("面板 hidden 属性没清");
      $("fs-query").value = "package";
      return fsRunSearch().then(function () {
        var n = $("fs-results").querySelectorAll(".node").length;
        if (!n) throw new Error("搜 package 零结果");
        $("fs-clear").click();
        return fsRunSearch();
      }).then(function () {
        fsSearchToggle(false);
        if (!$("fs-panel").hidden) throw new Error("搜索面板没关上");
        return "搜索=ok";
      });
    });
    // 「@ 提及」：点一下要真把相对路径插进输入框（不真发消息）
    step("files.mention", function () {
      var ta = $("input");
      var old = ta.value;
      var btn = $("file-tree").querySelector(".node:not(.dir) .row-acts .row-act.mention");
      if (!btn) throw new Error("没找到文件行的「提及」按钮");
      btn.click();
      var got = ta.value;
      ta.value = old;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      if (got.indexOf("@") !== 0) throw new Error("提及没插进输入框，实际：" + got);
      return "提及=" + got.trim();
    });
    // 顶栏计量：pi 的 get_session_stats 认的是「当前会话」，切完会话必须重取，
    // 否则开机恢复/点列表切会话后顶栏一直是 0。（曾经就是这么错的）
    /* 换会话后顶栏计量必须重取；顺带守住「点的就是 pi 正在跑的那条」的快路径。
       那种切换 pi 侧不用动，必须秒回——此前会白等一次 switch_session（大会话实测 15–32s，
       把本步骤直接拖过默认 30s 超时），所以这里既放宽超时又钉住快路径。 */
    step("ui.meter.switch", function () {
      var s = S.sessions[0];
      if (!s) throw new Error("无会话");
      var skip = S.liveSession === s.path;
      var t0 = Date.now();
      return openSession(s.path).then(function () {
        var ms = Date.now() - t0;
        var got = ["m-in", "m-out", "m-cache"].map(function (id) { return $(id).textContent; }).join("/");
        if (got === "0/0/0") throw new Error("换会话后计量没重取，还是 " + got);
        if (skip && ms > 20000) throw new Error("已在该会话却慢 " + ms + "ms（同会话快路径没生效）");
        return "计量=" + got + " · " + ms + "ms" + (skip ? "（同会话快路径）" : "");
      });
    }, 90000);
    // 选中文字浮窗（设置里可关）
    step("sel.popup", function () {
      if (!S.selectionPopup) return "已关闭，跳过";
      // 挑一个「真有文字、真的可见、而且真能选中」的正文节点：
      //   · 会话首条 assistant 的 .body 常是空的（只有工具卡）→ 空选区；
      //   · 折叠的思考块 / 历史分页里隐藏的节点 rect 是 0×0；
      //   · app.css 全局 body{user-select:none}，只给 .user-selectable 重新打开，
      //     所以工具卡里的 .body 就算有字，Chromium 也不会把选区真的挂上去
      //     （String(selection) 会是空 → 浮窗按设计不弹）。这三种都是假失败。
      function selectable(n) {
        for (var p = n; p && p !== document.documentElement; p = p.parentElement) {
          var cs = getComputedStyle(p);
          var us = cs.webkitUserSelect || cs.userSelect;
          if (us === "none") return false;
          if (us === "text" || us === "all") return true;
        }
        return false;
      }
      var cands = document.querySelectorAll("#stream-inner .msg .body, #stream-inner .msg .bubble-text");
      var body = null, nText = 0, nHide = 0, nNoSel = 0;
      for (var ci = 0; ci < cands.length; ci++) {
        if (cands[ci].textContent.trim().length < 2) continue;
        nText++;
        var cr = cands[ci].getBoundingClientRect();
        if (cr.width === 0 && cr.height === 0) { nHide++; continue; }
        if (!selectable(cands[ci])) { nNoSel++; continue; }
        body = cands[ci];
        break;
      }
      if (!body) {
        throw new Error("没有可选择的文本 候选=" + cands.length + " 有文字=" + nText +
          " 不可见=" + nHide + " 不可选=" + nNoSel);
      }
      var rng = document.createRange();
      rng.selectNodeContents(body);
      var sel = window.getSelection();
      var rlen = rng.toString().trim().length;
      var nodeInfo = (body.className || body.tagName) + ":" + body.textContent.trim().slice(0, 24);
      var pop = $("sel-pop");
      var len0 = 0, held = false, hasFocus = false;
      // 诊断：把浮窗的显示/隐藏切换与期间的 scroll 事件记下来（浮窗被 scroll 主动隐藏过就清楚了）
      var evT0 = Date.now(), evLog = [], scrollSeen = 0;
      try {
        new MutationObserver(function () { evLog.push("pop.hidden=" + pop.hidden + "@" + (Date.now() - evT0)); })
          .observe(pop, { attributes: true, attributeFilter: ["hidden"] });
        document.addEventListener("scroll", function (e) {
          var t = e.target;
          evLog.push("scroll:" + ((t && (t.id || t.className || t.tagName)) || "?") + "@" + (Date.now() - evT0));
        }, true);
        document.addEventListener("mouseup", function () { evLog.push("mouseup@" + (Date.now() - evT0)); }, true);
      } catch (e) {}
      // 挂选区：文档没焦点时 Chromium 直接忽略 addRange（整套连跑时窗口可能已失焦，
      // 单独跑就过），所以先补一次 window.focus()；还挂不上就再试一次。
      function grab() {
        try { window.focus(); } catch (e) {}
        sel.removeAllRanges();
        sel.addRange(rng);
        len0 = String(sel).trim().length;
        var r0 = sel.rangeCount ? sel.getRangeAt(0) : null;
        held = r0 ? (r0.startContainer === body) : false;
        hasFocus = document.hasFocus();
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return len0;
      }
      function settle() { return new Promise(function (r) { setTimeout(r, 120); }); }
      // 浮窗是 setTimeout(0) 后才定位并显示的，得等一拍。
      // 整套连跑时前面的步骤会让会话继续渲染/滚动，而 app.js 里 scroll 一响就隐藏浮窗，
      // 于是「选好 → 弹出 → 被滚掉」看起来像没弹：先等页面安静，不弹就重试几次。
      function quiet(ms) {
        return new Promise(function (res) {
          var t0 = Date.now(), last = Date.now(), mo = null;
          try {
            mo = new MutationObserver(function () { last = Date.now(); });
            mo.observe($("stream-inner") || document.body, { childList: true, subtree: true, characterData: true });
          } catch (e) { mo = null; }
          (function tick() {
            if (Date.now() - last > 250 || Date.now() - t0 > (ms || 3000)) {
              try { if (mo) mo.disconnect(); } catch (e) {}
              return res();
            }
            setTimeout(tick, 50);
          })();
        });
      }
      // 滚动期间浮窗按设计会被隐藏（app.js 的 scroll 监听），所以先等滚动停下来再选
      function scrollQuiet(ms) {
        var last = Date.now(), n = 0;
        function onScroll() { last = Date.now(); n++; }
        document.addEventListener("scroll", onScroll, true);
        return new Promise(function (res) {
          var t0 = Date.now();
          (function tick() {
            if (Date.now() - last > 300 || Date.now() - t0 > (ms || 4000)) {
              document.removeEventListener("scroll", onScroll, true);
              scrollSeen = n;
              return res();
            }
            setTimeout(tick, 50);
          })();
        });
      }
      return quiet(3000).then(function () { return scrollQuiet(4000); }).then(function () {
        var tries = 0;
        function loop() {
          grab();
          return settle().then(function () {
            if (!pop.hidden || ++tries >= 8) return;
            return loop();
          });
        }
        return loop();
      }).then(function () {
        // 诊断值必须在清选区之前取（清完 String(sel) 就成 0 字了，白查一趟）
        var st = " 选中=" + len0 + "字→" + String(sel).trim().length + "字 rng=" + rlen + "字 节点=" + nodeInfo +
          " 挂上=" + held + " focus=" + hasFocus + " rangeCount=" + sel.rangeCount +
          " active=" + ((document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "?") +
          " popHidden=" + pop.hidden + " popText=" + JSON.stringify(pop.textContent) +
          " modalHidden=" + $("modal").hidden + " selectionPopup=" + S.selectionPopup;
        var shown = !pop.hidden && pop.textContent === "就此提问";
        sel.removeAllRanges();
        pop.hidden = true;
        if (!shown) {
          // 弹窗开着时浮窗按设计就不弹（app.js 里 inModal 判断）；
          // 这是上一步失败没关弹窗的连锁反应，报清楚免得又去查浮窗。
          var m = $("modal");
          var rr = rng.getBoundingClientRect();
          throw new Error("浮窗未出现" +
            (m && !m.hidden ? "（#modal 还开着，浮窗按设计不弹）" : "") +
            st + " rect=" + Math.round(rr.width) + "×" + Math.round(rr.height) +
            " 首个失焦步=" + focusTrace() + " 滚动=" + scrollSeen + "次 streaming=" + !!S.streaming +
            " stream=" + (function () { var s = $("stream"); return s ? Math.round(s.scrollTop) + "/" + s.scrollHeight + "/" + s.clientHeight : "?"; })() +
            " 事件=" + (evLog.slice(-12).join(", ") || "无"));
        }
        return "浮窗文本=" + pop.textContent + " 位置=" + pop.style.left + "," + pop.style.top;
      });
    });
    // ---- 扩展 UI 接线（Rust 侧 ui.widget / ui.dialog / pi.parse_error 事件） ----
    step("ui.widget", function () {
      var above = $("widgets-above"), below = $("widgets-below");
      if (!above || !below) throw new Error("输入区没有 widgets 容器");
      emitEvent("ui.widget", { widgetKey: "st-a", widgetLines: ["第一行", "\u001b[31m彩色\u001b[0m行"], widgetPlacement: "aboveEditor" });
      if (above.hidden) throw new Error("aboveEditor 的 widget 没显示");
      var t = above.textContent;
      if (t.indexOf("第一行") < 0) throw new Error("行文本没渲染：" + JSON.stringify(t));
      if (t.indexOf("\u001b") >= 0) throw new Error("ANSI 转义没剥掉：" + JSON.stringify(t));
      emitEvent("ui.widget", { widgetKey: "st-b", widgetLines: ["下方一行"], widgetPlacement: "belowEditor" });
      if (below.hidden || below.textContent.indexOf("下方一行") < 0) throw new Error("belowEditor 的 widget 没显示");
      emitEvent("ui.widget", { widgetKey: "st-a", widgetLines: null });
      if (!above.hidden) throw new Error("移除 widget 后容器没隐藏");
      emitEvent("ui.widget", { widgetKey: "st-b", widgetLines: null });
      if (!below.hidden) throw new Error("移除下方 widget 后容器没隐藏");
      return "above/below 渲染、ANSI 剔除、移除都通";
    });
    // 扩展对话框：四种形态 + 三种取消路径，都要回 extension_ui_response
    step("ui.dialog", function () {
      function backs() { return document.querySelectorAll(".ui-dlg-back"); }
      function one() {
        var b = backs();
        if (b.length !== 1) throw new Error("对话框数量=" + b.length + "（期望 1）");
        return b[0];
      }
      function wait(ms) { return new Promise(function (r) { setTimeout(r, ms || 30); }); }
      // select：点选项回 {value}
      emitEvent("ui.dialog", { id: "st-sel", method: "select", title: "选一个", options: ["甲", { value: "乙", label: "乙选项", description: "说明" }] });
      var b = one();
      if (b.querySelectorAll(".ui-opt").length !== 2) throw new Error("select 选项数=" + b.querySelectorAll(".ui-opt").length + " html=" + b.outerHTML.slice(0, 400));
      b.querySelectorAll(".ui-opt")[1].click();
      var r1 = lastUiResponse();
      if (!r1 || r1.id !== "st-sel" || r1.value !== "乙") throw new Error("select 回包=" + JSON.stringify(r1));
      if (backs().length) throw new Error("select 回包后弹窗没关");
      // confirm：确定回 {confirmed:true}
      emitEvent("ui.dialog", { id: "st-cf", method: "confirm", message: "要继续吗" });
      one().querySelector(".ui-dlg-foot .btn-new").click();
      var r2 = lastUiResponse();
      if (!r2 || r2.id !== "st-cf" || r2.confirmed !== true) throw new Error("confirm 回包=" + JSON.stringify(r2));
      // input：输入 + 确定回 {value}
      emitEvent("ui.dialog", { id: "st-in", method: "input", title: "说点什么", placeholder: "…" });
      var bi = one();
      bi.querySelector(".ui-input").value = "你好";
      bi.querySelector(".ui-dlg-foot .btn-new").click();
      var r3 = lastUiResponse();
      if (!r3 || r3.value !== "你好") throw new Error("input 回包=" + JSON.stringify(r3));
      // editor：带 prefill，取消回 {cancelled:true}
      emitEvent("ui.dialog", { id: "st-ed", method: "editor", prefill: "预填" });
      var be = one();
      if (be.querySelector(".ui-editor").value !== "预填") throw new Error("editor 没带 prefill");
      be.querySelector(".ui-dlg-foot .btn").click();
      var r4 = lastUiResponse();
      if (!r4 || r4.id !== "st-ed" || r4.cancelled !== true) throw new Error("editor 取消回包=" + JSON.stringify(r4));
      // Esc 取消
      emitEvent("ui.dialog", { id: "st-esc", method: "input" });
      one();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      var r5 = lastUiResponse();
      if (!r5 || r5.id !== "st-esc" || r5.cancelled !== true) throw new Error("Esc 回包=" + JSON.stringify(r5));
      // pi 侧 timeout：前端同步关窗，别把弹窗挂着
      emitEvent("ui.dialog", { id: "st-to", method: "confirm", message: "等着", timeout: 60 });
      one();
      return wait(220).then(function () {
        if (backs().length) throw new Error("超时后弹窗还在");
        var r6 = lastUiResponse();
        if (!r6 || r6.id !== "st-to" || r6.cancelled !== true) throw new Error("超时回包=" + JSON.stringify(r6));
        return "select/confirm/input/editor/Esc/超时 都通";
      });
    });
    step("pi.parse_error", function () {
      emitEvent("pi.parse_error", { error: "自检注入的坏 JSON" });
      var t = $("toasts").textContent;
      if (t.indexOf("解析失败") < 0) throw new Error("没有解析失败提示：" + JSON.stringify(t.slice(0, 120)));
      return "提示已出：" + JSON.stringify(t.slice(0, 40));
    });
    // ---- 滚动跟随：往上翻之后，新消息不该把视口硬拽到底部 ----
    step("scroll.follow", function () {
      var stream = $("stream"), btn = $("jump-bottom");
      if (!btn) throw new Error("index.html 里没有 #jump-bottom");
      var scrollable = stream.scrollHeight - stream.clientHeight;
      if (scrollable < 400) throw new Error("会话太短，测不了滚动（可滚动高度=" + scrollable + "）");
      stream.scrollTop = 0;
      return until(function () { return !btn.hidden; }, 2000).then(function (v) {
        if (!v) throw new Error("翻到顶部后「回到底部」按钮没出现");
        if (scrollState().stick) throw new Error("翻到顶部后仍是粘底状态");
        // 注入一条新的助手消息：不该把视口拽走，而应计未读
        emitEvent("pi.event", { type: "message_start", message: { role: "assistant" } });
        if (stream.scrollTop > 40) throw new Error("新消息到达后视口被拽到底部（scrollTop=" + stream.scrollTop + "）");
        return until(function () { var c = $("jb-count"); return c && !c.hidden && c.textContent !== "0"; }, 2000);
      }).then(function (v) {
        if (!v) throw new Error("新消息没计入未读：" + JSON.stringify($("jb-count") && $("jb-count").textContent));
        var n = $("jb-count").textContent;
        btn.click();
        return until(function () {
          var s = $("stream");
          return btn.hidden && s.scrollHeight - s.scrollTop - s.clientHeight < 100 && scrollState().stick;
        }, 3000).then(function (v2) {
          if (!v2) throw new Error("点「回到底部」后没回到底部或按钮没隐藏");
          // 清掉刚才注入的那条空助手气泡，别留在消息流里
          var stray = stream.querySelectorAll("#stream-inner .msg.assistant");
          if (stray.length) stray[stray.length - 1].remove();
          return "离开底部浮出按钮 · 新消息计未读=" + n + " · 点击回底并隐藏";
        });
      });
    });
    // 顶栏 token 计量四个格子都要有值
    step("meter.cells", function () {
      var v = ["m-in", "m-out", "m-cache", "m-pct"].map(function (id) { return $(id).textContent.trim(); });
      var empty = v.filter(function (x) { return !x || x === "0"; });
      if (empty.length) throw new Error("计量有空值 " + JSON.stringify(v));
      return v.join(" | ");
    });
    // ---- 图片附件（点选插入） ----
    step("img.attach", function () {
      // 真实 1x1 PNG，走与点选完全相同的 addImageFiles 路径
      var b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      var bin = atob(b64);
      var u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      var f = new File([u8], "selftest.png", { type: "image/png" });
      var before = S.images.length;
      addImageFiles([f]);
      return new Promise(function (r) { setTimeout(r, 700); }).then(function () {
        if (S.images.length !== before + 1) throw new Error("未添加，S.images=" + S.images.length);
        // 期望值用另一条独立路径算（atob 解出的原始字节数），不硬编码
        var want = atob(b64).length;
        var n = b64Bytes(S.images[S.images.length - 1].data);
        if (n !== want) throw new Error("base64 解码字节数 " + n + " != " + want);
        var thumbs = document.querySelectorAll("#attach-strip .attach-thumb").length;
        if (thumbs !== S.images.length) throw new Error("缩略图 " + thumbs + " != " + S.images.length);
        return "S.images=" + S.images.length + " bytes=" + n + " thumbs=" + thumbs;
      });
    });
    step("img.remove", function () {
      var n = S.images.length;
      var rm = document.querySelector("#attach-strip .attach-thumb .rm");
      if (!rm) throw new Error("无移除按钮");
      rm.click();
      if (S.images.length !== n - 1) throw new Error("移除后 " + S.images.length + " != " + (n - 1));
      var box = $("attach-strip");
      if (!S.images.length && !box.hidden) throw new Error("清空后附件条未隐藏");
      return "已移除，剩 " + S.images.length + " 张，hidden=" + box.hidden;
    });
    step("img.payload", function () {
      // 推给 pi RPC 的结构必须与 pi-web 一致：{ type:"image", data, mimeType }
      var imgs = [{ data: "AAAA", mimeType: "image/png" }];
      var pi = imgs.map(function (i) { return { type: "image", data: i.data, mimeType: i.mimeType }; });
      var s = JSON.stringify(pi);
      if (s.indexOf('"type":"image"') < 0) throw new Error("缺 type:image");
      if (s.indexOf('"data":"AAAA"') < 0) throw new Error("缺 data");
      if (s.indexOf('"mimeType":"image/png"') < 0) throw new Error("缺 mimeType");
      return s;
    });
    step("img.live", function () {
      // 端到端走真实 UI 路径：选图 → 打字 → 发送。
      // 不能直接调 pi.send，那跳过了 addUserMsg，测不到气泡渲染。
      var prev = S.model;
      var imgModel = null;
      for (var i = 0; i < S.models.length; i++) {
        if (S.models[i].input && S.models[i].input.indexOf("image") >= 0) { imgModel = S.models[i]; break; }
      }
      if (!imgModel) throw new Error("无支持图片输入的模型");
      var px = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      var chain = (!prev || prev.id !== imgModel.id)
        ? send("pi.call", { type: "set_model", params: { provider: imgModel.provider, modelId: imgModel.id } })
        : Promise.resolve(null);
      return chain.then(function () {
        var uBefore = document.querySelectorAll("#stream-inner .msg.user").length;
        // 真实用户操作序列
        S.images = [{ data: px, mimeType: "image/png" }];
        renderAttachStrip();
        $("input").value = "图里是什么颜色？只回两个字";
        submit("prompt");
        return new Promise(function (res) {
          var t0 = Date.now();
          var iv = setInterval(function () {
            // 用户消息得先上屏，否则说明 submit 没走通
            if (document.querySelectorAll("#stream-inner .msg.user").length > uBefore && !S.streaming) { clearInterval(iv); res(); }
            else if (Date.now() - t0 > 90000) { clearInterval(iv); res(); }
          }, 500);
        }).then(function () {
          var bubbles = document.querySelectorAll("#stream-inner .msg.user .bubble-images img");
          var uAfter = document.querySelectorAll("#stream-inner .msg.user").length;
          var asst = document.querySelectorAll("#stream-inner .msg.assistant").length;
          var cleared = S.images.length === 0 && $("attach-strip").hidden;
          var restore = (prev && prev.id !== imgModel.id)
            ? send("pi.call", { type: "set_model", params: { provider: prev.provider, modelId: prev.id } })
            : Promise.resolve(null);
          return restore.then(function () {
            if (uAfter <= uBefore) throw new Error("用户消息未上屏 " + uBefore + " -> " + uAfter);
            if (bubbles.length === 0) throw new Error("用户气泡内未渲染图片");
            if (!cleared) throw new Error("发送后附件未清空");
            if (asst === 0) throw new Error("助手无回复");
            return "模型=" + imgModel.id + " 用户图=" + bubbles.length + " 用户消息=" + uAfter + " 助手=" + asst + " 附件已清空";
          });
        });
      });
    }, 120000);

    // ---- 模型选择（底部模型按钮 + 下拉） ----
    step("model.btn", function () {
      renderModelBtn();
      var t = $("model-name").textContent;
      if (!t || t === "—") throw new Error("按钮未显示模型名");
      return "按钮文本=" + t + " | title=" + $("model-btn").title;
    });
    step("model.pop", function () {
      openModelPop();
      var pop = $("model-pop");
      if (pop.hidden) throw new Error("下拉未展开");
      var items = pop.querySelectorAll(".mp-item").length;
      var lv = pop.querySelectorAll(".mp-lv button").length;
      var on = pop.querySelectorAll(".mp-lv button.on").length;
      if (items < S.models.length) throw new Error("模型行 " + items + " < " + S.models.length);
      if (lv === 0) throw new Error("无思考等级按钮");
      if (on !== 1) throw new Error("当前思考等级高亮 " + on + " 个");
      var txt = pop.textContent.replace(/\s+/g, " ").trim();
      closeModelPop();
      if (!$("model-pop").hidden) throw new Error("关闭失败");
      return "模型行=" + items + " 等级=" + lv + " 高亮=" + on + " | " + txt.slice(0, 120);
    });
    step("model.switch", function () {
      // 真切换：换到别的模型，拿 get_state 核对，再切回来。
      if (S.models.length < 2) return "只有 " + S.models.length + " 个模型，跳过";
      var prev = S.model;
      var tgt = null;
      for (var i = 0; i < S.models.length; i++) {
        if (!prev || S.models[i].id !== prev.id) { tgt = S.models[i]; break; }
      }
      return send("pi.call", { type: "set_model", params: { provider: tgt.provider, modelId: tgt.id } })
        .then(function () { return send("pi.call", { type: "get_state" }); })
        .then(function (r) {
          var got = r.data.model.id;
          if (got !== tgt.id) throw new Error("切到 " + got + " != " + tgt.id);
          return send("pi.call", { type: "set_model", params: { provider: prev.provider, modelId: prev.id } });
        })
        .then(function () { return send("pi.call", { type: "get_state" }); })
        .then(function (r) {
          if (r.data.model.id !== prev.id) throw new Error("回滚失败 " + r.data.model.id + " != " + prev.id);
          S.model = r.data.model; renderModelBtn();
          return prev.id + " -> " + tgt.id + " -> " + prev.id + " (get_state 核过)";
        });
    });
    step("model.levels", function () {
      return send("pi.call", { type: "get_available_thinking_levels" }).then(function (r) {
        var lv = (r.data && r.data.levels) || [];
        if (!lv.length) throw new Error("无可用等级");
        var prev = S.thinkLevel;
        var tgt = lv[lv.length - 1];
        return send("pi.call", { type: "set_thinking_level", params: { level: tgt } })
          .then(function () { return send("pi.call", { type: "get_state" }); })
          .then(function (st) {
            if (st.data.thinkingLevel !== tgt) throw new Error("set " + tgt + " 实际 " + st.data.thinkingLevel);
            return send("pi.call", { type: "set_thinking_level", params: { level: prev } });
          })
          .then(function () {
            S.thinkLevel = prev; renderModelBtn();
            return "levels=" + lv.join(",") + " | 切 " + tgt + " 已 get_state 核过，已回滚 " + prev;
          });
      });
    });
    // ---- 输入区（聊天框）：空闲/运行两态 + 三个胶囊 ----
    step("composer.state", function () {
      var box = $("composer-box"), cc = $("chip-compact"), inp = $("input");
      if (!box) throw new Error("缺 #composer-box");
      if (!cc || !$("chip-think") || !$("chip-preset") || !$("btn-sound")) throw new Error("输入区控件缺失");
      function vis(id) { return !$(id).hidden; }
      var before = S.streaming;
      // 空闲态（对应参考图 1）：只有发送
      S.streaming = false; updateRunState();
      if (!vis("btn-send")) throw new Error("空闲态没有发送按钮");
      if (vis("btn-steer") || vis("btn-follow")) throw new Error("空闲态不该出现引导/后续消息");
      if (vis("btn-stop")) throw new Error("空闲态不该出现停止");
      if (cc.disabled) throw new Error("空闲态压缩不可点");
      if (box.classList.contains("streaming")) throw new Error("空闲态外壳不该带 streaming 类");
      if (inp.placeholder.indexOf("输入消息") < 0) throw new Error("空闲态占位=" + inp.placeholder);
      // 运行态（对应参考图 2）：引导 / 后续消息 / 停止，外壳转琥珀色
      S.streaming = true; updateRunState();
      if (vis("btn-send")) throw new Error("运行态还显示发送按钮");
      if (!vis("btn-steer") || !vis("btn-follow") || !vis("btn-stop")) throw new Error("运行态缺引导/后续消息/停止");
      if (!cc.disabled) throw new Error("运行态压缩仍可点");
      if (!box.classList.contains("streaming")) throw new Error("运行态外壳没转琥珀色");
      if (inp.placeholder.indexOf("引导") < 0) throw new Error("运行态占位=" + inp.placeholder);
      S.streaming = before; updateRunState();
      // 胶囊下拉
      openChipPop("think");
      var p1 = $("chip-pop");
      if (p1.hidden) throw new Error("思考胶囊没展开");
      var n1 = p1.querySelectorAll(".mp-item").length;
      closeChipPop();
      openChipPop("preset");
      var p2 = $("chip-pop"), it = p2.querySelectorAll(".mp-item");
      if (p2.hidden) throw new Error("预设胶囊没展开");
      if (it.length !== 4) throw new Error("预设项 " + it.length + " != 4");
      var checked = 0, names = [];
      for (var i = 0; i < it.length; i++) {
        names.push(it[i].querySelector(".nm").textContent);
        if (it[i].querySelector(".ck").style.visibility !== "hidden") checked++;
      }
      var note = p2.querySelector(".mp-note") ? "有重启说明" : "缺重启说明";
      closeChipPop();
      if (!$("chip-pop").hidden) throw new Error("胶囊下拉没关掉");
      // 胶囊文字是汉化后的等级名（THINK_LABEL），跟着设置里的级别变
      if ($("chip-think-txt").textContent !== (THINK_LABEL[S.thinkLevel] || S.thinkLevel || "中")) throw new Error("思考胶囊=" + $("chip-think-txt").textContent);
      if ($("chip-preset-txt").textContent !== presetLabel(S.toolPreset)) throw new Error("预设胶囊=" + $("chip-preset-txt").textContent);
      // 提示音图标随开关切
      var wasSound = S.sound;
      S.sound = true; renderChips();
      var h1 = $("btn-sound").querySelector("use").getAttribute("href");
      S.sound = false; renderChips();
      var h2 = $("btn-sound").querySelector("use").getAttribute("href");
      S.sound = wasSound; renderChips();
      if (h1 === h2) throw new Error("提示音图标没跟着切");
      return "空闲/运行两态 ok | 等级项=" + n1 + " 预设=" + names.join("/") + " 勾=" + checked + " | " + note + " | 图标 " + h1 + "->" + h2;
    });
    // 预设真的进配置（写进去 / 回读 / 回滚）
    step("composer.preset", function () {
      var orig = S.toolPreset || "default";
      return send("settings.get").then(function (s) {
        if (s.toolPreset !== orig) throw new Error("settings.get 的 preset=" + s.toolPreset + " != " + orig);
        return send("settings.set", { toolPreset: "chat-only" });
      }).then(function () { return send("settings.get"); })
        .then(function (s) {
          if (s.toolPreset !== "chat-only") throw new Error("写入后回读=" + s.toolPreset);
          // 非法值要被 Rust 侧夹掉
          return send("settings.set", { toolPreset: "--evil" });
        })
        .then(function () { return send("settings.get"); })
        .then(function (s) {
          if (s.toolPreset !== "chat-only") throw new Error("非法 preset 没被夹住，现为 " + s.toolPreset);
          return send("settings.set", { toolPreset: orig });
        })
        .then(function () { return send("settings.get"); })
        .then(function (s) {
          if (s.toolPreset !== orig) throw new Error("回滚失败=" + s.toolPreset);
          S.toolPreset = orig; renderChips();
          return "配置回环 ok（" + orig + " -> chat-only -> --evil 被夹 -> " + orig + "）";
        });
    });
    // 顶栏四个按钮：完整历史 / 生成标题 / 系统 / 工具
    step("topbar.history", function () { showHistory(); closeModal(); return "ok"; });
    step("topbar.system", function () { showSystem(); closeModal(); return "ok"; });
    step("topbar.tools", function () { showTools(); closeModal(); return "ok"; });
    step("topbar.title", function () {
      return generateTitle().then(function (r) {
        if (!r || !r.success) throw new Error("set_session_name 失败 " + JSON.stringify(r));
        // 真拿会话列表核对一次：标题得是新的，不能只是 RPC 返回 success。
        return send("session.list").then(function (l) {
          var cur = null;
          for (var i = 0; i < l.sessions.length; i++) {
            if (l.sessions[i].path === S.activeSession) cur = l.sessions[i];
          }
          var dom = document.querySelector("#session-list .sess.active .sess-title");
          return "rpc=" + ((cur && cur.name) || "(索引无名字)") +
            " | dom=" + ((dom && dom.textContent) || "(无活动项)") +
            " | state=" + (S.sessionName || "(空)");
        });
      });
    });

    // ---- 设置：插件页 ----
    step("plugins.list", function () {
      return send("plugins.list", { cwd: S.cwd || "" }).then(function (r) {
        var pk = (r && r.packages) || [];
        var ex = (r && r.standaloneExtensions) || [];
        var t = (r && r.totals) || {};
        if (!pk.length && !ex.length) throw new Error("没读到任何插件/扩展");
        pk.forEach(function (p) {
          if (!p.source || !p.scope || !p.status) throw new Error("包字段缺失: " + JSON.stringify(p).slice(0, 160));
        });
        return "包=" + pk.length + " 独立扩展=" + ex.length + " 统计=" +
          (t.extensions || 0) + "ext/" + (t.skills || 0) + "sk/" + (t.prompts || 0) + "pr/" + (t.themes || 0) + "th" +
          " | " + pk.map(function (p) {
            var c = p.counts || {};
            return p.displayName + "[" + p.status + "," + (c.extensions || 0) + "/" + (c.skills || 0) + "/" + (c.prompts || 0) + "]";
          }).join(" ");
      });
    });
    /* 插件页两种状态 + 统计 + 真开关：
       面板是异步渲染的，得先等 plugins.list 回来（左下出现「+ 添加插件」）。 */
    step("plugins.ui", function () {
      openModal("extensions");
      var t0 = Date.now();
      return new Promise(function (res, rej) {
        (function tick() {
          var add = document.querySelector("#modal-body .split-foot .btn-block");
          if (add) return res(add);
          if (Date.now() - t0 > 8000) return rej(new Error("插件页未渲染左侧底部"));
          setTimeout(tick, 100);
        })();
      }).then(function (add) {
        var out = [];
        // 状态 1：详情。列表里要有分组标题与可点项。
        var lis = document.querySelectorAll("#modal-body .split-list .li");
        if (!lis.length) throw new Error("左侧列表为空");
        lis[0].click();
        var kv = document.querySelectorAll("#modal-body .split-right .kv dd");
        if (kv.length < 2) throw new Error("详情区 kv 行数不足 " + kv.length);
        var text1 = document.querySelector("#modal-body .split-right").textContent;
        if (text1.indexOf("状态") < 0 || text1.indexOf("安装路径") < 0) throw new Error("详情缺「状态/安装路径」");
        out.push("详情:kv=" + kv.length + " 项=" + lis.length);

        // 底部：统计文字 + 两个按钮，且统计必须真来自 totals
        var foot = document.getElementById("modal-foot");
        if (foot.hidden) throw new Error("底部状态栏未显示");
        var stat = (foot.querySelector(".foot-stat") || {}).textContent || "";
        if (!/\d+ 插件 · \d+ 技能 · \d+ 提示词 · \d+ 主题/.test(stat)) throw new Error("统计文字格式不对: " + stat);
        var fbtns = foot.querySelectorAll("button");
        if (fbtns.length !== 2) throw new Error("底部按钮 " + fbtns.length + " != 2");
        out.push("底部:" + stat + " 按钮=" + [].map.call(fbtns, function (b) { return b.textContent; }).join("/"));

        // 状态 2：点左下「+ 添加插件」→ 换成添加界面
        add.click();
        var sr = document.querySelector("#modal-body .split-right");
        var addText = sr.textContent;
        if (addText.indexOf("添加插件") < 0) throw new Error("未切到添加态");
        if (addText.indexOf("来源") < 0) throw new Error("添加态缺来源");
        if (addText.indexOf("示例") < 0) throw new Error("添加态缺示例");
        var inp = sr.querySelector("input.plg-input");
        if (!inp || !/^npm:@scope\/package$/.test(inp.placeholder)) throw new Error("Source 占位符不对");
        var segs = sr.querySelectorAll(".seg .seg-b");
        if (segs.length !== 2) throw new Error("global/project 切换段 " + segs.length + " != 2");
        if (segs[0].textContent !== "全局" || segs[1].textContent !== "项目") throw new Error("段文字不对");
        if (!segs[0].classList.contains("on")) throw new Error("默认未选中 global");
        var exs = sr.querySelectorAll("input.plg-ex");
        if (exs.length !== 3) throw new Error("Examples 行 " + exs.length + " != 3");
        var exPh = [].map.call(exs, function (i2) { return i2.placeholder; }).join(" | ");
        if (exPh.indexOf("npm:@scope/pi-plugin") < 0 || exPh.indexOf("git:https://github.com/user/repo") < 0 ||
            exPh.indexOf("/absolute/path/to/plugin") < 0) throw new Error("Examples 占位符不对: " + exPh);
        segs[1].click();
        var projOn = segs[1].classList.contains("on") && !segs[0].classList.contains("on");
        segs[0].click();
        if (!projOn) throw new Error("global/project 切换无效");
        if (!segs[0].classList.contains("on")) throw new Error("切回 global 失败");
        out.push("添加态:Source+" + segs.length + "段+" + exs.length + "Examples");

        // 再点一次回到详情态
        add.click();
        if (document.querySelector("#modal-body .split-right").textContent.indexOf("添加插件") >= 0)
          throw new Error("再点未能回到详情态");
        out.push("回到详情:ok");
        // 跑完把弹窗关掉：留着会盖住后面步骤的元素命中测试（rp.closable 曾因此报「✕ 点不到」）
        closeModal();
        return out.join(" | ");
      });
    });
    /* 独立扩展的真开关：settings.json 的 extensions 数组读得到前后差异再还原。
       不落盘检查就是假验证——本地已存在 pebrel.ts，拿它开刀。 */
    step("plugins.toggle", function () {
      return send("plugins.list", { cwd: S.cwd || "" }).then(function (r) {
        var ex = (r.standaloneExtensions || [])[0];
        // 用户没装独立扩展（只装了 npm 包）时跳过：环境里没有可测对象，不是功能坏了。
        if (!ex) return "无独立扩展，跳过（settings.json 的 extensions 为空）";
        var before = ex.enabled !== false;
        return send("plugins.action", { action: "toggleExtension", source: (before ? "-" : "+") + ex.path, scope: "global", cwd: S.cwd || "" })
          .then(function (r2) {
            var after = null;
            (r2.standaloneExtensions || []).forEach(function (e) { if (e.path === ex.path) after = e.enabled !== false; });
            if (after === null) throw new Error("回读不到该扩展");
            if (after === before) throw new Error("开关未生效 " + before + " -> " + after + " (" + ex.name + ")");
            return send("plugins.action", { action: "toggleExtension", source: (before ? "+" : "-") + ex.path, scope: "global", cwd: S.cwd || "" })
              .then(function (r3) {
                var back = null;
                (r3.standaloneExtensions || []).forEach(function (e) { if (e.path === ex.path) back = e.enabled !== false; });
                if (back !== before) throw new Error("回滚失败 " + before + " -> " + back);
                return ex.name + " " + before + " -> " + after + " -> " + back + " (settings.json 已核对)";
              });
          });
      });
    });
    /* 后端得查「全部可检查包」（含项目级）：cwd 必传，否则 <cwd>/.pi/settings.json 里的包漏查。 */
    step("plugins.check", function () {
      return send("plugins.list", { cwd: PROJ_SRC }).then(function (l) {
        return send("plugins.check", { cwd: PROJ_SRC }).then(function (r) {
          var us = (r && r.updates) || [];
          var pk = (l && l.packages) || [];
          us.forEach(function (u) {
            if (!u.source || !u.state) throw new Error("检查结果字段缺失: " + JSON.stringify(u).slice(0, 160));
          });
          var want = pk.filter(function (p) { return p.canCheckForUpdates; }).length;
          if (us.length !== want) throw new Error("查了 " + us.length + " 个，应为全部可检查包 " + want + " 个（前端收窄或后端漏查）");
          var states = {};
          us.forEach(function (u) { states[u.state] = (states[u.state] || 0) + 1; });
          var projN = us.filter(function (u) { return u.scope === "project"; }).length;
          var projWant = pk.filter(function (p) { return p.scope === "project" && p.canCheckForUpdates; }).length;
          if (projN !== projWant) throw new Error("项目级包漏查 " + projN + " != " + projWant);
          return "可检查=" + want + " 查了=" + us.length + " 状态=" +
            Object.keys(states).map(function (k) { return k + "×" + states[k]; }).join(",") +
            " 项目级=" + projN + "（合计包 " + pk.length + "）";
        });
      });
    });
    /* 结果必须看得见：每行徽标 + 详情「更新状态」行 + 底部按钮变「全部更新 (N)」。
       绝不点「全部更新」——那是真去改用户的插件目录。 */
    step("plugins.check.ui", function () {
      function waitFor(fn, ms) {
        var t0 = Date.now();
        return new Promise(function (res, rej) {
          (function tick() {
            var v = fn();
            if (v) return res(v);
            if (Date.now() - t0 > ms) return rej(new Error("等超时"));
            setTimeout(tick, 120);
          })();
        });
      }
      function footBtn(txt) {
        var bs = document.querySelectorAll("#modal-foot button");
        for (var i = 0; i < bs.length; i++) if (bs[i].textContent === txt) return bs[i];
        return null;
      }
      function footMain() {
        var bs = document.querySelectorAll("#modal-foot button");
        for (var i = 0; i < bs.length; i++) if (bs[i].textContent !== "刷新") return bs[i];
        return null;
      }
      openModal("extensions");
      function footDiag() {
        var f = document.getElementById("modal-foot");
        var kids = f ? [].map.call(f.children, function (n) { return n.tagName + ":" + (n.textContent || "").slice(0, 16); }).join(" | ") : "无 #modal-foot";
        return " 底部=[" + kids + "] hidden=" + (f ? f.hidden : "?") +
          " 弹窗hidden=" + (document.getElementById("modal") || {}).hidden +
          " 包行=" + document.querySelectorAll("#modal-body .split-list .li").length +
          " 徽标=" + document.querySelectorAll("#modal-body .split-list .li .upd-badge").length;
      }
      function waitMain(ms) {
        return waitFor(function () { return footMain(); }, ms)
          .catch(function (e) { throw new Error(e.message + "（等底部主按钮）" + footDiag()); });
      }
      return waitMain(15000).then(function () {
        var pk = 0;
        return send("plugins.list", { cwd: S.cwd || "" }).then(function (l) {
          pk = ((l && l.packages) || []).length;
          if (!pk) throw new Error("没有包，无法验更新检查 UI");
          return waitMain(8000);
        }).then(function (btn) {
          var before = btn.textContent;
          if (!/^(检查更新|全部更新 \(\d+\))$/.test(before)) throw new Error("底部主按钮文案异常「" + before + "」");
          btn.click();
          function diag() {
            var t = [].map.call(document.querySelectorAll("#toasts > *"), function (x) { return x.textContent; }).join(" ~ ");
            return " 底部=「" + ((footMain() || {}).textContent || "无") + "」 包行=" +
              document.querySelectorAll("#modal-body .split-list .li").length +
              " 徽标=" + document.querySelectorAll("#modal-body .split-list .li .upd-badge").length +
              " 提示=" + t.slice(0, 200);
          }
          return waitFor(function () {
            return document.querySelectorAll("#modal-body .split-list .li .upd-badge").length;
          }, 90000).catch(function (e) { throw new Error(e.message + diag()); });
        }).then(function (nBadge) {
          if (nBadge !== pk) throw new Error("徽标 " + nBadge + " != 包数 " + pk + "（有包没拿到状态）");
          var txt = [].map.call(document.querySelectorAll("#toasts > *"), function (t) { return t.textContent; }).join(" ~ ");
          if (!/\d+ 个已是最新/.test(txt)) throw new Error("toast 没有三分计数: " + txt.slice(0, 160));
          var m = txt.match(/(\d+) 个可更新/);
          var avail = m ? parseInt(m[1], 10) : 0;
          var nAvail = document.querySelectorAll("#modal-body .split-list .li .upd-badge.avail").length;
          if (nAvail !== avail) throw new Error("徽标可更新数 " + nAvail + " != toast " + avail);
          var fb = footBtn("检查更新");
          var fbTxt = fb ? "检查更新" : ((footMain() || {}).textContent || "");
          if (avail) {
            if (!/^全部更新 \(\d+\)$/.test(fbTxt)) throw new Error("有可更新项时按钮应变「全部更新 (N)」，实际「" + fbTxt + "」");
            if (parseInt(fbTxt.match(/\((\d+)\)/)[1], 10) !== avail) throw new Error("按钮计数与徽标不一致: " + fbTxt);
          } else if (fbTxt !== "检查更新") throw new Error("无可更新项时按钮应回「检查更新」，实际「" + fbTxt + "」");
          var out = "徽标=" + nBadge + "/" + pk + " 可更新=" + avail + " 按钮=「" + fbTxt + "」 toast=" + txt.slice(0, 70);
          // 详情行 + 单包检查（点包行的「检查更新」，只查这一个）
          var first = document.querySelector("#modal-body .split-list .li");
          if (first) first.click();
          var dd = [].map.call(document.querySelectorAll("#modal-body .split-right .kv dd"), function (d) { return d.textContent; }).join(" | ");
          if (dd.indexOf("未检查") >= 0) throw new Error("已检查过，详情仍是「未检查」: " + dd);
          if (dd.indexOf("已是最新") < 0 && dd.indexOf("可更新") < 0 && dd.indexOf("无法自动检查") < 0 && dd.indexOf("检查失败") < 0)
            throw new Error("详情缺「更新状态」行: " + dd);
          out += " | 详情更新状态=ok";
          var ck1 = null;
          var acts = document.querySelectorAll("#modal-body .split-right .plg-actions button");
          for (var i = 0; i < acts.length; i++) if (acts[i].textContent === "检查更新") ck1 = acts[i];
          if (!ck1) return out + " | 单包按钮=缺（该包不可检查）";
          ck1.click();
          return waitFor(function () {
            var t = [].map.call(document.querySelectorAll("#toasts > *"), function (x) { return x.textContent; }).join(" ~ ");
            return /(^|· )1 个已是最新/.test(t) || /0 个已是最新/.test(t);
          }, 60000).then(function () { return out + " | 单包检查=ok"; });
        });
      })
        // 成功/失败都把弹窗关掉：留着会盖住后面步骤的元素命中测试
        .then(function (v) { closeModal(); return v; }, function (e) { closeModal(); throw e; });
    }, 180000);

    /* ---- 右侧面板（文件 / 网页查看器）：全部走真实 DOM 事件，不直接读内部状态糊弄 ---- */
    var RP_PROJ = PROJ_SRC;
    function rpWait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function rpFire(node, type, init) {
      var ev = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init || {}));
      node.dispatchEvent(ev);
      return ev;
    }
    function rpTreeRow(name) {
      var rows = $("file-tree").querySelectorAll(".node");
      for (var i = 0; i < rows.length; i++) {
        var nm = rows[i].querySelector(".nm");
        if (nm && nm.textContent === name) return rows[i];
      }
      return null;
    }
    function rpFreshTabs() { RP.tabs.slice().forEach(function (t) { rpCloseTab(t.id); }); }

    step("tool.preview", function () {
      // 中间消息面板的工具卡片：不管哪个工具，标题上就是「绿色工具名 + 一行摘要 + 省略号 + 耗时 + 箭头」
      var cases = {
        powershell: { command: "cd " + PROJ_SRC + "\n$md = \"" + PROJ + "\\PLAN.md\"\nif (Test-Path $md) { \"ok\" }" },
        read: { path: TMP_DIR + "\\rp-final.png", offset: 1, limit: 50 },
        compress: { topic: "工具卡片", content: [{ startId: "m06200", endId: "m06230", summary: "很长的摘要\n换了行" }, { startId: "m06240", endId: "m06246" }] },
        edit: { file_path: PROJ + "\\assets\\app.js", oldText: "aaaa\nbbbb", newText: "cccc" },
        grep: { pattern: "toolPreview", path: "assets" },
        unknown: { foo: { bar: 1 }, baz: 2 }
      };
      // 不入消息流：把卡片挂在 body 上量完就摘，前面步骤的节点计数不会被污染
      var host = document.createElement("div");
      host.style.cssText = "position:fixed;left:-9999px;top:0;width:520px";
      document.body.appendChild(host);
      var node = { el: host, tools: {} };
      var out = [];
      try {
        Object.keys(cases).forEach(function (name) {
          var rec = toolCard(node, "c-" + name, name);
          setToolInput(rec, cases[name]);
          var txt = rec.arg.textContent;
          if (/\[object /.test(txt)) throw new Error(name + " 摘要里出现了 [object Object]：" + txt);
          if (/\n/.test(txt)) throw new Error(name + " 摘要居然换行了：" + JSON.stringify(txt));
          if (!txt) throw new Error(name + " 摘要是空的");
          if (rec.arg.title !== txt) throw new Error(name + " 没给悬浮看全的 title");
          // 入参按类别走不同排版：shell 给原始脚本、edit 给 diff、read/write 给行号视图、其余给中文键值表
          if (rec.kind === "shell") {
            if (rec.preArgs._lang !== HL_SHELL[name]) throw new Error(name + " 入参没按 " + HL_SHELL[name] + " 上色：" + rec.preArgs._lang);
            if (rec.preArgs.textContent !== cases[name].command) throw new Error(name + " 入参不是原始脚本");
            if (!/hljs-/.test(rec.preArgs.innerHTML)) throw new Error(name + " 脚本没上高亮");
            if (!rec.meta.hidden) throw new Error(name + " shell 卡片不该同时显示键值表");
          } else {
            if (!rec.preArgs.hidden || rec.preArgs.innerHTML !== "") throw new Error(name + " 非 shell 的入参不该再摊 JSON");
            if (rec.meta.hidden) throw new Error(name + " 非 shell 卡片没显示排版后的入参");
          }
          if (!rec.body.hidden) throw new Error(name + " 卡片默认就是展开的");
          out.push(name + "=" + txt.slice(0, 30));
        });
        if (host.querySelectorAll(".tool-card").length !== 6) throw new Error("卡片数量不对");
        if (!/2 段 m06200–m06230 m06240–m06246/.test(toolPreview(cases.compress))) {
          throw new Error("compress 摘要没讲清压了哪几段：" + toolPreview(cases.compress));
        }
        var long = toolPreview({ command: new Array(400).join("x") });
        if (long.length > 130 || long.slice(-1) !== "…") throw new Error("超长摘要没被省略号收尾：len=" + long.length);
        // 真的溢出时必须是省略号，不是硬生生截断
        var wide = toolCard(node, "c-wide", "read");
        setToolInput(wide, { path: new Array(600).join("a") });
        var cs = getComputedStyle(wide.arg);
        if (cs.textOverflow !== "ellipsis" || cs.whiteSpace !== "nowrap") throw new Error("摘要溢出没用省略号：" + cs.textOverflow + "/" + cs.whiteSpace);
        if (wide.arg.clientWidth === 0) throw new Error("摘要没宽度，量不到溢出");
        // 跑完的卡片：耗时是「19s」这种整秒，展开区默认收起
        var done = toolCard(node, "c-done", "read");
        setToolInput(done, { path: "a\\b.txt" });
        finishTool(done, "文件内容第一行\n第二行", false);
        if (!/^\d+s$/.test(done.dur.textContent)) throw new Error("耗时格式不对：" + done.dur.textContent);
        if (!done.body.hidden) throw new Error("跑完的卡片没收起");
        if (done.pre.innerHTML !== "") throw new Error("没展开就已经上色了，违反懒执行");
        done.body.hidden = false; hlApplyPre(done.pre);
        if (done.pre.textContent.indexOf("第二行") < 0) throw new Error("展开区没接住工具输出");
        // 代码高亮（离线库 + 跨行注释按行切分）
        if (!hlReady()) throw new Error("离线高亮库没加载");
        if (!window.hljs.getLanguage("powershell")) throw new Error("powershell 语言包没加载");
        if (!/<span class="hljs-/.test(hlCode('{"a":1}', "json"))) throw new Error("JSON 没上色");
        if (esc('<b>&</b>') !== "&lt;b&gt;&amp;&lt;/b&gt;") throw new Error("esc 函数被动过");
        if (hlCode("一段中文", "") !== esc("一段中文")) throw new Error("没语言时应该原样转义");
        if (hlCode("", "json") !== "") throw new Error("空文本不该产出内容");
        var sp = hlSplit(hlCode("/* 注释\n继续 */\nvar x = 1; // 尾注", "javascript"), 3);
        if (!sp || sp.length !== 3) throw new Error("按行切分对不上原文行数");
        if (!/hljs-comment/.test(sp[0]) || !/hljs-comment/.test(sp[1])) throw new Error("跨行注释第二行掉色：" + sp[1]);
        if (!/hljs-keyword/.test(sp[2])) throw new Error("第三行没上色：" + sp[2]);
        if (hlSplit(hlCode("a\nb", ""), 9) !== null) throw new Error("行数对不上时应该返回 null");
        var bad = toolCard(node, "c-bad", "read");
        finishTool(bad, "报错了", true);
        if (!bad.card.classList.contains("err") || bad.body.hidden) throw new Error("出错的卡片没标红并自动展开");

        // 工具名 / 参数键中文化（查不到的必须原样显示，不能变成 undefined）
        if (toolZh("read") !== "读取文件") throw new Error("read 没中文化：" + toolZh("read"));
        if (toolZh("mcp__fs__read_file") !== "读取文件") throw new Error("MCP 装饰名没剥到词根：" + toolZh("mcp__fs__read_file"));
        if (toolZh("奇轻的工具") !== "奇轻的工具") throw new Error("查不到的工具名应该原样显示");
        if (ARG_ZH.oldText !== "原内容" || ARG_ZH.limit !== "行数") throw new Error("参数键中文表被动过");
        if (hlLangOfPath("a\\b.ps1") !== "powershell" || hlLangOfPath("a\\b.js") !== "javascript") throw new Error("按扩展名认语言失效");

        // 卡片标题 = 中文名 + 原名；read 入参是「文件 + 行范围」，结果挂行号列
        var rd = toolCard(node, "c-read2", "read");
        setToolInput(rd, { path: "D:\\a\\b.txt", offset: 20, limit: 30 });
        if (rd.card.querySelector(".tool-name").textContent !== "读取文件read") {
          throw new Error("卡片标题不是「中文名+原名」：" + rd.card.querySelector(".tool-name").textContent);
        }
        var rm = rd.meta.textContent;
        if (rm.indexOf("文件 D:\\a\\b.txt") < 0 || rm.indexOf("读 30 行") < 0) throw new Error("read 概要不对：" + rm);
        if (rd.start !== 20 || rd.pre._gut !== rd.gut) throw new Error("read 没把行号列接上（应从 20 行起）");
        if (!rd.pre.classList.contains("nowrap")) throw new Error("带行号的代码应该不折行");
        finishTool(rd, "第20行\n第21行", false);
        rd.body.hidden = false; hlApplyPre(rd.pre);
        if (rd.gut.textContent !== "20\n21") throw new Error("行号列不对：" + JSON.stringify(rd.gut.textContent));

        // 编辑：单栏 diff（删/增/留）+ 中文概要；英文结果套话也换中文
        var ed = toolCard(node, "c-edit2", "edit");
        setToolInput(ed, { path: "D:\\x.js", edits: [{ oldText: "aaaa\nbbbb\ncccc", newText: "aaaa\ncccc\ndddd" }] });
        var d = ed.meta.querySelector(".diff");
        if (!d) throw new Error("编辑没渲染 diff");
        var dels = d.querySelectorAll(".dline.del"), adds = d.querySelectorAll(".dline.add");
        if (dels.length !== 1 || adds.length !== 1) throw new Error("diff 行数不对：−" + dels.length + " +" + adds.length);
        if (dels[0].textContent.indexOf("bbbb") < 0) throw new Error("删除行内容不对：" + dels[0].textContent);
        if (adds[0].textContent.indexOf("dddd") < 0) throw new Error("新增行内容不对：" + adds[0].textContent);
        if (d.querySelectorAll(".dline.same").length !== 2) throw new Error("相同行不该被标成改动");
        if (ed.meta.textContent.indexOf("1 块编辑 +1 −1") < 0) throw new Error("编辑概要没给增删数：" + ed.meta.textContent);
        finishTool(ed, "Successfully replaced 1 block(s) in D:\\x.js.", false);
        ed.body.hidden = false; hlApplyPre(ed.pre);
        if (ed.pre.textContent !== "已在 D:\\x.js 替换 1 处") throw new Error("结果套话没换中文：" + ed.pre.textContent);
        if (ed.pre._lang !== "javascript") throw new Error("edit 结果的语言应沿用入参推断：" + ed.pre._lang);
        if (zhResult({ kind: "powershell" }, "Successfully replaced 1 block(s) in X.") !== "Successfully replaced 1 block(s) in X.") {
          throw new Error("命令输出被改写了，原文必须一个字不动");
        }
        if (zhResult({ kind: "read" }, "(no output)") !== "（无输出）") throw new Error("(no output) 没换中文");

        // 思考块：不传第二个参数就是默认展开，传 false 才收起。
        // （S.expandThinking 是用户自己的偏好，不应该是这条断言的因）
        if (thinkBlock("默认展开吗")._body.hidden) throw new Error("思考块默认应该是展开的");
        var tb = thinkBlock("先看 render 再改 CSS\n第二行", false);
        if (tb._body.textContent !== "先看 render 再改 CSS\n第二行") throw new Error("思考正文没保留换行");
        if (!tb._body.hidden) throw new Error("closed 的思考块应该是收起的");
        rpFire(tb.querySelector(".think-head"), "click");
        if (tb._body.hidden) throw new Error("点标题没展开思考块");
        if (tb.querySelector(".think-title").textContent !== "思考") throw new Error("思考块标题不是中文");
        var tb2 = thinkBlock("默认展开", true);
        if (tb2._body.hidden) throw new Error("默认展开的思考块是收起的");
        tb.remove(); tb2.remove();

        // 中文思考/回答靠给 pi 追加系统提示，开关存在 Rust 配置里（名称要对得上）。
        // 这里只验「出厂默认」：用户自己在设置里改过的话，有效值当然可以不是 true。
        return send("settings.get").then(function (c) {
          if (!c || !c.defaults) throw new Error("settings.get 没给 defaults");
          if (c.defaults.expandThinking !== true) throw new Error("defaults.expandThinking 默认值不对");
          if (c.defaults.zhReply !== true) throw new Error("defaults 里漏了 zhReply，重置按钮会一直是灰的");
          if (typeof c.expandThinking !== "boolean" || typeof c.zhReply !== "boolean") {
            throw new Error("有效值不是布尔：" + JSON.stringify({ e: c.expandThinking, z: c.zhReply }));
          }
          return out.join(" | ") + " | 偏好 思考展开=" + c.expandThinking + " 中文回答=" + c.zhReply;
        });
      } finally {
        host.remove();
      }
    });

    step("rp.tree-open", function () {
      rpFreshTabs();
      return loadTree(RP_PROJ).then(function () { return rpWait(150); }).then(function () {
        var row = rpTreeRow("Cargo.toml");
        if (!row) throw new Error("文件树里没有 Cargo.toml 行");
        rpFire(row, "click");
        return rpWait(700);
      }).then(function () {
        if ($("right-panel").hidden) throw new Error("点文件后面板没打开");
        var t = rpActive();
        if (!t || t.label !== "Cargo.toml") throw new Error("活动页签不对：" + (t && t.label));
        if (!t.loaded) throw new Error("页签没加载完");
        var body = $("rp-body").textContent;
        if (body.indexOf("[package]") < 0) throw new Error("正文里没有 Cargo.toml 的内容");
        if ($("rp-path").textContent.indexOf("Cargo.toml") < 0) throw new Error("工具条路径不对：" + $("rp-path").textContent);
        return "页签=" + t.label + " 行数=" + t.lines + " 面板宽=" + $("right-panel").offsetWidth;
      });
    });

    step("rp.md-modes", function () {
      // 路径从 skills.list 现取：写死的那个技能目录早就没了（技能现在装在 npm 包里，
      // agent 目录也可能被 PI_CODING_AGENT_DIR 迁到别的盘），写死必然假失败。
      return send("skills.list", { cwd: S.cwd || "" }).then(function (r) {
        var list = (r && r.skills) || [];
        var mdPath = "";
        for (var i = 0; i < list.length; i++) {
          if (/SKILL\.md$/i.test(list[i].path || "")) { mdPath = list[i].path; break; }
        }
        if (!mdPath) throw new Error("skills.list 里没有可打开的 SKILL.md");
        rpOpenFile(mdPath);
        return rpWait(800);
      }).then(function () {
        var t = rpActive();
        if (t.ckind !== "markdown") throw new Error("kind=" + t.ckind);
        var btns = $("rp-modes").querySelectorAll(".rp-mode");
        if (btns.length !== 2) throw new Error("模式按钮数=" + btns.length);
        if (btns[0].textContent !== "预览" || btns[1].textContent !== "源") {
          throw new Error("按钮文案=" + btns[0].textContent + "/" + btns[1].textContent);
        }
        if (!btns[0].classList.contains("on")) throw new Error("默认不是预览模式");
        if (!$("rp-body").querySelector(".rp-md")) throw new Error("预览没渲染成 markdown");
        rpFire(btns[1], "click");
        return rpWait(250);
      }).then(function () {
        if (!$("rp-body").querySelector(".rp-code")) throw new Error("切到源之后没有行号视图");
        return "markdown 预览/源 都通";
      });
    });

    function rpDrag(dx) {
      var rz = $("rp-resizer");
      var init = { button: 0, clientX: 1000, clientY: 300, pointerId: 1, isPrimary: true, bubbles: true, cancelable: true };
      rz.dispatchEvent(new PointerEvent("pointerdown", init));
      rz.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, init, { clientX: 1000 - dx })));
      rz.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, init, { clientX: 1000 - dx })));
    }

    step("rp.resize", function () {
      /* 拖条只在文档流（非浮层）档存在：真实窗口放不下「侧栏 + 面板 + 对话区」时面板按设计
         自动转浮层、拖条隐藏。这条用例验的是拖拽数学本身，所以先把视口打桩成「放得下」，
         否则结果会随窗口大小飘。 */
      var desc = Object.getOwnPropertyDescriptor(window, "innerWidth");
      Object.defineProperty(window, "innerWidth", { configurable: true, get: function () { return 1600; } });
      try {
        applyLayout(); rpApply();
        if ($("rp-resizer").hidden) throw new Error("1600px 视口下面板仍是浮层（拖条 hidden）");
        // 上一轮跑完会把宽度存进 localStorage 带到这一轮，可能就停在 MIN（夹到最小）——
        // 那样再往右拖就夹不动了。先往左拖宽，保证两个方向都还有空间。
        rpDrag(160);
        var w0 = RP.w;
        rpDrag(-160);
        var w1 = RP.w;
        if (!(w1 < w0)) throw new Error("往右拖没变窄：" + w0 + "→" + w1);
        rpDrag(120);
        if (!(RP.w > w1)) throw new Error("往左拖没变宽：" + w1 + "→" + RP.w);
        var saved = parseInt(localStorage.getItem("pi-rpanel-w") || "0", 10);
        if (saved !== RP.w) throw new Error("宽度没写 localStorage：" + saved + " vs " + RP.w);
        if (document.body.classList.contains("rp-resizing")) throw new Error("拖拽结束后 body 上还留着 rp-resizing");
        return "窄→宽：" + w0 + " → " + w1 + " → " + RP.w + "（localStorage=" + saved + "）";
      } finally {
        if (desc) Object.defineProperty(window, "innerWidth", desc); else delete window.innerWidth;
        applyLayout(); rpApply(); syncBackdrop();
      }
    });

    step("rp.close-reopen", function () {
      rpFire($("rp-close"), "click");
      if (!$("right-panel").hidden) throw new Error("点关闭后面板还在");
      rpFire($("btn-panel"), "click");
      if ($("right-panel").hidden) throw new Error("点顶栏按钮没重新打开");
      return "关闭/重开 OK，页签数=" + RP.tabs.length;
    });

    step("rp.closable", function () {
      /* 用户报的「最右侧窗口弹开后收不回去」：面板必须以顶栏为界（不能盖住顶栏），
         自己的 ✕ 必须点得到，且点完遮罩要跟着清 —— 三者缺一都会让人关不掉面板。 */
      var pan = $("right-panel"), back = $("rp-backdrop"), tb = document.querySelector(".topbar");
      var desc = Object.getOwnPropertyDescriptor(window, "innerWidth");
      var wasOpen = RP.open, wasW = RP.w, vw = 480, notes = [];
      Object.defineProperty(window, "innerWidth", { configurable: true, get: function () { return vw; } });
      try {
        RP.open = true; RP.w = 560; pan.hidden = false;
        applyLayout(); rpApply(); syncBackdrop();
        if (!pan.classList.contains("overlay")) throw new Error("480px 面板没进浮层档，场景没复现");
        var pr = pan.getBoundingClientRect(), tr = tb.getBoundingClientRect();
        if (pr.top < tr.bottom - 1) {
          throw new Error("浮层面板盖住顶栏：面板顶 " + Math.round(pr.top) + " < 顶栏底 " + Math.round(tr.bottom));
        }
        var cl = $("rp-close"), cr = cl.getBoundingClientRect();
        if (!cr.width || !cr.height) throw new Error("面板 ✕ 没有尺寸");
        /* 视口边界要用 documentElement.clientWidth：innerWidth 是本用例自己打桩的假值，
           不影响真实布局。 */
        var vpw = document.documentElement.clientWidth;
        if (cr.right > vpw + 1 || cr.left < 0) {
          throw new Error("面板 ✕ 被挤出视口：left=" + Math.round(cr.left) + " right=" + Math.round(cr.right) + " vpw=" + vpw);
        }
        var ch = document.elementFromPoint(Math.round(cr.left + cr.width / 2), Math.round(cr.top + cr.height / 2));
        if (!ch || !(ch === cl || cl.contains(ch))) {
          throw new Error("面板 ✕ 点不到（被盖住）：" + (ch ? (ch.id || ch.className) : "null"));
        }
        notes.push("480px 浮层：面板顶 " + Math.round(pr.top) + " ≥ 顶栏底 " + Math.round(tr.bottom) + "，✕ 可点");
        cl.click();
        if (RP.open || !pan.hidden) throw new Error("点面板 ✕ 没关掉面板");
        if (back.classList.contains("show")) throw new Error("面板关掉后遮罩还留着（界面等于卡死）");

        /* 同一套不变量在真实窗口宽度下再验一遍（此时可能是浮层，也可能是文档流） */
        if (desc) Object.defineProperty(window, "innerWidth", desc); else delete window.innerWidth;
        RP.w = wasW; rpShow();
        notes.push("实际 " + window.innerWidth + "px：" + (pan.classList.contains("overlay") ? "浮层" : "文档流"));
        if (pan.classList.contains("overlay")) {
          var pr2 = pan.getBoundingClientRect(), tr2 = tb.getBoundingClientRect();
          if (pr2.top < tr2.bottom - 1) throw new Error("实际窗口浮层面板盖住顶栏：" + Math.round(pr2.top) + " < " + Math.round(tr2.bottom));
        }
        var cr2 = cl.getBoundingClientRect();
        var ch2 = document.elementFromPoint(Math.round(cr2.left + cr2.width / 2), Math.round(cr2.top + cr2.height / 2));
        if (!ch2 || !(ch2 === cl || cl.contains(ch2))) throw new Error("实际窗口下面板 ✕ 点不到：" + (ch2 ? (ch2.id || ch2.className) : "null"));
        cl.click();
        if (RP.open || !pan.hidden) throw new Error("实际窗口下点 ✕ 没关掉面板");
        if (back.classList.contains("show")) throw new Error("实际窗口下关掉面板后遮罩还留着");
        notes.push("✕ 点击后面板收起、遮罩已清");
        return notes.join(" · ");
      } finally {
        if (desc) Object.defineProperty(window, "innerWidth", desc); else delete window.innerWidth;
        RP.w = wasW;
        if (wasOpen) rpShow(); else rpHide();
        applyLayout(); rpApply(); syncBackdrop();
      }
    });

    step("rp.persist", function () {
      var raw = localStorage.getItem("pi-rpanel-tabs");
      if (!raw) throw new Error("页签没落盘");
      var o = JSON.parse(raw);
      if (!o.tabs || o.tabs.length < 2) throw new Error("落盘的页签数不对：" + raw.slice(0, 120));
      var names = o.tabs.map(function (t) { return t.label; });
      if (names.indexOf("Cargo.toml") < 0) throw new Error("落盘里没有 Cargo.toml：" + names.join(","));
      return "落盘 " + o.tabs.length + " 个：" + names.join(",");
    });

    step("rp.image", function () {
      // 夹具自己写：临时目录会被清理，不能依赖磁盘上预留的图片
      var png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
      return send("fs.write", { dir: TMP_DIR, name: "selftest-rp.png", dataBase64: png1x1 })
        .then(function (r) {
          rpOpenFile(r.path);
          return rpWait(700);
        })
        .then(function () {
          var img = $("rp-body").querySelector("img");
          if (!img) throw new Error("图片页签没渲染出 img");
          if (img.src.indexOf("pi-file.local") < 0) throw new Error("图片没走 pi-file.local 协议：" + img.src);
          return "img.src=" + img.src.slice(0, 56) + "…";
        });
    });

    step("rp.binary", function () {
      rpOpenFile("D:\\缓存\\build\\pi-webview\\release\\pi-webview.exe");
      return rpWait(700).then(function () {
        var txt = $("rp-body").textContent;
        if (txt.indexOf("二进制文件") < 0) throw new Error("exe 没给二进制提示：" + txt.slice(0, 80));
        return txt.slice(0, 46);
      });
    });

    step("rp.web", function () {
      rpOpenUrl("https://pi.local/index.html?blank=1");
      return rpWait(400).then(function () {
        var f = $("rp-body").querySelector("iframe");
        if (!f) throw new Error("网页页签没渲染出 iframe");
        if (f.src.indexOf("pi.local") < 0) throw new Error("iframe src 不对：" + f.src);
        if ($("rp-body").textContent.indexOf("用系统浏览器打开") < 0) throw new Error("缺系统浏览器兜底按钮");
        return "iframe=" + f.src;
      });
    });

    step("rp.links", function () {
      // 正文里的链接必须在 document 上被拦下：否则 WebView 会自己导航过去，整个应用就变成浏览器了。
      // 注意：每次点击都会重渲染面板，上一次插进去的节点会被摘出文档，所以每次都得重新插。
      function linkBox() {
        var b = el("div", "body");
        b.innerHTML = '<a href="Cargo.toml" id="rp-a1">本地</a><a href="https://example.com/x" id="rp-a2">外链</a>';
        $("rp-body").appendChild(b);
        if (!b.isConnected) throw new Error("插进去的节点没接在文档上（#rp-body 不是真身？）");
        if (!b.querySelector('[id="rp-a2"]')) throw new Error("innerHTML 里的链接没建出来");
        return b;
      }
      var n0 = RP.tabs.length;
      var b1 = linkBox();
      var ev1 = rpFire(b1.querySelector('[id="rp-a2"]'), "click");
      if (!ev1.defaultPrevented) throw new Error("外链没被拦下（WebView 会自己导航走）");
      if (RP.tabs.length !== n0 + 1) throw new Error("外链没开成网页页签");
      var b2 = linkBox();
      var ev2 = rpFire(b2.querySelector('[id="rp-a1"]'), "click");
      if (!ev2.defaultPrevented) throw new Error("本地链接没被拦下");
      if (RP.tabs.length !== n0 + 2) {
        throw new Error("本地链接没开成文件页签：" + RP.tabs.map(function (t) { return t.label; }).join(","));
      }
      return "外链/本地链接都拦下并开了页签，共 " + RP.tabs.length + " 个";
    });

    /* 8.2.3：工具卡计时器不得泄漏 —— toolCard 起表、finishTool 摘表、endStream 兜底全停。
       历史 BUG：abort / 切会话后旧卡的 500ms setInterval 一直跑（白耗 CPU，还改已拆下的 DOM）。 */
    step("ui.tool.timer", function () {
      function w(ms) { return new Promise(function (r) { setTimeout(r, ms || 30); }); }
      stopLiveTools();
      if (LIVE_TOOLS.length) throw new Error("起始就有活卡：" + LIVE_TOOLS.length);
      function mkNode() { return { el: el("div", "msg assistant"), tools: {}, _live: null }; }
      var n1 = mkNode();
      var r1 = toolCard(n1, "st-timer-1", "read");
      if (!r1.timer) throw new Error("工具卡没起计时器");
      if (LIVE_TOOLS.length !== 1) throw new Error("造卡后 LIVE_TOOLS=" + LIVE_TOOLS.length);
      var t0 = r1.dur.textContent;
      return w(700).then(function () {
        if (r1.dur.textContent === t0) throw new Error("计时器没在走：" + t0);
        endStream(n1);                       // abort / 切会话走的就是它
        if (LIVE_TOOLS.length !== 0) throw new Error("endStream 后还有活卡：" + LIVE_TOOLS.length);
        var frozen = r1.dur.textContent;
        return w(1200).then(function () {
          if (r1.dur.textContent !== frozen) {
            throw new Error("endStream 后计时器还在改 DOM：" + frozen + " → " + r1.dur.textContent);
          }
          var n2 = mkNode();
          var r2 = toolCard(n2, "st-timer-2", "read");
          if (LIVE_TOOLS.length !== 1) throw new Error("第二次造卡 LIVE_TOOLS=" + LIVE_TOOLS.length);
          finishTool(r2, "ok", false);
          if (LIVE_TOOLS.length !== 0) throw new Error("finishTool 后还有活卡：" + LIVE_TOOLS.length);
          return "起表→走表→endStream 停表（1200ms 未再变）→finishTool 摘净";
        });
      });
    });

    /* 8.5：Enter = 立即引导，Alt+Enter = 排队后续消息，空闲 Enter = 普通发送。
       历史 BUG：Enter 直发 follow_up → 消息排在当前回合后面，表现为「插入的消息要等前面的问题做完才回答」。 */
    step("ui.composer.steer", function () {
      function w(ms) { return new Promise(function (r) { setTimeout(r, ms || 30); }); }
      var src = String(submit);
      if (src.indexOf("streamingBehavior") < 0) throw new Error("submit 没走 streamingBehavior");
      if (/type:\s*"steer"|type:\s*"follow_up"/.test(src)) throw new Error("submit 仍直发 steer/follow_up");
      var box = window.chrome && window.chrome.webview;
      var orig = box && box.postMessage;
      if (!orig) return "源码断言通过；无 WebView2 桥，跳过运行时断言";
      var seen = [];
      box.postMessage = function (m) { seen.push(m); };
      var ta = $("input");
      var keepVal = ta.value, keepStream = S.streaming, n0 = streamInner.children.length;
      function restore() {
        box.postMessage = orig;
        S.streaming = keepStream;
        ta.value = keepVal;
        while (streamInner.children.length > n0) streamInner.removeChild(streamInner.lastChild);
      }
      function lastPrompt() {
        for (var i = seen.length - 1; i >= 0; i--) {
          var a = seen[i].args;
          if (seen[i].verb === "pi.send" && a && a.type === "prompt") return a.params || {};
        }
        return null;
      }
      function key(alt) {
        ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: !!alt, bubbles: true, cancelable: true }));
      }
      function fail(msg) { restore(); throw new Error(msg); }
      S.streaming = true;
      ta.value = "st-enter";
      key(false);
      return w(40).then(function () {
        var p = lastPrompt();
        if (!p || p.message !== "st-enter") throw new Error("运行中 Enter 没发出 prompt：" + JSON.stringify(seen[seen.length - 1]));
        if (p.streamingBehavior !== "steer") throw new Error("运行中 Enter 应是 steer，实际 " + p.streamingBehavior);
        seen.length = 0;
        ta.value = "st-alt";
        key(true);
        return w(40);
      }).then(function () {
        var p = lastPrompt();
        if (!p || p.streamingBehavior !== "followUp") throw new Error("Alt+Enter 应是 followUp，实际 " + (p && p.streamingBehavior));
        seen.length = 0;
        S.streaming = false;
        ta.value = "st-idle";
        key(false);
        return w(40);
      }).then(function () {
        var p = lastPrompt();
        if (!p) throw new Error("空闲 Enter 没发出 prompt");
        if ("streamingBehavior" in p) throw new Error("空闲时不该带 streamingBehavior：" + p.streamingBehavior);
        seen.length = 0;
        S.streaming = true;
        ta.value = "st-follow";
        submit("follow");
        return w(40);
      }).then(function () {
        var p = lastPrompt();
        if (!p || p.streamingBehavior !== "followUp") throw new Error("「后续消息」按钮应是 followUp");
        seen.length = 0;
        ta.value = "st-steer";
        submit("steer");
        return w(40);
      }).then(function () {
        var p = lastPrompt();
        if (!p || p.streamingBehavior !== "steer") throw new Error("「引导」按钮应是 steer");
        restore();
        return "Enter→steer / Alt+Enter→followUp / 空闲→不带行为 / 两按钮各自正确";
      })["catch"](function (e) {
        fail(e && e.message ? e.message : String(e));
      });
    });

    step("rp.cleanup", function () {
      rpFreshTabs();
      return loadTree("~").then(function () { return "已清空页签，文件树回到 ~"; });
    });

    // 截图专用：只在「只跑匹配步骤」(selftest=3) 时挂上，整套跑不受影响。
    // 作用：直接用 openSession 打开演示会话并停住 12s，给外部截图脚本留时间（不依赖模拟点击）。
    if (only) {
      step("demo.shot", function () {
        var p = "C:\\Users\\Administrator\\.pi\\agent\\sessions\\--C--Users-Administrator--\\2026-09-21T12-00-00-000Z_aaaaaaaa-1111-2222-3333-444444444444.jsonl";
        if ($("session-list").textContent.indexOf("工具卡片排版演示") < 0) {
          throw new Error("演示会话不在列表里（先用 临时文件\\demo-session.ps1 生成）：" + p);
        }
        openSession(p);
        return rpWait(2500).then(function () {
          // 展开所有工具卡片，再分两段滚动：前 6s 停 edit 卡，后 6s 停最后一张卡。
          // 外部截图脚本只需按两次快门，不用模拟点击/滚轮（那个不可靠）。
          var heads = document.querySelectorAll("#stream-inner .tool-head");
          for (var i = 0; i < heads.length; i++) heads[i].click();
          var cards = document.querySelectorAll("#stream-inner .tool-card");
          if (cards[1] && cards[1].scrollIntoView) cards[1].scrollIntoView(true);
          return rpWait(6000).then(function () {
            var tail = cards[cards.length - 1];
            if (tail && tail.scrollIntoView) tail.scrollIntoView(true);
            return rpWait(6000).then(function () {
              return "演示会话已打开：卡片 " + heads.length + " 张，前 6s edit 视图 / 后 6s 末尾视图";
            });
          });
        });
      });
      /* 思考块 + 正文同时流式到达时的回归：验证
         1) 思考块和正文在同一个助手节点里，且都渲染出来了；
         2) 流式结束后 .md-live 包裹层已拆掉（unwrapEl 生效，DOM 与历史渲染一致）；
         3) 流式渲染出来的思考块事后仍然能点击展开。
         以前 appendText 里 node.body.innerHTML = md(buf) 会把思考块从 DOM 里抹掉。 */
      step("think.live", function () {
        if (S.streaming) throw new Error("上一个回合还没结束");
        var beforeAsst = document.querySelectorAll("#stream-inner .msg.assistant").length;
        $("input").value = "先默算 17 乘以 23 是多少（写出计算过程），最后一行只写结果数字";
        submit("prompt");
        return new Promise(function (res) {
          var t0 = Date.now();
          var iv = setInterval(function () {
            if (!S.streaming && document.querySelectorAll("#stream-inner .msg.assistant").length > beforeAsst) { clearInterval(iv); res(); }
            else if (Date.now() - t0 > 180000) { clearInterval(iv); res(); }
          }, 500);
        }).then(function () {
          var nodes = document.querySelectorAll("#stream-inner .msg.assistant");
          var last = nodes[nodes.length - 1];
          if (!last) throw new Error("没有助手节点");
          var t = last.querySelector(".think");
          var md = last.querySelector("p, pre, ul, ol");
          var leftover = document.querySelectorAll("#stream-inner .md-live").length;
          var txt = last.textContent.replace(/\s+/g, " ").slice(0, 60);
          if (leftover) throw new Error(".md-live 包裹层没拆干净，剩 " + leftover + " 个");
          if (!md) throw new Error("流式正文没渲染出块级内容：" + txt);
          if (!t) return "（本次没产生思考内容，跳过折叠检查）正文已渲染：" + txt;          var b = t.querySelector(".think-body");
          if (!b.textContent) throw new Error("思考块是空的");
          var h = t.querySelector(".think-head");
          var before = b.hidden;
          rpFire(h, "click");
          if (b.hidden === before) throw new Error("流式渲染出的思考块点击无效（事件丢失）");
          rpFire(h, "click");
          if (b.hidden !== before) throw new Error("思考块第二次点击没回到原状");
          return "思考块可折叠（" + b.textContent.length + " 字）· 正文已渲染 · 无 .md-live 残留 | " + txt;
        });
      }, 150000);

      /* 思考块回归：历史渲染的思考块必须还能点击展开/收起。
         以前 app.js 里 node.body.innerHTML = md(...) + node.body.innerHTML 把思考块
         序列化重排，事件监听全丢，点「展开」没反应。这里用合成事件守住。 */
      step("think.shot", function () {
        var p = "C:\\Users\\Administrator\\.pi\\agent\\sessions\\--C--Users-Administrator--\\2026-09-21T12-00-00-000Z_aaaaaaaa-1111-2222-3333-444444444444.jsonl";
        openSession(p);
        return rpWait(3000).then(function () {
          var t = document.querySelector("#stream-inner .think");
          if (!t) throw new Error("演示会话里没有 .think 块");
          var b = t.querySelector(".think-body");
          var h = t.querySelector(".think-head");
          var hint = t.querySelector(".think-hint");
          var before = b.hidden;
          rpFire(h, "click");
          var a1 = b.hidden, h1 = hint.textContent;
          rpFire(h, "click");
          var a2 = b.hidden, h2 = hint.textContent;
          if (a1 === before || a2 !== before) throw new Error("思考块点击没有正常切换：" + before + "→" + a1 + "→" + a2);
          if (a1 && h1 !== "点击展开") throw new Error("收起态提示文字不对：" + h1);
          if (!a1 && h1 !== "点击收起") throw new Error("展开态提示文字不对：" + h1);
          if (!b.textContent) throw new Error("思考块正文是空的");
          return "think 点击前 hidden=" + before + " → 一次后 " + a1 + "(" + h1 + ") → 两次后 " + a2 + "(" + h2 + ") 正常";
        });
      });
    }

    /* ---- 阶段七 7.3.3 / 7.4.5：响应式三档 + 长文排版 ---- */
    step("ui.layout.narrow", function () {
      var modes = [[1500, "desktop"], [1000, "desktop"], [900, "compact"], [700, "compact"], [600, "mobile"], [480, "mobile"]];
      modes.forEach(function (m) {
        if (layoutMode(m[0]) !== m[1]) throw new Error("断点档位不对：" + m[0] + "px 应为 " + m[1] + "，实际 " + layoutMode(m[0]));
      });
      var modeTxt = modes.map(function (m) { return m[0] + "=" + layoutMode(m[0]); }).join(" ");
      if (sbClamp(9999, 1000) > 1000 - LAY.CHAT_MIN) throw new Error("桌面档侧栏上限没给对话区留出 " + LAY.CHAT_MIN + "px：" + sbClamp(9999, 1000));
      if (sbClamp(1, 1500) !== LAY.SB_MIN) throw new Error("侧栏最小宽没夹住：" + sbClamp(1, 1500));

      // 窄窗：复现「拖到最左边变成窄窄一条」——侧栏必须自动收成抽屉、右面板必须走浮层
      var sbEl = $("sidebar"), pan = $("right-panel"), back = $("rp-backdrop");
      var wasCollapsed = sbEl.classList.contains("collapsed"), wasRP = RP.open, wasW = RP.w;
      var desc = Object.getOwnPropertyDescriptor(window, "innerWidth");
      var vw = 480, got = "";
      Object.defineProperty(window, "innerWidth", { configurable: true, get: function () { return vw; } });
      try {
        RP.open = true; RP.w = 560;
        applyLayout(); rpApply(); syncBackdrop();
        var pw0 = pan.style.getPropertyValue("--right-panel-width");
        got = "480px: 侧栏收起=" + sbEl.classList.contains("collapsed") + " 浮层=" + pan.classList.contains("overlay");
        if (!sbEl.classList.contains("collapsed")) throw new Error("480px 宽时侧栏没自动收成抽屉（就是那条窄条的根因）");
        if (!pan.classList.contains("overlay")) throw new Error("480px 宽时右面板没切成浮层");
        /* 抽屉收起但面板是浮层：遮罩必须显示（点它收面板）。
           这是修「窄条」后的新语义：窄屏只要面板浮着，就压一层遮罩。 */
        if (!back.classList.contains("show")) throw new Error("480px 右面板浮层时遮罩没出现");
        /* 浮层档宽度由 CSS 媒体查询决定（app.css 里 min(560px, calc(100vw - 40px))），
           JS 不该再写内联 --right-panel-width；内联值只能是之前桌面档留下的。 */
        if (/\d/.test(pw0) && !(parseFloat(pw0) > 0)) throw new Error("浮层档写了非法内联宽度：" + pw0);
        /* 点遮罩：收浮层面板，遮罩跟着消失 */
        back.click();
        if (RP.open) throw new Error("窄屏点遮罩没把浮层面板收起来");
        if (back.classList.contains("show")) throw new Error("面板收起后遮罩还留着");
        /* 抽屉与面板同时开：点遮罩先收抽屉（移动端优先），面板仍开 → 遮罩必须保留；
           再收面板，遮罩才该消失。 */
        RP.open = true; pan.hidden = false; sbEl.classList.remove("collapsed");
        applyLayout(); rpApply(); syncBackdrop();
        if (!back.classList.contains("show")) throw new Error("窄屏拉开抽屉时遮罩没出现");
        back.click();
        if (!sbEl.classList.contains("collapsed")) throw new Error("点遮罩没把抽屉收起来");
        if (!RP.open) throw new Error("点遮罩把面板也收了（应只收抽屉）");
        if (!back.classList.contains("show")) throw new Error("面板还开着遮罩却没了");
        rpHide();
        if (back.classList.contains("show")) throw new Error("面板收起后遮罩没消");
        /* 中档（640–959）：右面板浮层，也要遮罩 */
        vw = 900; RP.open = true;
        applyLayout(); rpApply(); syncBackdrop();
        if (!pan.classList.contains("overlay")) throw new Error("900px 宽右面板没切成浮层");
        if (!back.classList.contains("show")) throw new Error("中档右面板浮层时遮罩没出现");
        vw = 1500;
        applyLayout(); rpApply(); syncBackdrop();
        if (sbEl.classList.contains("collapsed")) throw new Error("回到 1500px 宽侧栏没自动展开");
        if (pan.classList.contains("overlay")) throw new Error("1500px 宽右面板不该是浮层");
        if (back.classList.contains("show")) throw new Error("1500px 宽遮罩不该显示");
        /* 桌面档：面板回归文档流，宽度写回内联变量且给对话区留够 LAY.CHAT_MIN */
        var pw = parseFloat(pan.style.getPropertyValue("--right-panel-width"));
        got += " · 1500px: 面板宽=" + pw + " 侧栏宽=" + sbEl.offsetWidth + " 对话区余=" + (1500 - sbEl.offsetWidth - pw);
        if (!(pw > 0 && pw <= RP.MAX)) throw new Error("桌面档面板宽度不合理：" + pw);
        if (1500 - sbEl.offsetWidth - pw < LAY.CHAT_MIN) throw new Error("桌面档没给对话区留够宽度：" + (1500 - sbEl.offsetWidth - pw));
      } finally {
        if (desc) Object.defineProperty(window, "innerWidth", desc); else delete window.innerWidth;
        RP.open = wasRP; RP.w = wasW;
        applyLayout();
        if (wasCollapsed) sbEl.classList.add("collapsed"); else sbEl.classList.remove("collapsed");
        rpApply(); syncBackdrop();
      }

      // 媒体查询那半边：CSS 视口改不了（打桩 innerWidth 只影响 JS），所以直接扫 CSSOM 规则文本
      var mrs = [];
      for (var i = 0; i < document.styleSheets.length; i++) {
        var rs = null;
        try { rs = document.styleSheets[i].cssRules; } catch (e) { continue; }
        if (!rs) continue;
        for (var j = 0; j < rs.length; j++) {
          var cond = rs[j].conditionText || (rs[j].media && rs[j].media.mediaText) || "";
          if (cond) mrs.push({ cond: cond.replace(/\s+/g, ""), text: rs[j].cssText || "" });
        }
      }
      if (!mrs.length) throw new Error("扫不到任何 @media 规则（CSSOM 不可读？）");
      function blockOf(c) {
        for (var k = 0; k < mrs.length; k++) if (mrs[k].cond === c) return mrs[k].text;
        return "";
      }
      var b640 = blockOf("(max-width:640px)"), b959 = blockOf("(max-width:959px)");
      if (!b640) throw new Error("缺 @media (max-width:640px) 块");
      if (!/\.sidebar\.collapsed[^{]*\{[^}]*translateX\(-100%\)/.test(b640)) throw new Error("窄屏侧栏抽屉收起规则缺失");
      if (!/\.sidebar[^{]*\{[^}]*position:\s*fixed/.test(b640)) throw new Error("窄屏侧栏不是 fixed 抽屉");
      if (!/\.stream-inner[^{]*\{[^}]*padding/.test(b640)) throw new Error("窄屏对话区没减内边距");
      if (!b959) throw new Error("缺 @media (max-width:959px) 块");
      if (!/\.rp-resizer[^{]*\{[^}]*display:\s*none/.test(b959)) throw new Error("紧凑档拖动条没隐藏");
      if (!/\.right-panel[^{]*\{[^}]*position:\s*fixed/.test(b959)) throw new Error("紧凑档右面板不是浮层");
      var chatW = Math.round(streamInner.getBoundingClientRect().width);
      if (chatW < 200) throw new Error("对话区被挤没了：" + chatW + "px");
      return modeTxt + " | " + got + " | CSS 640/959 断点齐 | 当前对话区 " + chatW + "px";
    });

    step("ui.md.rich", function () {
      var src = ["# 一级标题", "## 二级标题", "### 三级标题", "", "正文段落一。", "", "1. 第一项", "2. 第二项", "", "- 无序甲", "- 无序乙", "", "> 引用一行", "", "---", "", "| 列A | 列B |", "| --- | ---: |", "| 1 | 2 |", "", "[链接](https://example.com) 与 ~~删除~~ 与 `code`"].join("\n");
      var html = md(src);
      var need = ["<h1>", "<h2>", "<h3>", "<ol>", "<ul>", "<blockquote>", "<hr>", 'class="md-table-wrap"', 'href="https://example.com"', "<del>", "<code>"];
      need.forEach(function (t) {
        if (html.indexOf(t) < 0) throw new Error("md() 输出缺 " + t);
      });
      // 7.4.3：用量行改成小表格，但外层 .usage-line 必须留着（报告的 usageLines 计数靠它）
      var card = el("div", "msg assistant"), uNode = { el: card };
      usageLine(uNode, { input: 1234, output: 56, cacheRead: 78900 });
      var tbl = card.querySelector(".usage-line .usage-tbl");
      if (!tbl) throw new Error("用量行没渲染成 .usage-line > .usage-tbl 表格");
      var tds = tbl.querySelectorAll("td").length, ths = tbl.querySelectorAll("th").length;
      if (tds !== 3 || ths !== 3) throw new Error("用量表行列不对：th=" + ths + " td=" + tds);
      // 7.4.4：真挂进消息宿主量计算样式
      var host = el("div", "msg assistant"), bodyEl = el("div", "body user-selectable");
      bodyEl.innerHTML = html;
      host.appendChild(bodyEl);
      streamInner.appendChild(host);
      var base = 0, h1 = 0, h2 = 0, h3 = 0, wrapOv = "", bqW = 0, got = "";
      try {
        function fs(sel) { var n = bodyEl.querySelector(sel); return n ? parseFloat(getComputedStyle(n).fontSize) : 0; }
        base = parseFloat(getComputedStyle(bodyEl).fontSize);
        h1 = fs("h1"); h2 = fs("h2"); h3 = fs("h3");
        if (!(h1 > h2 && h2 > h3 && h3 >= base)) throw new Error("标题字号没分层：h1=" + h1 + " h2=" + h2 + " h3=" + h3 + " 正文=" + base);
        var wrap = bodyEl.querySelector(".md-table-wrap");
        wrapOv = getComputedStyle(wrap).overflowX;
        if (wrapOv !== "auto") throw new Error("宽表格容器不能横向滚动：" + wrapOv);
        bqW = parseFloat(getComputedStyle(bodyEl.querySelector("blockquote")).borderLeftWidth);
        if (!(bqW > 0)) throw new Error("引用块没有左侧色条");
        got = "标题 " + h1 + "/" + h2 + "/" + h3 + "px（正文 " + base + "）· 表格 overflow-x=" + wrapOv + " · 引用色条 " + bqW + "px";
      } finally {
        if (host.parentNode) host.parentNode.removeChild(host);
      }
      // 状态栏 ANSI 剥离（用户截图里那条 [38;2;102;102;102mLSP Inactive[39m）
      var dirty = "\u001b[38;2;102;102;102mLSP Inactive\u001b[39m · \u001b[0mok";
      var clean = stripAnsi(dirty);
      if (clean.indexOf("\u001b") >= 0) throw new Error("ANSI 没剥干净：" + JSON.stringify(clean));
      if (clean !== "LSP Inactive · ok") throw new Error("ANSI 剥离结果不对：" + JSON.stringify(clean));
      return "md 富文本 " + need.length + " 项齐 · 用量表 3 列 · " + got + " · ANSI→" + JSON.stringify(clean);
    });

    var chain = Promise.resolve();
    steps.forEach(function (s) { chain = chain.then(s); });
    chain.then(function () {
      report.ms = Date.now() - report.t0;
      report.stage = "done";
      return send("app.report", report);
    }).then(function (r) {
      console.log("[selftest] 报告已写入 " + r.written + " ok=" + report.ok);
    });
  }

  /* ================= 真实对话自检（?selftest=2） ================= */
  function runLiveTest() {
    var report = { _kind: "livetest", ok: false, stage: "start", events: [], reply: "", tools: [] };
    var evCount = 0, toolNames = [], other = [];
    on("pi.event", function (ev) {
      evCount++;
      if (report.events.length < 200) report.events.push(ev.type);
      if (ev.type === "tool_execution_start") toolNames.push(ev.toolName);
    });
    on("pi.stderr", function (d) { if (other.length < 40) other.push("STDERR " + String(d.line).slice(0, 200)); });
    on("pi.exit", function (d) { other.push("EXIT " + JSON.stringify(d)); });
    on("pi.parse_error", function (d) { other.push("PARSE " + JSON.stringify(d).slice(0, 300)); });
    on("error", function (d) { other.push("ERROR " + JSON.stringify(d).slice(0, 300)); });
    var sendResult = null;
    var t0 = Date.now();
    S.streaming = true;
    updateRunState();
    send("pi.send", { type: "prompt", params: { message: "只回答两个字：收到" } })
      .then(function (r) {
        sendResult = JSON.stringify(r);
        return send("pi.status");
      })
      .then(function (st) {
        other.push("PI_STATUS " + JSON.stringify(st));
        return new Promise(function (resolve) {
          var iv = setInterval(function () {
            if (!S.streaming && evCount > 0) { clearInterval(iv); resolve(); }
            if (Date.now() - t0 > 90000) { clearInterval(iv); resolve(); }
          }, 400);
          setTimeout(function () { clearInterval(iv); resolve(); }, 95000);
        });
      })
      .then(function () {
        var dom = document.querySelector("#stream-inner");
        var domText = (dom || {}).textContent || "";
        report.elapsedMs = Date.now() - t0;
        report.sendResult = sendResult;
        report.diagnostics = other;
        report.eventCount = evCount;
        report.uniqueEvents = Array.from(new Set(report.events));
        report.tools = toolNames;
        report.userRendered = document.querySelectorAll("#stream-inner .msg.user").length;
        report.assistantRendered = document.querySelectorAll("#stream-inner .msg.assistant").length;
        report.toolCards = document.querySelectorAll("#stream-inner .tool-card").length;
        report.usageLines = document.querySelectorAll("#stream-inner .usage-line").length;
        report.domChars = domText.length;
        report.domTail = domText.slice(-400);
        report.meter = { in: $("m-in").textContent, out: $("m-out").textContent, pct: $("m-pct").textContent };
        report.ok = report.assistantRendered > 0 && report.domChars > 0;
        report.stage = "done";
        return send("app.report", report);
      })
      .catch(function (e) {
        report.error = String(e && e.message || e);
        report.stage = "error";
        return send("app.report", report);
      });
  }
  // 只暴露入口：app.js 用 api.run(only) / api.live() 调
  return { run: runSelfTest, live: runLiveTest };
};
