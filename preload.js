/**
 * 剪切板插件 preload：最小本地能力层
 * - 剪贴板读写（文本/图片）
 * - 本地 JSON 存储（历史与常用文字）
 * 不做网络请求、不执行外部命令。
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

let electron = null;
try { electron = require("electron"); } catch (_) { electron = null; }

const core = require("./lib/core.js");

const MAX_TEXT_LENGTH = 200000;
const MAX_IMAGE_DATAURL = 3500000;

function fail(error) { return { ok: false, error: String(error || "unknown error") }; }

function dataRoot() {
  if (process.env.ZTOOLS_DATA_ROOT) return process.env.ZTOOLS_DATA_ROOT;
  return path.join(os.homedir(), ".ztools");
}

function storePath() {
  return path.join(dataRoot(), "clipboard-history-plugin.json");
}

function load() {
  const file = storePath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    return { ok: true, path: file, state: core.normalizeState(JSON.parse(raw)) };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { ok: true, path: file, state: core.normalizeState(null) };
    }
    return { ok: false, path: file, error: error && error.message ? error.message : String(error), state: core.normalizeState(null) };
  }
}

function save(state) {
  const file = storePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    const normalized = core.normalizeState(state);
    fs.writeFileSync(tmp, JSON.stringify(normalized), "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (error) {
    return fail(error && error.message ? error.message : error);
  }
}

function getClipboard() {
  if (electron && electron.clipboard) return electron.clipboard;
  return null;
}

function getNativeImage() {
  if (electron && electron.nativeImage) return electron.nativeImage;
  return null;
}

function fnv(buf) {
  let h = 0x811c9dc5;
  const n = Math.min(buf.length, 262144);
  const step = Math.max(1, Math.floor(n / 32768));
  for (let i = 0; i < n; i += step) { h ^= buf[i]; h = (h * 0x01000193) >>> 0; }
  return h.toString(16);
}

function read() {
  const cb = getClipboard();
  if (!cb) return { ok: false, error: "clipboard unavailable" };
  try {
    const text = cb.readText() || "";
    if (text) {
      const t = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
      return { ok: true, kind: "text", text: t };
    }
    const formats = typeof cb.availableFormats === "function" ? cb.availableFormats() : [];
    if (Array.isArray(formats) && formats.some(function (f) { return String(f).indexOf("image") === 0; })) {
      const img = cb.readImage();
      if (img && typeof img.isEmpty === "function" && !img.isEmpty()) {
        const size = typeof img.getSize === "function" ? img.getSize() : { width: 0, height: 0 };
        let buf = Buffer.alloc(0);
        try { buf = img.toBitmap(); } catch (_) { try { buf = img.toPNG(); } catch (_) { buf = Buffer.alloc(0); } }
        const sig = String(size.width) + "x" + String(size.height) + ":" + String(buf.length) + ":" + fnv(buf);
        let dataUrl = "";
        try { dataUrl = img.toDataURL(); } catch (_) { dataUrl = ""; }
        if (!dataUrl || dataUrl.length > MAX_IMAGE_DATAURL) return { ok: true, kind: "none" };
        let thumb = dataUrl;
        try { thumb = img.resize({ width: 96, quality: "good" }).toDataURL(); } catch (_) { thumb = dataUrl; }
        return { ok: true, kind: "image", image: { dataUrl: dataUrl, thumb: thumb, w: size.width || 0, h: size.height || 0, sig: sig } };
      }
    }
    return { ok: true, kind: "none" };
  } catch (error) {
    return fail(error && error.message ? error.message : error);
  }
}

function writeText(text) {
  const cb = getClipboard();
  if (!cb) return fail("clipboard unavailable");
  try {
    cb.writeText(typeof text === "string" ? text : String(text || ""));
    return { ok: true };
  } catch (error) {
    return fail(error && error.message ? error.message : error);
  }
}

function writeImage(dataUrl) {
  const cb = getClipboard();
  const nativeImage = getNativeImage();
  if (!cb || !nativeImage) return fail("image clipboard unavailable");
  try {
    const img = nativeImage.createFromDataURL(String(dataUrl || ""));
    if (!img || (typeof img.isEmpty === "function" && img.isEmpty())) return fail("invalid image");
    cb.writeImage(img);
    return { ok: true };
  } catch (error) {
    return fail(error && error.message ? error.message : error);
  }
}

window.services = {
  version: "1.0.0",
  core: core,
  storePath: storePath,
  load: load,
  save: save,
  readClipboard: read,
  writeText: writeText,
  writeImage: writeImage
};

function queryText(queryData) {
  if (queryData == null) return "";
  if (typeof queryData === "string") return queryData.trim();
  if (typeof queryData === "number") return String(queryData);
  if (typeof queryData === "object") {
    var t = queryData.text != null ? queryData.text : (queryData.payload != null ? queryData.payload : (queryData.query != null ? queryData.query : queryData.value));
    if (t == null) return "";
    return String(t).trim();
  }
  return String(queryData).trim();
}

function previewText(text, max) {
  var t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "(空文本)";
  if (t.length > (max || 60)) return t.slice(0, max || 60) + "…";
  return t;
}

function mainPushResults(queryData) {
  var q = queryText(queryData);
  if (!q) return [];
  var loaded = load();
  var state = (loaded && loaded.state) ? loaded.state : core.normalizeState(null);
  var items = core.filterHistory(state, q).slice(0, 12);
  return items.map(function (item) {
    var isImage = item && item.type === "image";
    var text = isImage ? "[图片] " + String(item.w || 0) + "×" + String(item.h || 0) : String(item && item.text || "");
    var title = isImage ? "[图片剪贴板]" : previewText(text, 64);
    return {
      text: title,
      title: title,
      description: isImage ? "剪贴板图片" : "剪贴板历史 · 点击复制/粘贴",
      icon: "logo.png",
      _clipboard: {
        id: item && item.id,
        type: isImage ? "image" : "text",
        text: isImage ? "" : String(item && item.text || ""),
        dataUrl: isImage ? String(item && item.dataUrl || item && item.thumb || "") : "",
        thumb: isImage ? String(item && item.thumb || "") : "",
        w: item && item.w || 0,
        h: item && item.h || 0,
        sig: item && item.sig || ""
      }
    };
  });
}

function touchSavedHistory(id) {
  if (!id) return;
  try {
    var loaded = load();
    var state = (loaded && loaded.state) ? loaded.state : core.normalizeState(null);
    state = core.touchHistory(state, id);
    save(state);
  } catch (_) {}
}

function selectMainPush(item) {
  var data = item && item._clipboard ? item._clipboard : item;
  if (!data) return false;
  if (data.type === "image") {
    var dataUrl = String(data.dataUrl || data.thumb || "");
    if (!dataUrl) return false;
    var r = writeImage(dataUrl);
    if (!r || !r.ok) return false;
    touchSavedHistory(data.id);
    if (window.ztools && typeof window.ztools.hideMainWindowPasteImage === "function") {
      try { window.ztools.hideMainWindowPasteImage(dataUrl); } catch (_) {}
    } else if (window.ztools && typeof window.ztools.hideMainWindow === "function") {
      try { window.ztools.hideMainWindow(true); } catch (_) {}
    }
    return false;
  }
  var text = String(data.text || (typeof item.text === "string" ? item.text : "") || "");
  if (!text) return false;
  var wr = writeText(text);
  if (!wr || !wr.ok) return false;
  touchSavedHistory(data.id);
  if (window.ztools && typeof window.ztools.hideMainWindowPasteText === "function") {
    try { window.ztools.hideMainWindowPasteText(text); } catch (_) {}
  } else if (window.ztools && typeof window.ztools.hideMainWindow === "function") {
    try { window.ztools.hideMainWindow(true); } catch (_) {}
  }
  return false;
}

if (window.ztools && typeof window.ztools.onMainPush === "function") {
  try {
    window.ztools.onMainPush(function (queryData) {
      try { return mainPushResults(queryData); } catch (_) { return []; }
    }, function (selectData) {
      try { return selectMainPush(selectData); } catch (_) { return false; }
    });
  } catch (_) {}
}
