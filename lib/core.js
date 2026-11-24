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
      groupName: doc.groupName,
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
    // 合并库中出现的分组：按名称去重，缺失的分组补充到本地，避免记录的 groupId 指向不存在的分组
    var groupNameToId = {};
    (st.groups || []).forEach(function (g) { if (g && g.id) groupNameToId[String(g.name || "")] = g.id; });
    (Array.isArray(dbDocs) ? dbDocs : []).forEach(function (d) {
      if (!d || !d.groupName) return;
      var gname = String(d.groupName);
      if (!groupNameToId[gname]) {
        var gid = d.groupId && String(d.groupId);
        if (!gid || st.groups.some(function (g) { return g && g.id === gid; })) {
          // 生成新 id 避免与已有冲突
          gid = "g-" + Math.random().toString(36).slice(2, 10);
        }
        st.groups.push({ id: gid, name: gname, ts: Number(d.updatedAt || d.createdAt || 0) });
        groupNameToId[gname] = gid;
      }
    });
    // 用名称映射修正记录的 groupId
    function fixGroup(rec) {
      if (!rec) return rec;
      if (rec.groupId && st.groups.some(function (g) { return g && g.id === rec.groupId; })) return rec;
      var mapped = groupNameToId[String(rec.groupName || "")];
      if (mapped) return Object.assign({}, rec, { groupId: mapped });
      return rec;
    }
    var localById = {};
    st.snippets.forEach(function (s) { if (s && s.id) localById[String(s.id)] = fixGroup(s); });

    var dbById = {};
    (Array.isArray(dbDocs) ? dbDocs : []).forEach(function (d) {
      if (!d) return;
      var key = String(d._id != null ? d._id : (d.id || ""));
      if (!key) return;
      // 仅处理「我的数据」中属于本插件的常用文字记录（兼容 host 返回的前缀形态）
      var isSnippetKey = key.indexOf("snippet/") === 0;
      var isSnippetDoc = d && (d.type === "clipboard-snippet" || d.source === "clipboard-history");
      if (!isSnippetKey && !isSnippetDoc) return;
      var bareId = isSnippetKey ? key.replace(/^snippet\//, "") : key;
      if (!bareId) return;
      dbById[bareId] = d;
    });

    var deleted = Object.assign({}, st.settings.deleted || {});
    var removeDbIds = {};
    // 被删除的记录可能以不同 id 重复存在于库中，按文本识别并移除
    var deletedTexts = {};
    Object.keys(deleted).forEach(function (did) {
      var rec = dbById[did];
      if (rec) {
        var t = String(rec.text != null ? rec.text : "").trim();
        if (t) deletedTexts[t] = true;
      }
    });

    // 本地按文本去重：相同文本只保留时间戳最新的记录
    var textBestLocal = {};
    Object.keys(localById).forEach(function (id) {
      var rec = localById[id];
      var key = String(rec && rec.text || "").trim();
      if (key === "") return;
      if (!Object.prototype.hasOwnProperty.call(textBestLocal, key)) {
        textBestLocal[key] = id;
      } else {
        var prevId = textBestLocal[key];
        if (snippetTime(rec) >= snippetTime(localById[prevId])) {
          delete localById[prevId];
          removeDbIds[prevId] = true;
          textBestLocal[key] = id;
        } else {
          delete localById[id];
          removeDbIds[id] = true;
        }
      }
    });

    // 库中按文本去重：相同文本只保留时间戳最新的记录
    var textBestDb = {};
    Object.keys(dbById).forEach(function (id) {
      var rec = dbById[id];
      var key = String((rec && rec.text) != null ? rec.text : "").trim();
      if (key === "") return;
      if (!Object.prototype.hasOwnProperty.call(textBestDb, key)) {
        textBestDb[key] = id;
      } else {
        var prevId = textBestDb[key];
        if (snippetTime(rec) >= snippetTime(dbById[prevId])) {
          removeDbIds[prevId] = true;
          delete dbById[prevId];
          textBestDb[key] = id;
        } else {
          removeDbIds[id] = true;
          delete dbById[id];
        }
      }
    });

    var finalById = {};
    var finalDeleted = {};
    var consumedDbIds = {};

    // 先处理本地已知记录：与同 id 库记录、删除标记做时间戳仲裁
    Object.keys(localById).forEach(function (id) {
      var localRec = localById[id];
      var dbRec = dbById[id];
      var lt = snippetTime(localRec);
      var dt = snippetTime(dbRec);
      var del = Number(deleted[id]) || 0;

      if (del && del >= lt) {
        finalDeleted[id] = del;
        if (dbRec) { removeDbIds[id] = true; consumedDbIds[id] = true; }
        return;
      }
      if (dbRec) consumedDbIds[id] = true;
      if (dbRec && dt > lt) {
        var fromDb = docToSnippet(dbRec);
        if (fromDb) { fromDb.id = id; finalById[id] = fixGroup(fromDb); }
        else finalById[id] = localRec;
      } else {
        // 时间戳相同或本地更新时保留本地（时间戳相等视为未发生冲突更新）
        finalById[id] = localRec;
      }
    });

    // 处理仅库中存在（或同文本不同 id）的记录
    Object.keys(dbById).forEach(function (id) {
      if (consumedDbIds[id]) return;
      var dbRec = dbById[id];
      var dt = snippetTime(dbRec);
      var del = Number(deleted[id]) || 0;
      var dbText = String(dbRec && dbRec.text != null ? dbRec.text : "").trim();

      // 按文本匹配删除标记：即使 id 不同，只要文本在已删除列表中就删除
      if (del && del >= dt) {
        finalDeleted[id] = del;
        removeDbIds[id] = true;
        return;
      }
      if (deletedTexts[dbText]) {
        finalDeleted[id] = now();
        removeDbIds[id] = true;
        return;
      }

      // 相同文本但 id 不同：合并到本地已有记录，避免重复
      var matchedId = null;
      if (dbText !== "") {
        Object.keys(finalById).forEach(function (fid) {
          if (matchedId) return;
          if (String(finalById[fid] && finalById[fid].text || "").trim() === dbText) matchedId = fid;
        });
      }
      if (matchedId) {
        if (dt > snippetTime(finalById[matchedId])) {
          var fromDbMerge = docToSnippet(dbRec);
          if (fromDbMerge) { fromDbMerge.id = matchedId; finalById[matchedId] = fixGroup(fromDbMerge); }
        }
        if (id !== matchedId) removeDbIds[id] = true;
        return;
      }

      var fromDbOnly = docToSnippet(dbRec);
      if (fromDbOnly) finalById[id] = fixGroup(fromDbOnly);
    });

    // 生成库操作：最终集合同步到库，冗余/已删除记录移除
    var dbOps = [];
    Object.keys(finalById).forEach(function (id) {
      var dbRec = dbById[id];
      var fixed = finalById[id];
      if (dbRec && snippetTime(dbRec) === snippetTime(fixed) && String(dbRec.text != null ? dbRec.text : "").trim() === String(fixed.text || "").trim()) {
        // 统一分组 id：把库中记录的 groupId 修正为本地统一后的 groupId
        var patched = Object.assign({}, dbRec, { groupId: fixed.groupId, groupName: fixed.groupName });
        dbOps.push({ op: "put", id: snippetDocId(id), doc: patched });
      } else {
        dbOps.push({ op: "put", id: snippetDocId(id), doc: Object.assign({ _id: snippetDocId(id) }, buildSnippetDoc(st, finalById[id])) });
      }
    });
    Object.keys(removeDbIds).forEach(function (id) {
      if (finalById[id]) return;
      if (dbById[id]) dbOps.push({ op: "remove", id: snippetDocId(id), doc: dbById[id] });
    });

    // 确保分组存在，避免库中记录使用未知 groupId 导致在剪切板界面无法显示
    var groupIds = {};
    st.groups.forEach(function (g) { if (g && g.id) groupIds[g.id] = true; });
    Object.keys(finalById).forEach(function (id) {
      var rec = finalById[id];
      if (rec && rec.groupId && !groupIds[rec.groupId]) {
        finalById[id] = Object.assign({}, rec, { groupId: "g-default" });
      }
    });

    return {
      state: {
        history: st.history,
        snippets: Object.keys(finalById).map(function (id) { return fixGroup(finalById[id]); }),
        groups: st.groups,
        settings: Object.assign({}, st.settings, { deleted: finalDeleted })
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
