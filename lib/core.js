/**
 * 剪切板插件核心逻辑（纯函数），浏览器与 Node 共用。
 * - 历史去重/合并、分组与常用文字的基础操作
 * - 不访问文件系统、不依赖宿主 API
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_HISTORY = 500;
  var MAX_IMAGES = 12;

  function now() { return Date.now(); }

  function uid() {
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function defaultGroups() {
    return [{ id: "g-default", name: "默认", ts: 0 }];
  }

  function normalizeState(raw) {
    var s = raw && typeof raw === "object" ? raw : {};
    var groups = Array.isArray(s.groups) && s.groups.length ? s.groups.slice() : defaultGroups();
    if (!groups.some(function (g) { return g && g.id === "g-default"; })) {
      groups.unshift({ id: "g-default", name: "默认", ts: 0 });
    }
    return {
      history: Array.isArray(s.history) ? s.history.slice() : [],
      snippets: Array.isArray(s.snippets) ? s.snippets.slice() : [],
      groups: groups,
      settings: {
        maxHistory: Math.max(50, Number((s.settings && s.settings.maxHistory) || MAX_HISTORY) || MAX_HISTORY),
        maxImages: Math.max(0, Number((s.settings && s.settings.maxImages) || MAX_IMAGES) || MAX_IMAGES),
        keepImages: s.settings ? s.settings.keepImages !== false : false
      }
    };
  }

  function pruneImages(history, maxImages) {
    var count = 0;
    for (var i = 0; i < history.length; i++) if (history[i] && history[i].type === "image") count++;
    if (count <= maxImages) return history;
    var out = history.slice();
    for (var j = out.length - 1; j >= 0 && count > maxImages; j--) {
      if (out[j] && out[j].type === "image") { out.splice(j, 1); count--; }
    }
    return out;
  }

  function addTextHistory(state, text, ts) {
    var t = typeof text === "string" ? text : "";
    if (t === "") return state;
    var items = state.history.slice();
    var idx = -1;
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type === "text" && items[i].text === t) { idx = i; break; }
    }
    var id = idx >= 0 && items[idx].id ? items[idx].id : uid();
    if (idx >= 0) items.splice(idx, 1);
    items.unshift({ id: id, type: "text", text: t, ts: ts || now() });
    if (items.length > state.settings.maxHistory) items = items.slice(0, state.settings.maxHistory);
    return { history: items, snippets: state.snippets, groups: state.groups, settings: state.settings };
  }

  function addImageHistory(state, image, ts) {
    if (!image || typeof image.dataUrl !== "string" || image.dataUrl === "") return state;
    var items = state.history.slice();
    items.unshift({
      id: uid(),
      type: "image",
      dataUrl: image.dataUrl,
      thumb: image.thumb || image.dataUrl,
      w: image.w || 0,
      h: image.h || 0,
      sig: image.sig || "",
      ts: ts || now()
    });
    items = pruneImages(items, state.settings.maxImages);
    if (items.length > state.settings.maxHistory) items = items.slice(0, state.settings.maxHistory);
    return { history: items, snippets: state.snippets, groups: state.groups, settings: state.settings };
  }

  function deleteHistory(state, id) {
    return {
      history: state.history.filter(function (h) { return !h || h.id !== id; }),
      snippets: state.snippets,
      groups: state.groups,
      settings: state.settings
    };
  }

  function clearHistory(state) {
    return { history: [], snippets: state.snippets, groups: state.groups, settings: state.settings };
  }

  function touchHistory(state, id, ts) {
    var items = state.history.slice();
    var idx = -1;
    for (var i = 0; i < items.length; i++) if (items[i] && items[i].id === id) { idx = i; break; }
    if (idx < 0) return state;
    var item = Object.assign({}, items[idx], { ts: ts || now() });
    items.splice(idx, 1);
    items.unshift(item);
    return { history: items, snippets: state.snippets, groups: state.groups, settings: state.settings };
  }

  function addSnippet(state, groupId, tag, text, ts) {
    var t = typeof text === "string" ? text : "";
    if (t.trim() === "") return state;
    var gid = groupId || "g-default";
    var list = state.snippets.slice();
    list.unshift({ id: uid(), groupId: gid, tag: typeof tag === "string" ? tag.trim() : "", text: t, ts: ts || now(), updatedAt: ts || now() });
    return { history: state.history, snippets: list, groups: state.groups, settings: state.settings };
  }

  function updateSnippet(state, id, groupId, tag, text, ts) {
    var list = state.snippets.map(function (s) {
      if (!s || s.id !== id) return s;
      return Object.assign({}, s, {
        groupId: groupId || s.groupId || "g-default",
        tag: typeof tag === "string" ? tag.trim() : (s.tag || ""),
        text: typeof text === "string" ? text : s.text,
        updatedAt: ts || now()
      });
    });
    return { history: state.history, snippets: list, groups: state.groups, settings: state.settings };
  }

  function deleteSnippet(state, id) {
    return {
      history: state.history,
      snippets: state.snippets.filter(function (s) { return !s || s.id !== id; }),
      groups: state.groups,
      settings: state.settings
    };
  }

  function addGroup(state, name, ts) {
    var n = typeof name === "string" ? name.trim() : "";
    if (!n) return { state: state, id: null };
    for (var i = 0; i < state.groups.length; i++) {
      if (state.groups[i] && state.groups[i].name === n) return { state: state, id: state.groups[i].id };
    }
    var g = { id: "g-" + Math.random().toString(36).slice(2, 10), name: n, ts: ts || now() };
    return { state: { history: state.history, snippets: state.snippets, groups: state.groups.concat([g]), settings: state.settings }, id: g.id };
  }

  function deleteGroup(state, id) {
    if (id === "g-default") return state;
    var groups = state.groups.filter(function (g) { return !g || g.id !== id; });
    if (!groups.some(function (g) { return g.id === "g-default"; })) groups.unshift({ id: "g-default", name: "默认", ts: 0 });
    var snippets = state.snippets.map(function (s) {
      if (s && s.groupId === id) return Object.assign({}, s, { groupId: "g-default" });
      return s;
    });
    return { history: state.history, snippets: snippets, groups: groups, settings: state.settings };
  }

  function renameGroup(state, id, name, ts) {
    var n = typeof name === "string" ? name.trim() : "";
    if (!n) return state;
    var changed = false;
    var groups = state.groups.map(function (g) {
      if (!g || g.id !== id) return g;
      if (g.name === n) return g;
      changed = true;
      return Object.assign({}, g, { name: n, ts: ts || now() });
    });
    if (!changed) return state;
    return { history: state.history, snippets: state.snippets, groups: groups, settings: state.settings };
  }

  function filterHistory(state, query) {
    var q = typeof query === "string" ? query.trim().toLowerCase() : "";
    var items = state.history || [];
    if (!q) return items;
    return items.filter(function (it) {
      if (!it) return false;
      if (it.type === "text") return String(it.text || "").toLowerCase().indexOf(q) >= 0;
      return false;
    });
  }

  function filterSnippets(state, groupId, query) {
    var q = typeof query === "string" ? query.trim().toLowerCase() : "";
    var items = state.snippets || [];
    return items.filter(function (s) {
      if (!s) return false;
      if (q) return ((s.tag || "") + " " + (s.text || "")).toLowerCase().indexOf(q) >= 0;
      return s.groupId === (groupId || "g-default");
    });
  }

  return {
    MAX_HISTORY: MAX_HISTORY,
    MAX_IMAGES: MAX_IMAGES,
    uid: uid,
    normalizeState: normalizeState,
    addTextHistory: addTextHistory,
    addImageHistory: addImageHistory,
    deleteHistory: deleteHistory,
    clearHistory: clearHistory,
    touchHistory: touchHistory,
    addSnippet: addSnippet,
    updateSnippet: updateSnippet,
    deleteSnippet: deleteSnippet,
    addGroup: addGroup,
    deleteGroup: deleteGroup,
    renameGroup: renameGroup,
    filterHistory: filterHistory,
    filterSnippets: filterSnippets
  };
});
