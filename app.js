/**
 * 剪切板插件 UI 逻辑
 * - 打开后在前台轮询系统剪贴板，记录文本/图片历史
 * - 历史与常用文字持久化到本地 JSON（preload.services）
 * - 支持搜索、分组、复制回剪贴板、删除，并可切换浅色/深色/跟随系统主题
 */
(function () {
  "use strict";

  var z = window.ztools || {};
  var services = window.services || {};
  var core = window.ClipboardCore || (services.core || null);

  var state = core ? core.normalizeState(null) : { history: [], snippets: [], groups: [{ id: "g-default", name: "默认", ts: 0 }], settings: { maxHistory: 500, maxImages: 12, keepImages: false } };
  var currentGroup = "g-default";
  var query = "";
  var editingId = null;
  var lastSig = "";
  var pollTimer = null;
  var toastTimer = null;
  var activeId = null;

  var el = {};

  function $(id) { return document.getElementById(id); }

  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg || "";
    el.toast.className = "show";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.className = ""; }, 1400);
  }

  var THEME_KEY = "clipboard-theme";
  var currentTheme = "system";

  function preferredDark() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); } catch (_) { return false; }
  }

  function resolveTheme(theme) {
    if (theme === "light" || theme === "dark") return theme;
    return preferredDark() ? "dark" : "light";
  }

  function paintTheme(theme) {
    document.documentElement.setAttribute("data-theme", resolveTheme(theme));
    var buttons = document.querySelectorAll(".theme-btn");
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var on = b.getAttribute("data-theme") === theme;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function applyTheme(theme) {
    currentTheme = theme === "light" || theme === "dark" ? theme : "system";
    try { localStorage.setItem(THEME_KEY, currentTheme); } catch (_) {}
    paintTheme(currentTheme);
  }

  function initTheme() {
    var saved = "system";
    try { saved = localStorage.getItem(THEME_KEY) || "system"; } catch (_) {}
    currentTheme = saved === "light" || saved === "dark" ? saved : "system";
    paintTheme(currentTheme);
    try {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () { if (currentTheme === "system") paintTheme(currentTheme); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (_) {}
  }

  function loadState() {
    if (!services.load) return;
    var res = services.load();
    if (res && res.state && core) state = core.normalizeState(res.state);
    if (!state.groups.some(function (g) { return g && g.id === currentGroup; })) currentGroup = "g-default";
    scheduleSnippetSync();
  }

  function getZDb() {
    try {
      if (z && z.db && z.db.promises) return z.db.promises;
      if (z && z.db) return z.db;
    } catch (_) {}
    return null;
  }

  var lastSyncedSnippetIds = null;
  var snippetSyncQueue = Promise.resolve();

  function toArray(res) {
    if (!res) return [];
    if (Array.isArray(res)) return res;
    if (Array.isArray(res.rows)) return res.rows.map(function (r) { return r && (r.doc || r.value || r) || r; }).filter(Boolean);
    if (Array.isArray(res.docs)) return res.docs;
    return [];
  }

  function syncStateChanged(a, b) {
    return JSON.stringify(a && a.snippets) !== JSON.stringify(b && b.snippets) ||
      JSON.stringify((a && a.settings && a.settings.deleted) || {}) !== JSON.stringify((b && b.settings && b.settings.deleted) || {});
  }

  function putDoc(db, doc, id) {
    return Promise.resolve().then(function () { return db.put(doc); }).catch(function () {
      return Promise.resolve(db.get ? db.get(id) : null).then(function (cur) {
        var next = Object.assign({}, doc);
        if (cur && cur._rev) next._rev = cur._rev;
        return db.put(next);
      }).catch(function () {});
    });
  }

  function removeDoc(db, doc, id) {
    if (doc && doc._rev) {
      return Promise.resolve().then(function () { return db.remove(doc); }).catch(function () {});
    }
    return Promise.resolve(db.get ? db.get(id) : null).then(function (cur) {
      if (cur && cur._rev) return db.remove(cur);
      return db.remove(id);
    }).catch(function () {});
  }

  /**
   * 把常用文字同步到 ZTools「我的数据」。
   * 本地 JSON 与库中记录冲突时，统一由 core.resolveSyncConflict 按最新时间戳取最新记录，
   * 库中更新的记录会回填到本地，本地删除的记录会写入删除标记并从库中移除。
   */
  function syncSnippetsToMyData(snapshot) {
    var db = getZDb();
    if (!db || !db.allDocs || !db.put || !db.remove || !core || !core.resolveSyncConflict) return Promise.resolve();
    var st = snapshot || state;

    return Promise.resolve().then(function () {
      return db.allDocs("snippet/");
    }).then(function (res) {
      var merged = core.resolveSyncConflict(st, toArray(res));
      if (syncStateChanged(st, merged.state)) {
        state = merged.state;
        if (services.save) services.save(state);
        render();
      }
      lastSyncedSnippetIds = merged.state.snippets.map(function (s) { return s.id; });

      var ops = merged.dbOps.map(function (op) {
        if (!op || !op.op) return Promise.resolve();
        if (op.op === "remove") return removeDoc(db, op.doc, op.id);
        return putDoc(db, op.doc, op.id);
      });
      return Promise.all(ops);
    }).catch(function () {});
  }

  function scheduleSnippetSync() {
    var snapshot = core ? core.normalizeState(state) : state;
    snippetSyncQueue = snippetSyncQueue.then(function () { return syncSnippetsToMyData(snapshot); }).catch(function () {});
  }

  function saveState() {
    if (services.save) services.save(state);
    scheduleSnippetSync();
  }

  function textSig(text) { return "t:" + String(text || "").length + ":" + String(text || "").slice(0, 200); }

  function captureClipboard() {
    if (!services.readClipboard || !core) return;
    var res = services.readClipboard();
    if (!res || !res.ok) return;
    if (res.kind === "text") {
      var sig = textSig(res.text);
      if (sig === lastSig) return;
      lastSig = sig;
      state = core.addTextHistory(state, res.text);
      saveState();
      render();
      return;
    }
    if (res.kind === "image" && state.settings.keepImages !== false) {
      var img = res.image || {};
      var isig = "i:" + (img.sig || String((img.dataUrl || "").length));
      if (isig === lastSig) return;
      lastSig = isig;
      state = core.addImageHistory(state, img);
      saveState();
      render();
    }
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(captureClipboard, 800);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function applyCopiedHistory(item) {
    if (!item) return false;
    var ok = false;
    if (item.type === "text") {
      ok = services.writeText && services.writeText(item.text).ok;
      lastSig = textSig(item.text);
    } else if (item.type === "image") {
      ok = services.writeImage && services.writeImage(item.dataUrl).ok;
      lastSig = "i:" + (item.sig || String((item.dataUrl || "").length));
    }
    if (core) state = core.touchHistory(state, item.id);
    activeId = item.id;
    saveState();
    render();
    return ok;
  }

  function copyHistory(item) {
    var ok = applyCopiedHistory(item);
    toast(ok ? "已复制到剪贴板" : "复制失败");
  }

  function pasteHistory(item) {
    if (!item) return;
    var ok = applyCopiedHistory(item);
    if (!ok) { toast("复制失败，无法粘贴"); return; }
    if (item.type === "image" && typeof z.hideMainWindowPasteImage === "function") {
      try { z.hideMainWindowPasteImage(item.dataUrl || item.thumb || ""); } catch (_) {}
      return;
    }
    if (item.type === "text" && typeof z.hideMainWindowPasteText === "function") {
      try { z.hideMainWindowPasteText(item.text || ""); } catch (_) {}
      return;
    }
    if (typeof z.hideMainWindow === "function") {
      try { z.hideMainWindow(true); } catch (_) {}
      toast("已复制，请在目标窗口粘贴");
      return;
    }
    toast("已复制到剪贴板");
  }

  function applyCopiedSnippet(item) {
    if (!item) return false;
    var ok = services.writeText && services.writeText(item.text).ok;
    lastSig = textSig(item.text);
    return ok;
  }

  function copySnippet(item) {
    var ok = applyCopiedSnippet(item);
    toast(ok ? "已复制到剪贴板" : "复制失败");
  }

  function pasteSnippet(item) {
    if (!item) return;
    var ok = applyCopiedSnippet(item);
    if (!ok) { toast("复制失败，无法粘贴"); return; }
    if (typeof z.hideMainWindowPasteText === "function") {
      try { z.hideMainWindowPasteText(item.text || ""); } catch (_) {}
      return;
    }
    if (typeof z.hideMainWindow === "function") {
      try { z.hideMainWindow(true); } catch (_) {}
      toast("已复制，请在目标窗口粘贴");
      return;
    }
    toast("已复制到剪贴板");
  }

  function fmtTime(ts) {
    if (!ts) return "";
    try {
      var d = new Date(ts);
      var h = String(d.getHours()).padStart(2, "0");
      var m = String(d.getMinutes()).padStart(2, "0");
      var mm = String(d.getMonth() + 1).padStart(2, "0");
      var dd = String(d.getDate()).padStart(2, "0");
      return mm + "-" + dd + " " + h + ":" + m;
    } catch (_) { return ""; }
  }

  function previewItem(item) {
    if (!item) { el.previewContent.textContent = "悬浮任意记录显示预览"; return; }
    if (item.type === "image") {
      el.previewContent.textContent = "图片 " + (item.w || 0) + "×" + (item.h || 0) + "  " + fmtTime(item.ts);
      return;
    }
    var t = String(item.text || "");
    el.previewContent.textContent = t.length > 2000 ? t.slice(0, 2000) + "\n…" : t;
  }

  function renderHistory() {
    var items = core ? core.filterHistory(state, query) : (state.history || []);
    el.historyCount.textContent = items.length ? String(items.length) + " 条" : "";
    el.historyList.textContent = "";
    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = query ? "没有匹配的历史记录" : "暂无记录，复制一些内容后会自动出现在这里";
      el.historyList.appendChild(empty);
      return;
    }
    var limit = Math.min(items.length, 200);
    for (var i = 0; i < limit; i++) {
      (function (item, idx) {
        var div = document.createElement("div");
        div.className = "item history-item" + (item.id === activeId ? " active" : "");
        var badge = document.createElement("span");
        badge.className = "idx";
        badge.textContent = idx < 9 ? String(idx + 1) : "·";
        div.appendChild(badge);
        if (item.type === "image") {
          var img = document.createElement("img");
          img.className = "thumb";
          img.src = item.thumb || item.dataUrl || "";
          img.alt = "image";
          div.appendChild(img);
        } else {
          var text = document.createElement("div");
          text.className = "text";
          text.textContent = String(item.text || "");
          div.appendChild(text);
        }
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.innerHTML = "<span>" + (item.type === "image" ? "图片" : "文本") + "</span><span>" + fmtTime(item.ts) + "</span>";
        div.appendChild(meta);
        var del = document.createElement("button");
        del.className = "del";
        del.type = "button";
        del.title = "删除";
        del.textContent = "×";
        del.addEventListener("click", function (e) {
          e.stopPropagation();
          state = core.deleteHistory(state, item.id);
          saveState(); render();
        });
        div.appendChild(del);
        var clickTimer = null;
        div.addEventListener("click", function () {
          clearTimeout(clickTimer);
          clickTimer = setTimeout(function () { copyHistory(item); }, 240);
        });
        div.addEventListener("dblclick", function (e) {
          e.stopPropagation();
          clearTimeout(clickTimer);
          pasteHistory(item);
        });
        div.addEventListener("mouseenter", function () { previewItem(item); });
        div.addEventListener("mouseleave", function () { previewItem(null); });
        div.title = item.type === "text" ? "单击复制，双击粘贴到上次光标位置" : "单击复制，双击粘贴到上次光标位置";
        el.historyList.appendChild(div);
      })(items[i], i);
    }
  }

  var addingGroup = false;
  var renamingGroupId = null;

  function renderGroups() {
    el.groupChips.textContent = "";
    var groups = state.groups || [{ id: "g-default", name: "默认", ts: 0 }];
    groups.forEach(function (g) {
      if (!g) return;
      var chip = document.createElement("span");
      chip.className = "chip group-chip" + (g.id === currentGroup ? " active" : "");

      if (renamingGroupId === g.id) {
        chip.classList.add("editing");
        var input = document.createElement("input");
        input.type = "text";
        input.className = "chip-input";
        input.value = g.name || "";
        var done = false;
        function commitRename(save) {
          if (done) return;
          done = true;
          var name = input.value || "";
          renamingGroupId = null;
          if (save && name.trim() && core.renameGroup) {
            state = core.renameGroup(state, g.id, name);
            saveState();
          }
          renderGroups(); renderSnippets();
        }
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); commitRename(true); }
          else if (e.key === "Escape") { e.preventDefault(); commitRename(false); }
          e.stopPropagation();
        });
        input.addEventListener("blur", function () { commitRename(true); });
        input.addEventListener("click", function (e) { e.stopPropagation(); });
        input.addEventListener("dblclick", function (e) { e.stopPropagation(); });
        chip.appendChild(input);
        el.groupChips.appendChild(chip);
        setTimeout(function () { try { input.focus(); input.select(); } catch (_) {} }, 0);
        return;
      }

      var label = document.createElement("span");
      label.className = "chip-label";
      label.textContent = g.name || "默认";
      chip.title = "单击切换，双击修改名称";
      chip.appendChild(label);

      if (g.id !== "g-default") {
        var del = document.createElement("button");
        del.type = "button";
        del.className = "chip-del";
        del.title = "删除分组";
        del.textContent = "×";
        del.addEventListener("click", function (e) {
          e.stopPropagation();
          state = core.deleteGroup(state, g.id);
          if (currentGroup === g.id) currentGroup = "g-default";
          saveState();
          renderGroups(); renderSnippets();
        });
        chip.appendChild(del);
      }

      chip.addEventListener("click", function () { currentGroup = g.id; renderSnippets(); renderGroups(); });
      chip.addEventListener("dblclick", function (e) {
        e.stopPropagation();
        renamingGroupId = g.id;
        renderGroups();
      });
      el.groupChips.appendChild(chip);
    });

    if (addingGroup) {
      var wrap = document.createElement("span");
      wrap.className = "chip add editing";
      var addInput = document.createElement("input");
      addInput.type = "text";
      addInput.className = "chip-input";
      addInput.placeholder = "分组名";
      var addDone = false;
      function commitAdd(save) {
        if (addDone) return;
        addDone = true;
        var name = addInput.value || "";
        addingGroup = false;
        if (save && name.trim()) {
          var res = core.addGroup(state, name);
          state = res.state;
          if (res.id) currentGroup = res.id;
          saveState();
        }
        renderGroups(); renderSnippets();
      }
      addInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); commitAdd(true); }
        else if (e.key === "Escape") { e.preventDefault(); commitAdd(false); }
        e.stopPropagation();
      });
      addInput.addEventListener("blur", function () { commitAdd(true); });
      addInput.addEventListener("click", function (e) { e.stopPropagation(); });
      addInput.addEventListener("dblclick", function (e) { e.stopPropagation(); });
      wrap.appendChild(addInput);
      el.groupChips.appendChild(wrap);
      setTimeout(function () { try { addInput.focus(); } catch (_) {} }, 0);
    } else {
      var add = document.createElement("span");
      add.className = "chip add";
      add.textContent = "+ 分组";
      add.title = "新增分组";
      add.addEventListener("click", function (e) { e.stopPropagation(); addingGroup = true; renderGroups(); });
      el.groupChips.appendChild(add);
    }
  }

  function renderSnippets() {
    var items = core ? core.filterSnippets(state, currentGroup, query) : (state.snippets || []);
    el.snippetList.textContent = "";
    if (!items.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = query ? "没有匹配的常用文字" : "该分组暂无常用文字";
      el.snippetList.appendChild(empty);
      return;
    }
    items.forEach(function (s) {
      if (!s) return;
      var div = document.createElement("div");
      div.className = "item snippet-item";
      if (s.tag) {
        var tag = document.createElement("div");
        tag.className = "tag";
        tag.textContent = s.tag;
        div.appendChild(tag);
      }
      var text = document.createElement("div");
      text.className = "text";
      text.textContent = String(s.text || "");
      div.appendChild(text);
      var actions = document.createElement("div");
      actions.className = "item-actions";
      var editBtn = document.createElement("button");
      editBtn.className = "mini-btn";
      editBtn.type = "button";
      editBtn.title = "编辑";
      editBtn.textContent = "✎";
      editBtn.addEventListener("click", function (e) { e.stopPropagation(); openEditor(s); });
      var del = document.createElement("button");
      del.className = "mini-btn danger";
      del.type = "button";
      del.title = "删除";
      del.textContent = "×";
      del.addEventListener("click", function (e) {
        e.stopPropagation();
        state = core.deleteSnippet(state, s.id);
        saveState(); renderSnippets();
      });
      actions.appendChild(editBtn);
      actions.appendChild(del);
      div.appendChild(actions);
      var clickTimer = null;
      div.addEventListener("click", function () {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(function () { copySnippet(s); }, 240);
      });
      div.addEventListener("dblclick", function (e) {
        e.stopPropagation();
        clearTimeout(clickTimer);
        pasteSnippet(s);
      });
      div.addEventListener("mouseenter", function () { previewItem({ type: "text", text: s.text, ts: s.updatedAt || s.ts }); });
      div.addEventListener("mouseleave", function () { previewItem(null); });
      div.title = "单击复制，双击粘贴到上次光标位置";
      el.snippetList.appendChild(div);
    });
  }

  function render() { renderHistory(); renderGroups(); renderSnippets(); }

  function openEditor(snippet) {
    editingId = snippet ? snippet.id : null;
    el.editorTitle.textContent = snippet ? "编辑常用文字" : "添加常用文字";
    el.editorGroup.textContent = "";
    (state.groups || []).forEach(function (g) {
      if (!g) return;
      var opt = document.createElement("option");
      opt.value = g.id; opt.textContent = g.name || g.id;
      el.editorGroup.appendChild(opt);
    });
    el.editorGroup.value = snippet ? (snippet.groupId || currentGroup) : currentGroup;
    el.editorTag.value = snippet ? (snippet.tag || "") : "";
    el.editorText.value = snippet ? (snippet.text || "") : "";
    el.snippetEditor.classList.remove("hidden");
    setTimeout(function () { el.editorText.focus(); }, 0);
  }

  function closeEditor() { editingId = null; el.snippetEditor.classList.add("hidden"); }

  function saveEditor() {
    var gid = el.editorGroup.value || "g-default";
    var tag = el.editorTag.value || "";
    var text = el.editorText.value || "";
    if (!text.trim()) { toast("内容不能为空"); return; }
    if (editingId) {
      state = core.updateSnippet(state, editingId, gid, tag, text);
      toast("已更新");
    } else {
      state = core.addSnippet(state, gid, tag, text);
      toast("已添加");
    }
    saveState();
    closeEditor();
    currentGroup = gid;
    render();
  }

  function bindEvents() {
    var themeBtns = document.querySelectorAll(".theme-btn");
    for (var i = 0; i < themeBtns.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () { applyTheme(btn.getAttribute("data-theme")); });
      })(themeBtns[i]);
    }
    el.btnAddSnippet.addEventListener("click", function () { openEditor(null); });
    el.editorClose.addEventListener("click", closeEditor);
    el.editorCancel.addEventListener("click", closeEditor);
    el.editorSave.addEventListener("click", saveEditor);
    el.snippetEditor.addEventListener("click", function (e) { if (e.target === el.snippetEditor) closeEditor(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !el.snippetEditor.classList.contains("hidden")) closeEditor();
    });
  }

  function initSplitter() {
    var dragging = false;
    var startX = 0, startLeft = 0;
    el.splitter.addEventListener("mousedown", function (e) {
      dragging = true; startX = e.clientX; startLeft = el.left.getBoundingClientRect().width;
      document.body.style.userSelect = "none"; e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var total = el.panels.getBoundingClientRect().width;
      var w = Math.max(180, Math.min(total - 180, startLeft + (e.clientX - startX)));
      el.left.style.flex = "0 0 " + w + "px";
    });
    window.addEventListener("mouseup", function () { if (dragging) { dragging = false; document.body.style.userSelect = ""; } });
  }

  function readEnterQuery(action) {
    if (!action || typeof action !== "object") return "";
    var t = action.payload != null ? action.payload : action.text;
    return typeof t === "string" ? t : (t == null ? "" : String(t));
  }

  function initHost() {
    try { if (typeof z.setExpendHeight === "function") z.setExpendHeight(560); } catch (_) {}
    if (typeof z.onPluginEnter === "function") {
      z.onPluginEnter(function (action) {
        loadState();
        query = readEnterQuery(action);
        render();
        captureClipboard(true);
        startPolling();
      });
    }
    if (typeof z.onPluginOut === "function") {
      z.onPluginOut(function () { stopPolling(); saveState(); });
    }
    if (typeof z.setSubInput === "function") {
      try {
        z.setSubInput(function (details) {
          var text = "";
          if (details && typeof details === "object") text = details.text != null ? details.text : "";
          else if (typeof details === "string") text = details;
          query = String(text || "");
          render();
        }, "搜索剪切板历史与常用文字...", true);
      } catch (_) {}
    }
  }

  function boot() {
    el.titlebar = $("titlebar");
    el.panels = $("panels");
    el.left = $("left");
    el.right = $("right");
    el.splitter = $("splitter");
    el.historyCount = $("history-count");
    el.historyList = $("history-list");
    el.groupChips = $("group-chips");
    el.snippetList = $("snippet-list");
    el.btnAddSnippet = $("btn-add-snippet");
    el.preview = $("preview");
    el.previewContent = $("preview-content");
    el.snippetEditor = $("snippet-editor");
    el.editorTitle = $("editor-title");
    el.editorClose = $("editor-close");
    el.editorGroup = $("editor-group");
    el.editorTag = $("editor-tag");
    el.editorText = $("editor-text");
    el.editorCancel = $("editor-cancel");
    el.editorSave = $("editor-save");
    el.toast = $("toast");

    if (!core) {
      if (el.historyList) el.historyList.innerHTML = '<div class="empty">核心模块未加载</div>';
      return;
    }
    if (!services.readClipboard) {
      toast("剪贴板能力不可用（请在 ZTools 插件环境中运行）");
    }

    initTheme();
    loadState();
    render();
    bindEvents();
    initSplitter();
    initHost();
    captureClipboard(true);
    startPolling();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
