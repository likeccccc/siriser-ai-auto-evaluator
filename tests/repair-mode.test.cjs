const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../Siriser-AI-Evaluator/content.js'), 'utf8');
function section(start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `missing source section ${start}`);
  return source.slice(a, b);
}

test('repair owner survives same-tab navigation without a background response', async () => {
  const values = new Map();
  const sessionStorage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  const context = {
    REPAIR_TAB_TOKEN_KEY: 'SIRISER_REPAIR_TAB_TOKEN', sessionStorage,
    crypto: { randomUUID: () => 'test-owner-uuid' },
    sendRuntimeMsg: () => { throw new Error('background must not be needed'); },
  };
  context.globalThis = context;
  vm.runInNewContext(section('  async function repairOwnerIdentity(', '  function isLabelingTaskPage(') +
    '\nglobalThis.identity = repairOwnerIdentity;', context);
  assert.equal(await context.identity(), 'session:test-owner-uuid');
  assert.equal(await context.identity(), 'session:test-owner-uuid');
  assert.equal(values.get('SIRISER_REPAIR_TAB_TOKEN'), 'test-owner-uuid');
});

test('repair feedback maps each model and dimension to its own direction', () => {
  const context = {};
  vm.runInNewContext(section('  function parseRepairFeedback(', '  async function readRepairCommunication(') +
    '\nglobalThis.parse = parseRepairFeedback;', context);
  const text = '模型-B、编辑指令遵循、偏低、非编辑区域保持、偏低、模型-C、编辑指令遵循、偏低、非编辑区域保持、偏低、模型-Q、编辑指令遵循、偏高、非编辑区域保持、偏高';
  const result = JSON.parse(JSON.stringify(context.parse(text)));
  assert.deepEqual(result, [
    { model: 'B', dim: 'alignment', direction: '偏低' },
    { model: 'B', dim: 'preservation', direction: '偏低' },
    { model: 'C', dim: 'alignment', direction: '偏低' },
    { model: 'C', dim: 'preservation', direction: '偏低' },
    { model: 'Q', dim: 'alignment', direction: '偏高' },
    { model: 'Q', dim: 'preservation', direction: '偏高' },
  ]);
});

test('repair feedback shares one opinion across parallel full model prefixes', () => {
  const context = {};
  vm.runInNewContext(section('  function parseRepairFeedback(', '  async function readRepairCommunication(') +
    '\nglobalThis.parse = parseRepairFeedback;', context);
  // 2026-10-22 实际返修意见：B、H 并列，意见只在最后一个前缀后面，两者都低。
  assert.deepEqual(JSON.parse(JSON.stringify(context.parse('模型-模型-B、模型-模型-H视觉真实感与美学偏低'))), [
    { model: 'B', dim: 'realism', direction: '偏低' },
    { model: 'H', dim: 'realism', direction: '偏低' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.parse('模型-模型-B和模型-模型-H全局一致性偏低'))), [
    { model: 'B', dim: 'consistency', direction: '偏低' },
    { model: 'H', dim: 'consistency', direction: '偏低' },
  ]);
  // 正文里顺带提到别的模型但没给意见时，不能误挂到那条意见上。
  assert.deepEqual(JSON.parse(JSON.stringify(context.parse('模型-A的构图较好，模型-B编辑指令遵循偏低'))), [
    { model: 'B', dim: 'alignment', direction: '偏低' },
  ]);
});

test('repair feedback expands a shared opinion across shorthand model lists', () => {
  const context = {};
  vm.runInNewContext(section('  function parseRepairFeedback(', '  async function readRepairCommunication(') +
    '\nglobalThis.parse = parseRepairFeedback;', context);
  const feedback = '模型-B、E、F、G、H、J、K、L、M、N、O、P、Q、R编辑指令遵循偏低；模型-M编辑局部质量偏低；模型-R非编辑区域保持偏高';
  const result = JSON.parse(JSON.stringify(context.parse(feedback)));
  const shared = 'B E F G H J K L M N O P Q R'.split(' ');
  assert.deepEqual(result, [
    ...shared.map((model) => ({ model, dim: 'alignment', direction: '偏低' })),
    { model: 'M', dim: 'quality', direction: '偏低' },
    { model: 'R', dim: 'preservation', direction: '偏高' },
  ]);
});

test('repair feedback reads repeated model prefixes and explicit low/high score wording', () => {
  const context = {};
  vm.runInNewContext(section('  function parseRepairFeedback(', '  async function readRepairCommunication(') +
    '\nglobalThis.parse = parseRepairFeedback;', context);
  const feedback = [
    '模型-模型-A编辑指令遵循、打分较低，指令完成度较高',
    '模型-模型-O非编辑区域保持打分较高，没有要求改变的内容改变',
    '模型-模型-S、非编辑区域保持打分较高，没有要求改变的内容改变',
    '模型-模型-S、全局一致性打分较高，新增、修改的内容没有自然融入原有场景',
  ].join('\n');
  assert.deepEqual(JSON.parse(JSON.stringify(context.parse(feedback))), [
    { model: 'A', dim: 'alignment', direction: '偏低' },
    { model: 'O', dim: 'preservation', direction: '偏高' },
    { model: 'S', dim: 'preservation', direction: '偏高' },
    { model: 'S', dim: 'consistency', direction: '偏高' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.parse('模型-A编辑指令遵循，指令完成度较高'))), [
    { model: 'A', dim: 'alignment', direction: '未说明' },
  ]);
});

test('repair feedback keeps model and dimension when direction is omitted', () => {
  const context = {};
  vm.runInNewContext(section('  function parseRepairFeedback(', '  async function readRepairCommunication(') +
    '\nglobalThis.parse = parseRepairFeedback;', context);
  const feedback = '模型-模型-H、非编辑区域保持、偏高、模型-模型-L、非编辑区域保持';
  assert.deepEqual(JSON.parse(JSON.stringify(context.parse(feedback))), [
    { model: 'H', dim: 'preservation', direction: '偏高' },
    { model: 'L', dim: 'preservation', direction: '未说明' },
  ]);
});

test('repair feedback parses 2026-10-22 screenshot wording with repeated prefixes and dual-dimension model', () => {
  const context = {};
  vm.runInNewContext(section('  function parseRepairFeedback(', '  async function readRepairCommunication(') +
    '\nglobalThis.parse = parseRepairFeedback;', context);
  const feedback = [
    '返修沟通 (1)',
    '注意：消息将在"提交题目"后同步给沟通用户',
    '验收人员 2026-10-22 17:04:52 (驳回)',
    '模型-模型-H编辑指令遵循打分较高、编辑结果没有准确地实现指令的编辑意图',
    '模型-模型-F编辑指令遵循打分较高、编辑结果没有准确地实现指令的编辑意图',
    '模型-模型-F编辑局部质量打分较高，编辑效果有瑕疵',
  ].join('\n');
  assert.deepEqual(JSON.parse(JSON.stringify(context.parse(feedback))), [
    { model: 'H', dim: 'alignment', direction: '偏高' },
    { model: 'F', dim: 'alignment', direction: '偏高' },
    { model: 'F', dim: 'quality', direction: '偏高' },
  ]);
});

test('repair correction uses extreme-score bands and leaves unrelated dimensions untouched', () => {
  const context = { DIMS: ['alignment', 'quality', 'preservation', 'consistency', 'realism'], log() {} };
  vm.runInNewContext(section('  function repairAdjustedScore(', '  async function autoOneTask(') +
    '\nglobalThis.apply = applyRepairCorrections;', context);
  const scores = [
    { model: 'B', alignment: 1, preservation: 7 },
    { model: 'C', alignment: 2, preservation: 8 },
    { model: 'Q', alignment: 9, preservation: 10 },
  ];
  context.apply(scores, [
    { model: 'B', dim: 'alignment', direction: '偏低' },
    { model: 'C', dim: 'alignment', direction: '偏低' },
    { model: 'Q', dim: 'preservation', direction: '偏高' },
  ]);
  assert.equal(scores[0].alignment, 6);
  assert.equal(scores[1].alignment, 7);
  assert.equal(scores[2].preservation, 5);
  assert.equal(scores[0].preservation, 7);
  assert.equal(scores[1].preservation, 8);
});

test('repair score bands follow the specified examples and reject mismatched directions', () => {
  const context = { DIMS: ['alignment', 'quality', 'preservation', 'consistency', 'realism'], log() {} };
  vm.runInNewContext(section('  function repairAdjustedScore(', '  async function autoOneTask(') +
    '\nglobalThis.adjust = repairAdjustedScore;', context);
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => context.adjust(n, '偏低')), [6, 7, 8, 8, 8]);
  assert.deepEqual([6, 7, 8, 9, 10].map((n) => context.adjust(n, '偏高')), [3, 4, 4, 4, 5]);
  assert.throws(() => context.adjust(8, '偏低'), /需人工复核/);
  assert.throws(() => context.adjust(2, '偏高'), /需人工复核/);
});

test('repair assistant groups named models and marks only criticized score rows', () => {
  const hintNodes = [];
  const anchors = new Map(['A', 'B'].map((model) => [model, {
    model, appendChild(node) { hintNodes.push({ model, node }); },
  }]));
  const groups = new Map(['A', 'B'].map((model) => [model, {
    alignment: { options: { 1: { tagName: 'LABEL', parentElement: anchors.get(model) } } },
    quality: { options: { 1: { tagName: 'LABEL', parentElement: anchors.get(model) } } },
  }]));
  const context = {
    DIMS: ['alignment', 'quality', 'preservation', 'consistency', 'realism'],
    qa: () => [], collectScoreGroups: () => ({ groups }), selectedRepairScore: () => 2,
    document: { createElement: () => ({ className: '', textContent: '', title: '' }) },
  };
  vm.runInNewContext(section('  function repairAdjustedScore(', '  function applyRepairCorrections(') +
    section('  const REPAIR_DIM_NAMES =', '  const HUMAN_KEY =') +
    '\nglobalThis.group = groupRepairCorrections; globalThis.hints = showRepairAssistHints;', context);
  const corrections = [
    { model: 'A', dim: 'alignment', direction: '偏低' },
    { model: 'A', dim: 'quality', direction: '偏高' },
    { model: 'B', dim: 'alignment', direction: '偏低' },
  ];
  const grouped = context.group(corrections);
  assert.equal(grouped.get('A').length, 2);
  assert.equal(grouped.get('B').length, 1);
  assert.equal(context.hints(corrections).size, 2);
  assert.deepEqual(hintNodes.map((entry) => `${entry.model}:${entry.node.textContent}`), [
    'A:偏低 · 原 2 分 · 参考 7 分',
    'A:偏高 · 原 2 分 · 原分与意见不符，请核对',
    'B:偏低 · 原 2 分 · 参考 7 分',
  ]);
});

test('repair assistant combines navigation with comparison without scoring actions', () => {
  const assistant = section('  function mountRepairAssistant(', '  const HUMAN_KEY =');
  assert.match(assistant, /data-repair-act="read"[^>]*>解析<\/button>/);
  assert.match(assistant, /data-repair-model/);
  assert.match(assistant, /modelButton\.textContent = id/);
  assert.match(source, /querySelector\('\[data-repair-controls\]'\)\.appendChild\(controls\)/);
  assert.doesNotMatch(assistant, /siriser-repair-fab|data-repair-act="auto"|data-repair-act="close"/);
  assert.doesNotMatch(assistant, /SiriserAPI|runAutoScore|applyScores|fireClick|submitRepairTask/);
  assert.match(section('  async function resumeAutomationOnPage(', '  if (document.readyState'), /stopRepairMode\('自动返修已暂缓/);
});

test('repair comparison follows the manually selected score model only after parsing', () => {
  const handlers = {};
  const optionA = { contains: (node) => node.model === 'A' };
  const optionB = { contains: (node) => node.model === 'B' };
  const groups = new Map([
    ['A', { alignment: { options: { 1: optionA } } }],
    ['B', { quality: { options: { 3: optionB } } }],
  ]);
  const selected = [];
  const context = {
    DIMS: ['alignment', 'quality'], collectScoreGroups: () => ({ groups }),
    document: { addEventListener: (name, fn) => { handlers[name] = fn; } },
    showRepairComparison: (id) => selected.push(id),
  };
  vm.runInNewContext('let _repairAssist = null;\n' +
    section('  function bindRepairScoreComparison(', '  function repairScoreAnchor(') +
    '\nglobalThis.activate = (state) => { _repairAssist = state; bindRepairScoreComparison(state); };', context);
  const state = {};
  context.activate(state);
  const eventFor = (model, isTrusted = true) => ({ isTrusted, target: { closest: () => ({ model, contains: () => false }) } });
  handlers.click(eventFor('A'));
  handlers.change(eventFor('B'));
  handlers.click(eventFor('A', false));
  handlers.click(eventFor('C'));
  assert.deepEqual(selected, ['A', 'B']);
});

test('repair comparison follows visible score rows in the scrolled panel', () => {
  const handlers = {};
  let frame;
  const option = (top, bottom) => ({ isConnected: true, getBoundingClientRect: () => ({ top, bottom, height: bottom - top }) });
  const a = option(80, 120);
  const b = option(440, 480);
  const unrelated = option(470, 490);
  const scroller = { contains: (node) => node === a || node === b,
    getBoundingClientRect: () => ({ top: 0, bottom: 600 }), closest: () => null };
  const groups = new Map([
    ['A', { alignment: { options: { 1: a } } }],
    ['B', { alignment: { options: { 1: b } } }],
  ]);
  const selected = [];
  const document = { addEventListener: (name, fn) => { handlers[name] = fn; }, body: {}, documentElement: {} };
  const context = { document, window: { innerHeight: 600 }, DIMS: ['alignment'],
    collectScoreGroups: () => ({ groups }), requestAnimationFrame: (fn) => { frame = fn; return 1; },
    showRepairComparison: (id, state) => { selected.push(id); state.compareModel = id; } };
  vm.runInNewContext('let _repairAssist = null;\n' +
    section('  function repairModelAtScrollCenter(', '  function repairScoreAnchor(') +
    '\nglobalThis.activate = (state) => { _repairAssist = state; bindRepairScoreComparison(state); };' +
    '\nglobalThis.atCenter = repairModelAtScrollCenter;', context);
  const state = {};
  context.activate(state);
  assert.equal(context.atCenter([{ option: unrelated, model: 'C' }, { option: a, model: 'A' }, { option: b, model: 'B' }], scroller), 'B');
  handlers.scroll({ target: scroller });
  frame();
  handlers.scroll({ target: scroller });
  frame();
  state.compareClosed = true;
  handlers.scroll({ target: scroller });
  assert.deepEqual(selected, ['B']);
});

test('repair comparison opens after parsing at the visible model and does not guess when none is visible', () => {
  const document = { body: {}, documentElement: {}, contains: () => true };
  const scroller = { parentElement: document.body, scrollHeight: 1200, clientHeight: 600,
    contains: () => true, getBoundingClientRect: () => ({ top: 0, bottom: 600 }) };
  const row = { parentElement: scroller, isConnected: true,
    getBoundingClientRect: () => ({ top: 270, bottom: 300, height: 30 }) };
  const opened = [];
  const context = { document, window: { innerHeight: 600 }, getComputedStyle: () => ({ overflowY: 'auto' }),
    showRepairComparison: (model) => opened.push(model) };
  vm.runInNewContext(section('  function repairModelAtScrollCenter(', '  function bindRepairScoreComparison(') +
    '\nglobalThis.openInitial = openInitialRepairComparison;', context);
  context.openInitial({ compareRows: [{ model: 'C', option: row }] });
  context.openInitial({ compareRows: [] });
  assert.deepEqual(opened, ['C', null]);
  assert.match(section('  function mountRepairAssistant(', '  const HUMAN_KEY ='), /openInitialRepairComparison\(_repairAssist\)/);
});

test('repair comparison starts independently and parsing does not clear its pictures', () => {
  const assistant = section('  function mountRepairAssistant(', '  const HUMAN_KEY =');
  assert.match(assistant, /startRepairComparisonAutoRefresh\(\)/);
  assert.doesNotMatch(assistant, /showRepairComparison\(null, loadingState, true\)/);
  assert.match(assistant, /_repairClosed\) _repairAssist\.compareClosed = true/);
});

test('repair comparison updates after a new package without showing the previous package', () => {
  let timer;
  let identity = 'old';
  const actions = [];
  const location = { href: 'https://example.test/task/one' };
  const context = {
    location, window: { setInterval: (fn) => { timer = fn; } },
    document: { getElementById: () => null }, isLabelingTaskPage: () => true,
    repairComparisonPageIdentity: () => identity, clearRepairAssistHints: () => {}, log: () => {},
    bindRepairScoreComparison: (state) => { state.compareRows = []; },
    openInitialRepairComparison: () => actions.push(`show:${identity}`),
    showRepairComparison: (id, state, loading) => actions.push(loading ? 'clear-old' : `show:${id}`),
  };
  vm.runInNewContext('let _repairAssist = null;\n' +
    section('  function startRepairComparisonAutoRefresh(', '  function repairScoreAnchor(') +
    '\nglobalThis.start = startRepairComparisonAutoRefresh;', context);
  context.start();
  location.href = 'https://example.test/task/two';
  timer();
  timer();
  identity = 'new';
  timer();
  assert.deepEqual(actions, ['show:old', 'clear-old', 'show:new']);
});

test('repair strip drag stays on screen and does not involve its action buttons', () => {
  const events = {};
  let captured = null;
  const grip = {
    addEventListener: (name, handler) => { events[name] = handler; },
    setPointerCapture: (id) => { captured = id; },
    hasPointerCapture: (id) => captured === id,
    releasePointerCapture: () => { captured = null; },
  };
  const root = {
    style: {}, querySelector: () => grip,
    getBoundingClientRect: () => ({ left: parseFloat(root.style.left) || 8, top: parseFloat(root.style.top) || 100, width: 50, height: 300 }),
  };
  const win = { innerWidth: 500, innerHeight: 600, events: {}, addEventListener(name, handler) { this.events[name] = handler; } };
  const context = { window: win, globalThis: {} };
  vm.runInNewContext(section('  function bindRepairPanelDrag(', '  function mountRepairAssistant(') + '\nglobalThis.bind = bindRepairPanelDrag;', context);
  context.globalThis.bind(root);
  const event = (x, y) => ({ button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
  events.pointerdown(event(10, 110));
  events.pointermove(event(1000, 1000));
  assert.equal(root.style.left, '442px');
  assert.equal(root.style.top, '292px');
  events.pointerup(event(1000, 1000));
  events.pointermove(event(0, 0));
  assert.equal(root.style.left, '442px');
  win.innerWidth = 400;
  win.events.resize();
  assert.equal(root.style.left, '342px');
});

test('repair navigation jumps to the left image and right score without smooth scrolling or rescanning', () => {
  const moves = [];
  const image = { isConnected: true, scrollIntoView: (opts) => moves.push(['image', opts.behavior, opts.block]) };
  const score = {
    isConnected: true,
    classList: { add: () => {} },
    scrollIntoView: (opts) => moves.push(['score', opts.behavior, opts.block]),
  };
  const context = {
    qa: () => [],
    showRepairAssistHints: () => { throw new Error('should reuse cached score rows'); },
    collectRepairImageAnchors: () => { throw new Error('should reuse cached images'); },
  };
  vm.runInNewContext(section('  function jumpToRepairModel(', '  function mountRepairAssistant(') +
    '\nglobalThis.jump = jumpToRepairModel;', context);
  const state = { scoreAnchors: new Map([['S', score]]), imageAnchors: new Map([['S', image]]) };
  assert.equal(context.jump('S', state), true);
  assert.deepEqual(JSON.parse(JSON.stringify(moves)), [
    ['image', 'instant', 'start'], ['score', 'instant', 'center'],
  ]);
});

test('repair image mapping uses nearby image DOM without image compression', () => {
  const image = { name: 'S-image' };
  const parent = { parentElement: null };
  const label = { parentElement: parent };
  const context = {
    HEU: {}, getAreas: () => ({ content: {} }),
    findTextLabels: () => [{ raw: '模型-S', el: label }],
    extractModelId: () => 'S',
    qa: () => [image], isRealGenImg: () => true, isBrokenModelImg: () => false,
  };
  vm.runInNewContext(section('  function collectRepairImageAnchors(', '  function jumpToRepairModel(') +
    '\nglobalThis.collect = collectRepairImageAnchors;', context);
  assert.equal(context.collect(['S']).get('S'), image);
});

test('repair comparison matches each visible model image without borrowing a neighbor', () => {
  const rect = (top, bottom, left = 50, right = 450) => ({ top, bottom, left, right, height: bottom - top });
  const dLabel = { getBoundingClientRect: () => rect(80, 100, 10, 45) };
  const eLabel = { getBoundingClientRect: () => rect(230, 250, 10, 45) };
  const fLabel = { getBoundingClientRect: () => rect(550, 570, 10, 45) };
  const broken = { closest: () => null, getBoundingClientRect: () => rect(85, 95), broken: true };
  const imageE = { closest: () => null, getBoundingClientRect: () => rect(100, 400) };
  const imageF = { closest: () => null, getBoundingClientRect: () => rect(410, 710) };
  const ref = { closest: () => null, getBoundingClientRect: () => rect(-400, -100) };
  const context = { HEU: {}, getAreas: () => ({ content: {} }),
    findTextLabels: () => [{ raw: 'D', el: dLabel }, { raw: 'E', el: eLabel }, { raw: 'F', el: fLabel }],
    extractModelId: (raw) => raw, qa: () => [ref, broken, imageE, imageF],
    isRealGenImg: (img) => !img.broken, isBrokenModelImg: (img) => !!img.broken };
  vm.runInNewContext(section('  function findRepairComparisonImage(', '  function showRepairComparison(') +
    '\nglobalThis.findImage = findRepairComparisonImage;', context);
  assert.equal(context.findImage('D', ref), broken);
  assert.equal(context.findImage('E', ref), imageE);
  assert.equal(context.findImage('F', ref), imageF);
  assert.equal(context.findImage('G', ref), null);
});

test('repair communication closes its own dialog before continuing', async () => {
  const close = {
    isConnected: true, getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 10, right: 40, top: 10, bottom: 40 }),
  };
  const dialog = {
    isConnected: true, getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600 }),
  };
  let closeCount = 0;
  const context = {
    window: { innerWidth: 1000, innerHeight: 800 },
    findTextButton: () => ({ click() {} }),
    qa: (selector, root) => root === dialog ? [close] : [dialog],
    visible: () => true,
    textOf: (el) => el === dialog ? '返修沟通 模型-B、编辑指令遵循、偏低' : '关闭',
    parseRepairFeedback: () => [{ model: 'B', dim: 'alignment', direction: '偏低' }],
    fireClick: (el) => { assert.equal(el, close); closeCount++; dialog.isConnected = false; },
    sleep: async () => {},
  };
  vm.runInNewContext(section('  function findRepairDialogClose(', '  function applyRepairCorrections(') +
    '\nglobalThis.read = readRepairCommunication;', context);
  const result = await context.read();
  assert.equal(closeCount, 1);
  assert.equal(result.corrections[0].model, 'B');
});

test('repair drawer close lookup ignores the comparison window close button', () => {
  const body = {};
  const compareClose = {
    closest: (selector) => selector.includes('#siriser-repair-compare') ? {} : null,
    getAttribute: () => '', getBoundingClientRect: () => ({ left: 690, right: 730, top: 35, bottom: 65 }),
  };
  const siteClose = {
    closest: () => null, getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 900, right: 940, top: 35, bottom: 65 }),
  };
  const dialog = { parentElement: body,
    getBoundingClientRect: () => ({ left: 600, right: 1000, top: 20, bottom: 700 }) };
  const context = {
    document: { body }, window: { innerWidth: 1000, innerHeight: 800 }, visible: () => true,
    textOf: () => '关闭', qa: (selector, root) => root === dialog ? [] : [compareClose, siteClose],
    findTextLabels: () => [], log() {},
  };
  vm.runInNewContext(section('  function findRepairDialogClose(', '  async function readRepairCommunication(') +
    '\nglobalThis.findClose = findRepairDialogClose;', context);
  assert.equal(context.findClose(dialog), siteClose);
});

test('repair drawer close button can be a sibling of the selected message container', async () => {
  const close = {
    isConnected: true, getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 760, right: 800, top: 25, bottom: 55 }),
  };
  const parent = { parentElement: null };
  const dialog = {
    isConnected: true, parentElement: parent, getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 640, right: 900, top: 100, bottom: 700 }),
  };
  let closeCount = 0;
  const context = {
    window: { innerWidth: 1000, innerHeight: 800 },
    document: { body: {} },
    findTextButton: () => ({ click() {} }),
    qa: (selector, root) => root === dialog ? [] : root === parent ? [close] : [dialog],
    visible: () => true,
    textOf: (el) => el === dialog ? '返修沟通 模型-A、编辑指令遵循、偏低' : '关闭',
    parseRepairFeedback: () => [{ model: 'A', dim: 'alignment', direction: '偏低' }],
    fireClick: (el) => { assert.equal(el, close); closeCount++; dialog.isConnected = false; },
    sleep: async () => {},
  };
  vm.runInNewContext(section('  function findRepairDialogClose(', '  function applyRepairCorrections(') +
    '\nglobalThis.read = readRepairCommunication;', context);
  const result = await context.read();
  assert.equal(closeCount, 1);
  assert.equal(result.corrections[0].model, 'A');
});

test('repair drawer can close through a plain right-corner text control', async () => {
  const closeText = {
    isConnected: true,
    getBoundingClientRect: () => ({ left: 920, right: 965, top: 35, bottom: 65, width: 45, height: 30 }),
  };
  const dialog = {
    isConnected: true, parentElement: null, getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 600, right: 1000, top: 20, bottom: 700 }),
  };
  const context = {
    window: { innerWidth: 1000, innerHeight: 800 }, document: { body: {} },
    findTextButton: () => ({ click() {} }),
    qa: (selector) => selector.startsWith('[role="dialog"]') ? [dialog] : [],
    findTextLabels: () => [{ el: closeText }],
    visible: () => true,
    textOf: (el) => el === dialog ? '返修沟通 模型-A、编辑指令遵循、偏低' : '关闭',
    parseRepairFeedback: () => [{ model: 'A', dim: 'alignment', direction: '偏低' }],
    fireClick: (el) => { assert.equal(el, closeText); dialog.isConnected = false; },
    sleep: async () => {}, log() {},
  };
  vm.runInNewContext(section('  function findRepairDialogClose(', '  function applyRepairCorrections(') +
    '\nglobalThis.read = readRepairCommunication;', context);
  const result = await context.read();
  assert.equal(result.corrections[0].model, 'A');
});

test('repair dialog does not count a disappearing close button as a closed drawer', async () => {
  const close = {
    isConnected: true, getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 760, right: 800, top: 25, bottom: 55 }),
    click() { this.isConnected = false; },
  };
  const dialog = {
    isConnected: true, parentElement: null, getAttribute: () => '',
    getBoundingClientRect: () => ({ left: 640, right: 900, top: 100, bottom: 700 }),
  };
  const context = {
    window: { innerWidth: 1000, innerHeight: 800 }, document: { body: {} },
    findTextButton: () => ({ click() {} }),
    qa: (selector, root) => root === dialog ? [close] : [dialog],
    visible: () => true,
    textOf: (el) => el === dialog ? '返修沟通 模型-A、编辑指令遵循、偏低' : '关闭',
    parseRepairFeedback: () => [{ model: 'A', dim: 'alignment', direction: '偏低' }],
    sleep: async () => {},
  };
  vm.runInNewContext(section('  function findRepairDialogClose(', '  function repairAdjustedScore(') +
    '\nglobalThis.read = readRepairCommunication;', context);
  await assert.rejects(context.read(), /弹窗没有关闭/);
  const assisted = await context.read({ assistOnly: true });
  assert.equal(assisted.closeUnconfirmed, true);
  assert.equal(assisted.corrections[0].model, 'A');
  assert.match(assisted.text, /模型-A/);
});

test('repair edits only named model dimensions and leaves other scores intact', async () => {
  const selected = { B: { alignment: 4, preservation: 7 }, Q: { alignment: 9, preservation: 8 } };
  const clicks = [];
  const groups = new Map(['B', 'Q'].map((model) => [model, Object.fromEntries(
    ['alignment', 'preservation'].map((dim) => [dim, { options: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [n, {
        model, dim, n, tagName: 'LABEL', getAttribute: () => '',
        querySelector: () => ({ checked: selected[model][dim] === n }),
        classList: { contains: () => false },
      }]),
    ) }]),
  )]));
  const context = {
    collectScoreGroups: () => ({ groups }),
    pickTargetEl: (options, n) => options[n],
    fireClick: (target) => { selected[target.model][target.dim] = target.n; clicks.push(`${target.model}:${target.dim}`); },
    sleep: async () => {}, log() {}, setStatusDock() {},
  };
  vm.runInNewContext(section('  function repairAdjustedScore(', '  async function autoOneTask(') +
    '\nglobalThis.apply = applyRepairFeedbackToExistingScores;', context);
  const changes = await context.apply([
    { model: 'B', dim: 'alignment', direction: '偏低' },
    { model: 'Q', dim: 'preservation', direction: '偏高' },
  ]);
  assert.equal(changes.length, 2);
  assert.deepEqual(clicks, ['B:alignment', 'Q:preservation']);
  assert.deepEqual(selected, { B: { alignment: 8, preservation: 7 }, Q: { alignment: 9, preservation: 4 } });
});

test('repair submission disables auto claim and waits for confirmed navigation', async () => {
  const checkbox = { checked: true };
  const label = { innerText: '提交后自动领取下一题', querySelector: () => checkbox };
  const location = { href: 'https://www.siriser.com/siriser/labeling/task?id=one' };
  let submitted = 0;
  let saved;
  const context = {
    location, visible: () => true, textOf: (el) => el.innerText || '',
    qa: (selector) => selector.startsWith('label') ? [label] : [],
    fireClick: () => { checkbox.checked = false; },
    sleep: async () => {},
    findSiteButton: (re) => re.test('提交当前题') ? { click() { submitted++; location.href = 'https://www.siriser.com/siriser/mine'; } } : null,
    loadRepairState: async () => ({ on: true }),
    saveRepairState: async (state) => { saved = state; },
    log() {},
  };
  vm.runInNewContext(section('  function repairSubmitConfirmed(', '  function readPrompt(') +
    '\nglobalThis.submit = submitRepairTask;', context);
  assert.equal(await context.submit(), true);
  assert.equal(checkbox.checked, false);
  assert.equal(submitted, 1);
  assert.equal(saved.phase, 'submitting');
});

test('repair candidate search reaches page 66 and selects only rejected rows', async () => {
  let page = 0;
  const button = { innerText: '去修改' };
  const rejected = { innerText: '被驳回 去修改', getAttribute: () => 'repair-2', querySelector: () => null };
  const rows = Array.from({ length: 66 }, (_, index) => [index === 65 ? rejected : {
    innerText: `验收中 去修改 ${index + 1}`,
    getAttribute: () => `normal-${index + 1}`,
    querySelector: () => null,
  }]);
  const next = { click() { page++; } };
  const host = { classList: { contains: () => false }, getAttribute: () => null, querySelector: () => next };
  const context = {
    location: { pathname: '/siriser/mine' }, document: { body: { innerText: '' } },
    textOf: (el) => el?.innerText || '', visible: () => true,
    qa: (selector, root) => {
      if (selector === 'tr' || selector === 'tbody tr') return rows[page];
      if (selector === 'a,button,[role=button]') return root === rejected ? [button] : [];
      if (selector.startsWith('.ant-pagination-next')) return page < 65 ? [host] : [];
      return [];
    },
    q: () => ({ innerText: String(page + 1) }), sleep: async () => {}, setStatusDock() {},
  };
  vm.runInNewContext(section('  function isLabelingTaskPage(', '  // ── 定时自动停止：独立 storage key') +
    '\nglobalThis.select = selectRepairCandidate;', context);
  const candidate = await context.select([]);
  assert.equal(candidate.key, 'repair-2');
  assert.equal(candidate.button, button);
  assert.equal(page, 65);
});

test('site submit button lookup excludes the extension result panel', () => {
  const pluginButton = { innerText: '提交当前题', value: '', closest: () => ({ id: 'siriser-result' }) };
  const siteButton = { innerText: '提交当前题', value: '', closest: () => null };
  const context = {
    qa: () => [pluginButton, siteButton], visible: () => true,
    textOf: (el) => el.innerText,
  };
  vm.runInNewContext(section('  function findSiteButton(', '  let _lastSubmitAt') +
    '\nglobalThis.findSiteButton = findSiteButton;', context);
  assert.equal(context.findSiteButton(/^提交当前题$/), siteButton);
});
