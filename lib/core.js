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

  function normalizeDeleted(raw) {
    var out = {};
    if (raw && typeof raw === "object") {
      Object.keys(raw).forEach(function (id) {
        var v = Number(raw[id]);
        if (id && isFinite(v) && v > 0) out[String(id)] = v;
      });
    }
    return out;
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
        keepImages: s.settings ? s.settings.keepImages !== false : false,
        deleted: normalizeDeleted(s.settings && s.settings.deleted)
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

  function deleteSnippet(state, id, ts) {
    if (!id) return state;
    var deleted = Object.assign({}, state.settings && state.settings.deleted ? state.settings.deleted : {});
    deleted[String(id)] = ts || now();
    return {
      history: state.history,
      snippets: state.snippets.filter(function (s) { return !s || s.id !== id; }),
      groups: state.groups,
      settings: Object.assign({}, state.settings, { deleted: deleted })
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

  /* ---------- 与「我的数据」同步：冲突时以最新记录为准 ---------- */

  function snippetTime(rec) {
    if (!rec || typeof rec !== "object") return 0;
    var t = rec.updatedAt != null ? rec.updatedAt : (rec.updated != null ? rec.updated : (rec.ts != null ? rec.ts : rec.createdAt));
    if (typeof t === "number" && isFinite(t)) return t;
    var parsed = Date.parse(t);
    return isNaN(parsed) ? 0 : parsed;
  }

  function groupNameById(st, id) {
    var groups = (st && st.groups) || [];
    for (var i = 0; i < groups.length; i++) {
      if (groups[i] && groups[i].id === id) return groups[i].name || "";
    }
    return id === "g-default" ? "默认" : "";
  }

  function snippetDocId(id) { return "snippet/" + String(id || ""); }

  function buildSnippetDoc(st, s) {
    var text = String(s && s.text || "");
    var tag = String(s && s.tag || "");
    var title = (tag ? "[" + tag + "] " : "") + text;
    if (title.length > 80) title = title.slice(0, 80) + "…";
    if (!title) title = "常用文字";
    return {
      type: "clipboard-snippet",
      title: title,
      text: text,
      tag: tag,
      groupId: s && s.groupId ? s.groupId : "g-default",
      groupName: groupNameById(st, s && s.groupId),
      createdAt: Number(s && s.ts) || 0,
      updatedAt: Number(s && (s.updatedAt || s.ts)) || 0,
      source: "clipboard-history"
    };
  }

  function docToSnippet(doc) {
    if (!doc || typeof doc !== "object") return null;
    var id = String(doc._id != null ? doc._id : doc.id || "").replace(/^snippet\//, "");
    if (!id) return null;
    var text = doc.text != null ? String(doc.text) : (doc.title != null ? String(doc.title) : "");
    if (!text) return null;
    var ts = Number(doc.updatedAt) || Number(doc.createdAt) || Number(doc.ts) || 0;
    return {
      id: id,
      groupId: doc.groupId || "g-default",
      tag: typeof doc.tag === "string" ? doc.tag : "",
      text: text,
      ts: ts,
      updatedAt: ts
    };
  }

  /**
   * 合并本地 JSON 与「我的数据」中的常用文字，冲突时取时间戳最新的记录。
   * 返回 { state, dbOps }：
   *  - state：合并后的本地状态（新记录回填到本地）
   *  - dbOps：需写入库的操作 [{ op:"put"|"remove", id, doc }]
   */
  function resolveSyncConflict(localState, dbDocs) {
    var st = normalizeState(localState);
    var localMap = {};
    st.snippets.forEach(function (s) { if (s && s.id) localMap[String(s.id)] = s; });

    var existing = {};
    (Array.isArray(dbDocs) ? dbDocs : []).forEach(function (d) {
      if (!d) return;
      var key = String(d._id != null ? d._id : (d.id || ""));
      if (!key) return;
      existing[key.replace(/^snippet\//, "")] = d;
    });

    var tombstones = Object.assign({}, st.settings.deleted || {});
    var newSnippets = {};
    var newDeleted = {};
    var dbOps = [];

    Object.keys(localMap).forEach(function (id) {
      var localRec = localMap[id];
      var dbRec = existing[id];
      var lt = snippetTime(localRec);
      var dt = snippetTime(dbRec);
      var del = Number(tombstones[id]) || 0;

      if (del && del >= lt) {
        if (dbRec) dbOps.push({ op: "remove", id: snippetDocId(id), doc: dbRec });
        newDeleted[id] = del;
        return;
      }
      if (del) delete tombstones[id];

      if (dbRec && dt > lt) {
        var fromDb = docToSnippet(dbRec);
        if (fromDb) newSnippets[id] = fromDb;
        dbOps.push({ op: "put", id: snippetDocId(id), doc: dbRec });
      } else {
        newSnippets[id] = localRec;
        dbOps.push({ op: "put", id: snippetDocId(id), doc: Object.assign({ _id: snippetDocId(id) }, buildSnippetDoc(st, localRec)) });
      }
    });

    Object.keys(existing).forEach(function (id) {
      if (newSnippets[id] || newDeleted[id] || localMap[id]) return;
      var dbRec = existing[id];
      var dt = snippetTime(dbRec);
      var del = Number(tombstones[id]) || 0;
      if (del && del >= dt) {
        dbOps.push({ op: "remove", id: snippetDocId(id), doc: dbRec });
        newDeleted[id] = del;
      } else {
        var fromDb = docToSnippet(dbRec);
        if (fromDb) newSnippets[id] = fromDb;
        if (del) delete tombstones[id];
        dbOps.push({ op: "put", id: snippetDocId(id), doc: dbRec });
      }
    });

    return {
      state: {
        history: st.history,
        snippets: Object.keys(newSnippets).map(function (id) { return newSnippets[id]; }),
        groups: st.groups,
        settings: Object.assign({}, st.settings, { deleted: newDeleted })
      },
      dbOps: dbOps
    };
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
    filterSnippets: filterSnippets,
    snippetTime: snippetTime,
    snippetDocId: snippetDocId,
    buildSnippetDoc: buildSnippetDoc,
    docToSnippet: docToSnippet,
    resolveSyncConflict: resolveSyncConflict
  };
});
