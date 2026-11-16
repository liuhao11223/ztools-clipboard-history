/**
 * 剪切板核心逻辑单元测试：node --test test/
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../lib/core.js");

test("normalizeState: 默认值与缺省补全", () => {
  const s = core.normalizeState(null);
  assert.deepEqual(s.history, []);
  assert.deepEqual(s.snippets, []);
  assert.equal(s.groups[0].id, "g-default");
  assert.equal(typeof s.settings.maxHistory, "number");
  assert.equal(s.settings.keepImages, false);

  const s2 = core.normalizeState({ groups: [{ id: "g-x", name: "X", ts: 1 }], settings: { keepImages: true } });
  assert.equal(s2.groups[0].id, "g-default");
  assert.equal(s2.groups.some((g) => g.id === "g-x"), true);
  assert.equal(s2.settings.keepImages, true);
});

test("addTextHistory: 去重并置顶，保留原 id", () => {
  let s = core.normalizeState(null);
  s = core.addTextHistory(s, "hello", 1);
  assert.equal(s.history.length, 1);
  assert.equal(s.history[0].text, "hello");
  const id = s.history[0].id;
  s = core.addTextHistory(s, "world", 2);
  assert.equal(s.history[0].text, "world");
  s = core.addTextHistory(s, "hello", 3);
  assert.equal(s.history.length, 2);
  assert.equal(s.history[0].text, "hello");
  assert.equal(s.history[0].id, id);
  assert.equal(s.history[0].ts, 3);
});

test("addTextHistory: 空文本忽略，超出 maxHistory 截断", () => {
  let s = core.normalizeState({ settings: { maxHistory: 50 } });
  s.settings.maxHistory = 50;
  s = core.addTextHistory(s, "", 1);
  assert.equal(s.history.length, 0);
  for (let i = 0; i < 60; i++) s = core.addTextHistory(s, "t" + i, i);
  assert.equal(s.history.length, 50);
  assert.equal(s.history[0].text, "t59");
});

test("addImageHistory: 记录图片并按 maxImages 裁剪旧图", () => {
  let s = core.normalizeState(null);
  s.settings.maxImages = 2;
  s = core.addImageHistory(s, { dataUrl: "data:image/png;base64,a", w: 1, h: 1, sig: "a" }, 1);
  s = core.addImageHistory(s, { dataUrl: "data:image/png;base64,b", w: 2, h: 2, sig: "b" }, 2);
  s = core.addImageHistory(s, { dataUrl: "data:image/png;base64,c", w: 3, h: 3, sig: "c" }, 3);
  const images = s.history.filter((h) => h.type === "image");
  assert.equal(images.length, 2);
  assert.deepEqual(images.map((i) => i.sig), ["c", "b"]);
});

test("deleteHistory / clearHistory / touchHistory", () => {
  let s = core.normalizeState(null);
  s = core.addTextHistory(s, "a", 1);
  s = core.addTextHistory(s, "b", 2);
  const idB = s.history[0].id;
  const idA = s.history[1].id;
  s = core.touchHistory(s, idA, 5);
  assert.equal(s.history[0].id, idA);
  assert.equal(s.history[0].ts, 5);
  s = core.deleteHistory(s, idA);
  assert.equal(s.history.some((h) => h.id === idA), false);
  assert.equal(s.history.length, 1);
  s = core.clearHistory(s);
  assert.equal(s.history.length, 0);
  assert.equal(idB.length > 0, true);
});

test("snippets: 添加/更新/删除", () => {
  let s = core.normalizeState(null);
  s = core.addSnippet(s, "g-default", "邮箱", "a@b.com", 1);
  assert.equal(s.snippets.length, 1);
  const id = s.snippets[0].id;
  assert.equal(s.snippets[0].tag, "邮箱");
  s = core.updateSnippet(s, id, "g-default", "mail", "x@y.com", 2);
  assert.equal(s.snippets[0].tag, "mail");
  assert.equal(s.snippets[0].text, "x@y.com");
  assert.equal(s.snippets[0].updatedAt, 2);
  s = core.addSnippet(s, "g-default", "", "   ", 3);
  assert.equal(s.snippets.length, 1);
  s = core.deleteSnippet(s, id);
  assert.equal(s.snippets.length, 0);
});

test("groups: 添加同名复用、删除后常用文字归入默认", () => {
  let s = core.normalizeState(null);
  let r = core.addGroup(s, "工作", 1);
  s = r.state;
  assert.equal(typeof r.id, "string");
  const gid = r.id;
  const r2 = core.addGroup(s, "工作", 2);
  assert.equal(r2.id, gid);
  assert.equal(r2.state.groups.length, s.groups.length);
  s = core.addSnippet(s, gid, "t", "hi", 3);
  s = core.deleteGroup(s, gid);
  assert.equal(s.groups.some((g) => g.id === gid), false);
  assert.equal(s.snippets[0].groupId, "g-default");
  const s2 = core.deleteGroup(core.normalizeState(null), "g-default");
  assert.equal(s2.groups.some((g) => g.id === "g-default"), true);
});

test("groups: renameGroup 修改名称，忽略空名与无变化", () => {
  let s = core.normalizeState(null);
  const r = core.addGroup(s, "工作", 1);
  s = r.state;
  const gid = r.id;
  s = core.renameGroup(s, gid, "项目", 2);
  assert.equal(s.groups.find((g) => g.id === gid).name, "项目");
  const s2 = core.renameGroup(s, gid, "   ", 3);
  assert.equal(s2.groups.find((g) => g.id === gid).name, "项目");
  const s3 = core.renameGroup(s, "nope", "X", 4);
  assert.equal(s3, s);
  const s4 = core.renameGroup(s, gid, "项目", 5);
  assert.equal(s4, s);
});

test("filterHistory/filterSnippets: 搜索与分组过滤", () => {
  let s = core.normalizeState(null);
  s = core.addTextHistory(s, "Hello World", 1);
  s = core.addTextHistory(s, "测试内容", 2);
  s = core.addImageHistory(s, { dataUrl: "data:image/png;base64,a", sig: "a" }, 3);
  assert.equal(core.filterHistory(s, "world").length, 1);
  assert.equal(core.filterHistory(s, "测试").length, 1);
  assert.equal(core.filterHistory(s, "").length, 3);
  const g = core.addGroup(s, "G", 1); s = g.state;
  s = core.addSnippet(s, "g-default", "a", "alpha", 1);
  s = core.addSnippet(s, g.id, "b", "beta", 2);
  assert.equal(core.filterSnippets(s, "g-default", "").length, 1);
  assert.equal(core.filterSnippets(s, g.id, "").length, 1);
  assert.equal(core.filterSnippets(s, "g-default", "beta").length, 1);
});
