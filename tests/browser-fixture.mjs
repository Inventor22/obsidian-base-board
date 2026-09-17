import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";
import { build } from "esbuild";

const [fixtureFlag, fixtureVault] = process.argv.slice(2);
if (fixtureFlag && (fixtureFlag !== "--vault" || !fixtureVault))
  throw new Error("Usage: node tests/browser-fixture.mjs [--vault <vault-path>]");
let vaultGraph = null;
if (fixtureVault) {
  const base = load(await readFile(path.join(fixtureVault, "Tasks/Tasks.base"), "utf8"));
  const view = base.views.find(candidate => candidate.type === "graph");
  if (base.filters || JSON.stringify([...(view.filters?.or ?? [])].sort()) !== JSON.stringify(["!graph_order.isEmpty()", "!kanban_order.isEmpty()"]))
    throw new Error("Vault Graph query changed; the fixture selection must be updated.");
  const notes = [];
  const properties = ["title", "status", "type", "kind", "id", "graph_order", "kanban_order", "graph_collapsed", "graph_locked", "workflow", "executor", "autonomy", "parent", "depends_on", "rollup_to", "compensates", "breaks_to", "restarts_to", "effecting"];
  const nonempty = value => value !== undefined && value !== null && value !== "";
  const visit = async folder => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) { await visit(filename); continue; }
      if (!entry.name.endsWith(".md")) continue;
      const text = await readFile(filename, "utf8");
      const header = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!header) continue;
      const metadata = load(header[1]);
      if (!metadata || (!nonempty(metadata.graph_order) && !nonempty(metadata.kanban_order))) continue;
      notes.push({ path: path.relative(fixtureVault, filename).replaceAll("\\", "/"), properties: Object.fromEntries(properties.filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]])) });
    }
  };
  await visit(fixtureVault);
  vaultGraph = JSON.stringify({ notes, settings: { graphRoot: view.graphRoot, graphOverviewExpanded: view.graphOverviewExpanded ?? [] } });
}

const obsidian = String.raw`
import { createElement, icons } from 'lucide';

export class Value {
  constructor(value) { this.value = value; }
  toString() { return String(this.value); }
  isTruthy() { return Boolean(this.value); }
  renderTo(element) { element.createEl('strong', { text: this.toString() }); }
}
export class BooleanValue extends Value {}
export class NumberValue extends Value {}
export class NullValue extends Value { constructor() { super(null); } }
export class DateValue extends Value { relative() { return this.toString(); } }
export class LinkValue extends Value {}
export class ListValue extends Value {
  length() { return this.value.length; }
  get(index) { return new Value(this.value[index]); }
}
export class TFile {
  constructor(path = '') {
    this.path = path; this.basename = path.split('/').pop().replace(/\.md$/, '');
    this.extension = path.split('.').pop();
    this.stat = { ctime: Date.now(), mtime: Date.now() };
  }
}
export class BasesView {
  constructor(controller) { Object.assign(this, controller); }
  registerDomEvent(element, name, handler) { element.addEventListener(name, handler); }
  registerEvent() {}
  register() {}
}
export class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = document.createElement('div');
    this.modalEl = this.containerEl;
    this.contentEl = document.createElement('div');
    this.containerEl.append(this.contentEl);
  }
  open() {
    window.testModalOpenCount = (window.testModalOpenCount ?? 0) + 1;
    if (this.snapshot) {
      this.containerEl.className = 'fixture-recorded-modal';
      this.containerEl.setAttribute('role', 'dialog');
      this.containerEl.setAttribute('aria-label', 'Recorded graph item');
      this.onOpen();
      document.body.append(this.containerEl);
      window.recordedModal = this;
    }
  }
  close() { this.containerEl.remove(); }
}
export class ButtonComponent {}
export class WorkspaceLeaf {}
export class Notice { constructor(message) { window.lastNotice = message; } }
export class Setting {}
export class Menu {
  constructor() { this.items = []; }
  addItem(callback) {
    const values = {};
    const item = new Proxy({}, { get: (_, name) => value => { values[name] = value; return item; } });
    callback(item);
    this.items.push(values);
  }
  addSeparator() {}
  showAtMouseEvent(event) { this.showAtPosition({ x: event.clientX, y: event.clientY }); }
  showAtPosition(point) {
    window.closeFixtureMenu?.();
    const menu = document.body.createDiv({ cls: 'fixture-menu', attr: { role: 'menu' } });
    Object.assign(menu.style, { position: 'fixed', zIndex: '1000', width: '280px', maxHeight: '320px', overflowY: 'auto', padding: '4px', background: 'var(--background-primary)', border: '1px solid var(--background-modifier-border)', boxShadow: '0 4px 16px #0003' });
    menu.style.left = Math.min(point.x, window.innerWidth - 290) + 'px';
    menu.style.top = Math.min(point.y, window.innerHeight - 340) + 'px';
    const close = () => {
      menu.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
    };
    const outside = event => { if (!menu.contains(event.target)) close(); };
    const escape = event => { if (event.key === 'Escape') close(); };
    for (const item of this.items) {
      const button = menu.createEl('button', { attr: { type: 'button', role: 'menuitem' } });
      Object.assign(button.style, { display: 'flex', alignItems: 'center', gap: '6px', width: '100%', padding: '6px', textAlign: 'left', border: '0', background: 'transparent', color: 'var(--text-normal)' });
      if (item.setIcon) setIcon(button.createSpan(), item.setIcon);
      button.createSpan({ text: item.setTitle ?? '' });
      if (item.setChecked) setIcon(button.createSpan(), 'lucide-check');
      button.disabled = item.setDisabled === true;
      button.addEventListener('click', event => { close(); item.onClick?.(event); });
    }
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.closeFixtureMenu = close;
  }
}
export const Platform = { isMobile: false };
export const Keymap = { isModEvent: event => event.ctrlKey || event.metaKey ? 'tab' : false };
export const MarkdownRenderer = { render: async () => {} };
export class MarkdownView {}
export function setIcon(element, name) {
  element.dataset.icon = name;
  const iconName = name.replace(/^lucide-/, '').split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  const icon = icons[iconName];
  if (!icon) throw new Error('Unknown Lucide icon: ' + name);
  element.replaceChildren(createElement(icon, { class: 'svg-icon', 'aria-hidden': 'true' }));
}
export function setTooltip(element, text) { element.title = text; }
`;

const client = String.raw`
import { KanbanView } from './src/kanban-view.ts';
import { TimelineView } from './src/timeline-view.ts';
import { GraphView } from './src/graph-view.ts';
import { recordGraphObservation, parseGraphHistory } from './src/graph-history.ts';
import { TFile, Value, NullValue, ListValue } from 'obsidian';

globalThis.activeDocument = document;
globalThis.activeWindow = window;
const configure = (element, options = {}) => {
  if (typeof options === 'string') element.className = options;
  else {
    if (options.cls) element.className = options.cls;
    if (options.text !== undefined) element.textContent = options.text;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
  }
  return element;
};
Object.assign(Element.prototype, {
  createEl(tag, options) { const element = configure(document.createElement(tag), options); this.append(element); return element; },
  createDiv(options) { return this.createEl('div', options); },
  createSpan(options) { return this.createEl('span', options); },
  empty() { this.replaceChildren(); },
  setText(text) { this.textContent = text; },
  setAttr(name, value) { this.setAttribute(name, value); },
  getAttr(name) { return this.getAttribute(name); },
  addClass(...names) { this.classList.add(...names); },
  removeClass(...names) { this.classList.remove(...names); },
  hasClass(name) { return this.classList.contains(name); },
  instanceOf(type) { return this instanceof type; },
  toggleClass(name, value) { this.classList.toggle(name, value); },
  detach() { this.remove(); },
});

const properties = new Map([
  ['Scope.md', { title: 'Work scope', kind: 'group' }],
  ['Ring.md', { title: 'Release validation', kind: 'process', rollup_to: ['[[Scope]]'], status: 'In Progress', kanban_order: 1 }],
  ['Enable.md', { title: 'Enable feature', parent: '[[Ring]]', status: 'Completed', kanban_order: 2 }],
  ['Verify.md', { title: 'Verify rollout', parent: '[[Ring]]', depends_on: ['[[Enable]]'], status: 'Awaiting', kanban_order: 3, cover: location.origin + '/cover.png', tags: ['repo/core'], score: 'Formula result' }],
  ['Disable.md', { title: 'Disable feature', parent: '[[Ring]]', compensates: ['[[Enable]]'], status: 'Planned', kanban_order: 4 }],
  ['Impact.md', { title: 'Adoption metric', parent: '[[Ring]]', kind: 'impact', status: 'Failed', kanban_order: 5 }],
  ['Unassigned.md', { title: 'Unassigned task', kanban_order: 6 }],
]);
for (let index = 0; index < 12; index += 1) {
  properties.set('Work ' + index + '.md', { title: 'Work item ' + index, status: 'In Progress', kanban_order: index + 10 });
}
const files = [...properties.keys()].map(path => new TFile(path));
const configValues = new Map([
  ['boardColumns', ['In Progress', 'Awaiting', 'Completed', 'Blocked', 'Flighting', '']],
  ['order', ['file.name', 'note.status', 'formula.score']],
  ['wipLimits', { 'In Progress': 2 }],
]);
const config = {
  name: 'Verification', groupBy: { property: 'note.status' },
  get: key => configValues.get(key),
  set: (key, value) => configValues.set(key, value),
  getOrder: () => configValues.get('order'),
  getDisplayName: key => key,
};
const entries = files.map(file => ({
  file,
  getValue: key => {
    const value = key === 'file.name' ? file.basename : properties.get(file.path)[key.replace(/^(note|formula)\./, '')];
    return value == null ? new NullValue() : Array.isArray(value) ? new ListValue(value) : new Value(value);
  },
}));
const app = {
  vault: {
    getAbstractFileByPath: path => files.find(file => file.path === path),
    getMarkdownFiles: () => files,
    getResourcePath: file => file.path,
  },
  metadataCache: { getFileCache: file => ({ frontmatter: properties.get(file.path) }), getFirstLinkpathDest: () => null },
  fileManager: {
    processFrontMatter: async (file, update) => { update(properties.get(file.path)); refresh(); },
    renameFile: async (file, path) => { const values = properties.get(file.path); properties.delete(file.path); file.path = path; file.basename = path.replace(/\.md$/, ''); properties.set(path, values); refresh(); },
  },
  workspace: { trigger() {}, iterateAllLeaves() {}, getMostRecentLeaf() { return null; }, getLeaf() { return { openFile() {} }; } },
};
const plugin = {
  data_: { transitionHistory: { enabled: true, propertyName: 'status_history' }, timeline: { weekStartDay: 1 }, graphHistories: {} },
  getColumnConfig: () => null, saveColumnConfig: async () => {},
  getRecordedGraphHistory(id) { const saved = this.data_.graphHistories[id]; return saved ? parseGraphHistory(saved) : null; },
  async recordGraphHistory(id, nodes, at, session) {
    const result = recordGraphObservation(this.getRecordedGraphHistory(id), nodes, at, session);
    this.data_.graphHistories[id] = result.history;
    return result.history;
  },
  async finishGraphObservation(id, at) {
    const history = this.getRecordedGraphHistory(id);
    if (history) this.data_.graphHistories[id] = { ...history, observedThrough: Math.max(at, history.observedThrough) };
  },
};
const host = document.querySelector('#host');
const controller = { app, config, data: { data: entries, groupedData: [] } };
const view = new KanbanView(controller, host, plugin);
function refresh() {
  const grouped = new Map();
  for (const entry of entries) {
    const status = properties.get(entry.file.path).status;
    if (!grouped.has(status)) grouped.set(status, []);
    grouped.get(status).push(entry);
  }
  view.data = { data: entries, groupedData: [...grouped].map(([key, values]) => ({ key: key == null ? new NullValue() : new Value(key), entries: values })) };
  view.onDataUpdated();
}
refresh();
view.render();

window.baseboardTest = {
  view, properties, configValues, refresh,
  showBoard() { document.querySelector('#timeline').hidden = true; host.hidden = false; view.render(); },
  showTimeline(stop) {
    const durations = { '1w': 7, '1mo': 31, '3mo': 93, '6mo': 186, '1y': 365, '5y': 1825 };
    host.hidden = true;
    const surface = document.querySelector('#timeline'); surface.hidden = false; surface.empty();
    const timeline = Object.assign(Object.create(TimelineView.prototype), { app, plugin, config, zoomDurationMs: durations[stop] * 86400000 });
    const start = new Date(2026, 5, 1); const end = new Date(start.getTime() + timeline.zoomDurationMs);
    const content = surface.createDiv({ cls: 'base-board-timeline-content' });
    const width = timeline.getTimelineWidth({ start, end }, surface);
    timeline.renderRuler(content, { start, end }, width);
    return { stop, lines: content.querySelectorAll('.base-board-timeline-grid-line').length, labels: [...content.querySelectorAll('.base-board-timeline-label-row')].map(row => row.textContent) };
  },
};

const graphProperties = new Map([
  ['My work.md', { title: 'My work', kind: 'group' }],
  ['Release.md', { title: 'Release rollout', type: 'release', kind: 'process', rollup_to: ['[[My work]]'], status: 'Completed' }],
  ['Enable.md', { title: 'Enable feature', parent: '[[Release]]', status: 'Completed' }],
  ['Validate.md', { title: 'Validate rollout', parent: '[[Release]]', status: 'Awaiting', depends_on: ['[[Enable]]'], executor: 'agent' }],
  ['Rollback.md', { title: 'Disable feature', parent: '[[Release]]', status: 'Planned', compensates: ['[[Enable]]'] }],
  ['Impact.md', { title: 'Adoption metric', kind: 'impact', parent: '[[Release]]', status: 'Failed' }],
  ['Delivery.md', { title: 'Implementation', type: 'feature', kind: 'process', rollup_to: ['[[My work]]'], executor: 'mixed' }],
  ['Build.md', { title: 'Build and test', parent: '[[Delivery]]', kind: 'process', executor: 'agent' }],
  ['Design.md', { title: 'Design changes', parent: '[[Build]]', status: 'Completed' }],
  ['Code.md', { title: 'Implement changes', parent: '[[Build]]', status: 'In Progress' }],
  ['Tests.md', { title: 'Run verification', parent: '[[Build]]', status: 'Awaiting' }],
  ['Docs.md', { title: 'Documentation', parent: '[[Delivery]]', status: 'Completed' }],
  ['Reliability.md', { title: 'Service reliability', type: 'feature', kind: 'process', rollup_to: ['[[My work]]'] }],
  ['Investigate.md', { title: 'Investigate failures', parent: '[[Reliability]]', status: 'Completed' }],
  ['Repair.md', { title: 'Repair deployment', parent: '[[Reliability]]', status: 'Blocked', executor: 'agent' }],
  ['Followup.md', { title: 'Verify recovery', parent: '[[Reliability]]', status: 'Planned', depends_on: ['[[Repair]]'] }],
  ['Research.md', { title: 'Research and findings', type: 'research', kind: 'process', rollup_to: ['[[My work]]'] }],
  ['Compare.md', { title: 'Compare alternatives', parent: '[[Research]]', status: 'Completed' }],
  ['Summarize.md', { title: 'Summarize findings', parent: '[[Research]]', status: 'Completed' }],
]);
const graphFiles = [...graphProperties.keys()].map(path => new TFile(path));
const graphEntries = graphFiles.map(file => ({ file, getValue: key => {
  const value = graphProperties.get(file.path)[key.replace(/^note\./, '')];
  return value == null ? new NullValue() : new Value(value);
} }));
const graphSettings = new Map([
  ['graphNodePositions', { 'Delivery.md': { x: 1250, y: 550 }, 'Release.md': { x: -450, y: 200 } }],
]);
const graphConfig = {
  name: 'Graph verification', groupBy: { property: 'note.status' },
  get: key => graphSettings.get(key),
  set: (key, value) => {
    graphSettings.set(key, value);
    queueMicrotask(() => { if (!graphHost.hidden) graphView.onDataUpdated(); });
  },
};
let graphNoteWrites = 0;
const graphApp = {
  ...app,
  vault: { ...app.vault, getMarkdownFiles: () => graphFiles, getAbstractFileByPath: path => graphFiles.find(file => file.path === path) },
  metadataCache: { getFileCache: file => ({ frontmatter: graphProperties.get(file.path) }) },
  fileManager: { processFrontMatter: async (file, update) => { graphNoteWrites += 1; update(graphProperties.get(file.path)); graphView.onDataUpdated(); } },
};
const graphHost = document.querySelector('#graph-host');
const graphView = new GraphView({ app: graphApp, config: graphConfig, data: { data: graphEntries } }, graphHost, plugin);
window.graphTest = {
  view: graphView, properties: graphProperties, settings: graphSettings,
  get noteWrites() { return graphNoteWrites; },
  async loadVaultGraph() {
    const response = await fetch('/vault-graph.json');
    if (!response.ok) throw new Error('Start the fixture with --vault to load a read-only graph snapshot.');
    const snapshot = await response.json();
    graphProperties.clear(); graphFiles.length = 0; graphEntries.length = 0;
    for (const note of snapshot.notes) {
      graphProperties.set(note.path, note.properties);
      const file = new TFile(note.path);
      graphFiles.push(file);
      graphEntries.push({ file, getValue: key => {
        const value = graphProperties.get(file.path)[key.replace(/^note\./, '')];
        return value == null ? new NullValue() : new Value(value);
      } });
    }
    for (const [key, value] of Object.entries(snapshot.settings)) graphSettings.set(key, value);
    return { total: graphFiles.length, root: graphSettings.get('graphRoot') };
  },
  show() { host.hidden = true; document.querySelector('#timeline').hidden = true; graphHost.hidden = false; graphView.onDataUpdated(); },
  seedOverviewPortfolio() {
    const add = (path, values) => {
      if (graphProperties.has(path)) return;
      graphProperties.set(path, values);
      const file = new TFile(path);
      graphFiles.push(file);
      graphEntries.push({ file, getValue: key => {
        const value = graphProperties.get(file.path)[key.replace(/^note\./, '')];
        return value == null ? new NullValue() : new Value(value);
      } });
    };
    add('Person.md', { title: 'Dustin', kind: 'group' });
    add('Career.md', { title: 'Career', kind: 'group', rollup_to: ['[[Person]]'] });
    graphProperties.get('My work.md').title = 'Msft';
    graphProperties.get('My work.md').rollup_to = ['[[Career]]'];
    const names = ['RTPv3', 'DedicatedHost', 'PS Partition', 'Worker Proxy', 'Feature flag rollout', 'Telemetry', 'Automation', 'Review backlog'];
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      add(name + '.md', { title: name, kind: 'process', rollup_to: ['[[My work]]'], type: 'feature' });
      for (let step = 0; step < (index % 3) + 2; step += 1) {
        add(name + ' step ' + step + '.md', { title: step === 0 ? 'Implementation' : 'Verification ' + step, parent: '[[' + name + ']]', status: ['In Progress', 'Completed', 'Awaiting', 'Planned'][(index + step) % 4], executor: step % 2 ? 'agent' : 'human' });
      }
    }
    add('Iteration.md', { title: 'Iteration 3', kind: 'process', parent: '[[PS Partition]]' });
    add('Dev.md', { title: 'dev', kind: 'process', parent: '[[Iteration]]' });
    add('Deep task.md', { title: 'Validate partition skip behavior', parent: '[[Dev]]', status: 'In Progress', executor: 'agent' });
    add('Detached initiative.md', { title: 'Detached initiative', kind: 'process' });
    add('Detached step.md', { title: 'Review next steps', parent: '[[Detached initiative]]', status: 'Awaiting' });
    for (let index = 0; index < 28; index += 1) {
      add('Loose ' + index + '.md', { title: ['Investigate deployment behavior', 'Review configuration changes', 'Validate worker routing', 'Follow up on rollout'][index % 4] + ' ' + (index + 1), status: ['Planned', 'In Progress', 'Awaiting', 'Completed', 'Blocked'][index % 5] });
    }
    return { total: graphFiles.length, workstreams: 12, loose: 28 };
  },
  seedTemporalHistory() {
    const enabled = graphView.temporalRecordingEnabled;
    graphView.temporalRecordingEnabled = false;
    graphView.getGraphNodes();
    const current = graphView.temporalLiveNodes;
    const day = (offset) => { const date = new Date(); date.setDate(date.getDate() - offset); date.setHours(12,0,0,0); return date.getTime(); };
    const times = [day(5), day(4), day(3), day(2), day(1)];
    const excluded = new Set(['Research.md', 'Compare.md', 'Summarize.md', 'Docs.md']);
    const initial = current.filter(node => !excluded.has(node.path)).map(node =>
      ['Enable.md', 'Validate.md', 'Code.md'].includes(node.path) ? { ...node, status: 'Planned' } : node);
    const retired = { ...current.find(node => node.path === 'Compare.md'), key: 'path:Retired.md', path: 'Retired.md', title: 'Retired investigation', identities: ['retired'], parentKey: 'release', parentValue: '[[Release]]' };
    const first = [...initial, retired];
    const second = first.map(node => node.path === 'Enable.md' ? { ...node, status: 'Completed' } : node.path === 'Code.md' ? { ...node, status: 'In Progress' } : node);
    const third = [...second.map(node => node.path === 'Validate.md' ? { ...node, status: 'Awaiting' } : node), ...current.filter(node => ['Research.md', 'Compare.md', 'Summarize.md'].includes(node.path))];
    const fourth = [...third.filter(node => node.path !== 'Retired.md'), { ...current.find(node => node.path === 'Docs.md'), parentKey: 'release', parentValue: '[[Release]]' }];
    let history = recordGraphObservation(null, first, times[0], 'fixture-early').history;
    history = recordGraphObservation(history, second, times[1], 'fixture-early').history;
    history = recordGraphObservation(history, third, times[2], 'fixture-early').history;
    history = recordGraphObservation(history, third, times[2] + 3600000, 'fixture-early').history;
    history = recordGraphObservation(history, fourth, times[3], 'fixture-live').history;
    history = recordGraphObservation(history, current, times[4], 'fixture-live').history;
    graphSettings.set('graphRecordingId', 'graph-fixture');
    plugin.data_.graphHistories['graph-fixture'] = history;
    graphView.temporalSession = 'fixture-live';
    graphView.temporalHistory = null;
    graphView.temporalRecordingId = null;
    graphView.temporalRecordingEnabled = enabled;
    this.historyTimes = times;
    return times;
  },
  get recording() { return plugin.getRecordedGraphHistory(graphSettings.get('graphRecordingId')); },
};
`;

const output = await build({
  stdin: { contents: client, resolveDir: process.cwd(), sourcefile: "browser-fixture.js" },
  bundle: true,
  format: "iife",
  write: false,
  plugins: [{
    name: "obsidian-test-host",
    setup(builder) {
      builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: obsidian, loader: "js", resolveDir: process.cwd() }));
    },
  }],
});

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Base Board integration fixture</title><link rel="stylesheet" href="/styles.css"><style>
:root { --background-primary:#fff; --background-secondary:#f5f5f5; --background-secondary-alt:#eee; --background-modifier-border:#d5d5d5; --background-modifier-hover:#eee; --text-normal:#202020; --text-muted:#666; --text-faint:#888; --text-error:#bc3131; --interactive-accent:#267ca5; --text-on-accent:#fff; --font-ui-small:13px; --font-ui-smaller:11px; --font-semibold:600; --radius-s:4px; --radius-m:6px; --color-blue:#3977d4; --color-green:#378252; --color-purple:#8665b5; }
* { box-sizing:border-box; } body { margin:0; font:14px sans-serif; } #host,#graph-host { height:100vh; overflow:auto; } [hidden] { display:none !important; } .svg-icon { display:inline-block; width:14px; height:14px; } button,input { font:inherit; } #timeline { height:400px; position:relative; --timeline-label-width:240px; } .base-board-timeline-content { height:340px; } .fixture-recorded-modal { position:fixed; inset:100px 25%; padding:24px; background:white; box-shadow:0 0 0 100vmax #0006; z-index:100; overflow:auto; } </style></head><body><div id="host"></div><div id="graph-host" hidden></div><div id="timeline" class="base-board-timeline" hidden></div><script src="/fixture.js"></script></body></html>`;
const stylesheet = await readFile("styles.css", "utf8");
const cover = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6r1sAAAAASUVORK5CYII=", "base64");
const server = createServer((request, response) => {
  const routes = {
    "/": ["text/html", html],
    "/fixture.js": ["text/javascript", output.outputFiles[0].text],
    "/styles.css": ["text/css", stylesheet],
    "/cover.png": ["image/png", cover],
  };
  if (vaultGraph) routes["/vault-graph.json"] = ["application/json", vaultGraph];
  const route = routes[request.url];
  response.writeHead(route ? 200 : 404, { "Content-Type": route?.[0] ?? "text/plain" });
  response.end(route?.[1] ?? "Not found");
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Base Board verification: http://127.0.0.1:${server.address().port}`);
});