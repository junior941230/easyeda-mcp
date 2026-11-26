// 端對端自測：啟動真正的 MCP server（stdio），並在 vm 裡跑「已打包的」bridge 擴充，
// 搭配假的 eda 物件，確認 MCP 工具 → WebSocket → 擴充 → eda API → 回傳 的整條路徑。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';
import vm from 'node:vm';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// 49152 以上是 Windows 動態埠，固定埠號可能剛好被別的程式佔用，所以每次向系統要空閒埠
const freePort = () =>
	new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.on('error', reject);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
	});
const PORT = await freePort();
const calls = [];

// ---------------------------------------------------------------- 假的 EasyEDA 圖元
const STATE_KEYS = ['PrimitiveType', 'PrimitiveId', 'Net', 'Layer', 'X', 'Y', 'StartX', 'StartY', 'EndX', 'EndY', 'LineWidth', 'HoleDiameter', 'Diameter',
	'Designator', 'Name', 'Footprint', 'OtherProperty', 'Rotation', 'PrimitiveLock', 'PadNumber', 'ParentComponentPrimitiveId', 'Polygon', 'ComplexPolygon', 'PourName', 'Text', 'FontSize'];
class Prim {
	constructor(s) {
		this._s = s;
	}
}
for (const k of STATE_KEYS) Prim.prototype['getState_' + k] = function () {
	return this._s[k];
};
class Poly {
	constructor(src) {
		this.src = src;
	}
	getSource() {
		return this.src;
	}
	discretize() {
		return [];
	}
}
let seq = 0;
const comps = [
	new Prim({ PrimitiveType: 'Component', PrimitiveId: 'c1', Designator: 'U1', Name: 'ESP32', Footprint: { name: 'QFN-48' }, Layer: 1, X: 1000, Y: 2000, Rotation: 0, PrimitiveLock: false }),
	new Prim({ PrimitiveType: 'Component', PrimitiveId: 'c2', Designator: 'R1', Name: '10k', Footprint: { name: 'R0402' }, Layer: 1, X: 0, Y: 0, Rotation: 90, PrimitiveLock: false }),
];
const outline = [];
const importedNets = [];
const prims = new Map();

const handlers = {
	'pcb_PrimitiveComponent.getAll': () => comps,
	'pcb_PrimitiveComponent.getAllPrimitiveId': () => comps.map((c) => c._s.PrimitiveId),
	'pcb_PrimitiveComponent.getAllPinsByPrimitiveId': (id) => [
		new Prim({ PrimitiveType: 'ComponentPad', PrimitiveId: id + 'p1', PadNumber: '1', Net: 'GND', Layer: 1, X: 1100, Y: 2000, ParentComponentPrimitiveId: id }),
	],
	'pcb_PrimitiveComponent.modify': (id, prop) => {
		const c = comps.find((c) => c._s.PrimitiveId === id);
		Object.assign(c._s, { X: prop.x ?? c._s.X, Y: prop.y ?? c._s.Y, Rotation: prop.rotation ?? c._s.Rotation });
		return c;
	},
	'pcb_PrimitiveLine.create': (net, layer, sx, sy, ex, ey, w) => {
		const p = new Prim({ PrimitiveType: 'Line', PrimitiveId: 'l' + ++seq, Net: net, Layer: layer, StartX: sx, StartY: sy, EndX: ex, EndY: ey, LineWidth: w });
		prims.set(p._s.PrimitiveId, p);
		return p;
	},
	'pcb_PrimitiveVia.create': (net, x, y, d, D) => new Prim({ PrimitiveType: 'Via', PrimitiveId: 'v' + ++seq, Net: net, X: x, Y: y, HoleDiameter: d, Diameter: D }),
	'pcb_PrimitivePolyline.getAllPrimitiveId': (net, layer) => {
		if (net !== undefined) throw new Error('net 應為 undefined（$undefined 未正確還原）');
		return layer === 11 ? outline.map((o) => o._s.PrimitiveId) : [];
	},
	'pcb_PrimitivePolyline.getAll': (net, layer) => (layer === 11 ? outline : []),
	'pcb_PrimitivePolyline.delete': (ids) => {
		outline.splice(0, outline.length);
		return true;
	},
	'pcb_PrimitivePolyline.create': (net, layer, poly, w) => {
		if (!(poly instanceof Poly)) throw new Error('polygon 沒有被還原成 IPCB_Polygon');
		const p = new Prim({ PrimitiveType: 'Polyline', PrimitiveId: 'pl' + ++seq, Net: net, Layer: layer, Polygon: poly, LineWidth: w });
		if (layer === 11) outline.push(p);
		return p;
	},
	'pcb_PrimitivePour.create': (net, layer, poly, method, keep, name) => new Prim({ PrimitiveType: 'Pour', PrimitiveId: 'po' + ++seq, Net: net, Layer: layer, ComplexPolygon: poly, PourName: name }),
	'pcb_PrimitivePour.getAll': () => [],
	'pcb_PrimitiveLine.getAllPrimitiveId': () => [...prims.keys()],
	'pcb_PrimitiveVia.getAllPrimitiveId': () => [],
	'pcb_PrimitiveArc.getAllPrimitiveId': () => [],
	'pcb_PrimitiveLine.delete': (ids) => {
		ids.forEach((i) => prims.delete(i));
		return true;
	},
	// EasyEDA 的 getPrimitiveTypeByPrimitiveId 是空殼，server 改用各類別的 get(ids) 判斷類型
	'pcb_Primitive.getPrimitiveTypeByPrimitiveId': () => undefined,
	'pcb_PrimitiveLine.get': (ids) => (Array.isArray(ids) ? ids.filter((i) => prims.has(i)).map((i) => prims.get(i)) : prims.get(ids)),
	'pcb_PrimitiveVia.get': (ids) => [],
	'pcb_Layer.getTheNumberOfCopperLayers': () => 2,
	'pcb_Net.getAllNetsName': () => ['GND', '3V3', 'SDA', ...importedNets],
	// 實機回傳的是引擎原始物件（pcbItemPrimitiveType / globalIndex / center…）
	'pcb_Net.getAllPrimitivesByNet': (net) => [
		{ pcbItemPrimitiveType: 'Pad', globalIndex: 'c1p1', num: '1', net, layerId: 1, center: { x: 1100, y: 2000 }, rotation: 0, parentId: 'c1' },
		{ pcbItemPrimitiveType: 'Via', globalIndex: 'vx', net, center: { x: 393.7, y: 0 }, radius: 11.8, holeRadius: 5.9 },
		...[...prims.values()].map((p) => ({ pcbItemPrimitiveType: 'Track', globalIndex: p._s.PrimitiveId, net, layerId: p._s.Layer, startX: p._s.StartX, startY: p._s.StartY, endX: p._s.EndX, endY: p._s.EndY, width: p._s.LineWidth })),
	],
	'pcb_Net.getNetLength': () => 393.7,
	'pcb_Drc.check': () => [{ name: 'Clearance Error', list: [{ name: 'Track to Track', list: [{ errorType: 'Clearance Error', errorObjType: 'Track to Track', ruleName: 'r', obj1: { typeName: 'Track', suffix: '(A): e1' }, obj2: { typeName: 'Track', suffix: '(B): e2' }, explanation: { str: '{obj1} to {obj2} distance is {minDistance}', param: { minDistance: '0mil' }, errData: { position: { x: 59.05512, y: 59.05512 } } } }] }] }],
	'pcb_Document.save': () => true,
	// 模擬使用者在「導入變更」對話框按確認：稍後多出一顆元件與一個網路
	'pcb_Document.importChanges': (uuid, force) => {
		if (force) throw new Error('force 應為 false');
		setTimeout(() => {
			comps.push(new Prim({ PrimitiveType: 'Component', PrimitiveId: 'c3', Designator: 'C1', Name: '={Value}', OtherProperty: { Value: '100nF' }, Layer: 1, X: -200, Y: -200, Rotation: 0 }));
			importedNets.push('VBUS');
		}, 500);
		return true;
	},
	'dmt_SelectControl.getCurrentDocumentInfo': () => ({ documentType: 3, uuid: 'doc', tabId: 't' }),
	'dmt_Project.getCurrentProjectInfo': () => ({ name: 'Demo' }),
	'dmt_Pcb.getCurrentPcbInfo': () => ({ name: 'PCB1' }),
};

const sockets = {};
const toasts = [];
const eda = new Proxy(
	{
		sys_WebSocket: {
			register(id, url, onMsg, onConn) {
				// 實機行為：連線仍活著時再 register，EasyEDA 也會再呼叫 connected 回呼
				if (sockets[id] && sockets[id].readyState === 1) return void onConn?.();
				if (sockets[id] && sockets[id].readyState === 0) return;
				// 擴充預設連 49625；測試改導到 PORT，避免與實際執行中的 server 衝突
				const ws = new WebSocket(url.replace(/:\d+$/,':' + PORT));
				sockets[id] = ws;
				ws.on('open', () => onConn?.());
				ws.on('message', (d) => onMsg?.({ data: d.toString() }));
				ws.on('error', () => {});
			},
			send(id, data) {
				sockets[id].send(data);
			},
			close(id) {
				sockets[id]?.close();
			},
		},
		sys_ToastMessage: { showMessage: (msg, type) => toasts.push([msg, type]) },
		sys_Dialog: { showInformationMessage() {} },
		pcb_MathPolygon: { createPolygon: (s) => new Poly(s), createComplexPolygon: (s) => new Poly(s) },
	},
	{
		get(target, mod) {
			if (mod in target) return target[mod];
			return new Proxy({}, {
				get(_, fn) {
					const key = `${mod}.${String(fn)}`;
					if (!handlers[key]) return undefined;
					return async (...args) => {
						calls.push({ key, args });
						return handlers[key](...args);
					};
				},
			});
		},
	},
);

// ---------------------------------------------------------------- 執行
const transport = new StdioClientTransport({
	command: process.execPath,
	args: [path.join(here, 'index.js')],
	env: { ...process.env, EASYEDA_MCP_PORT: String(PORT) },
	stderr: 'inherit',
});
const client = new Client({ name: 'selftest', version: '0' });
await client.connect(transport);

const ctx = vm.createContext({ eda, setInterval, clearInterval, setTimeout, console, JSON, Blob });
vm.runInContext(fs.readFileSync(path.join(here, '../extension/dist/index.js'), 'utf8') + '\n;globalThis.ext = edaEsbuildExportName;', ctx);
ctx.ext.activate('onStartupFinished');
await new Promise((r) => setTimeout(r, 800));

let failed = 0;
async function t(name, args, check) {
	const res = await client.callTool({ name, arguments: args });
	const text = res.content?.[0]?.text ?? '';
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = text;
	}
	let ok = !res.isError;
	try {
		if (ok && check) ok = check(data) !== false;
	} catch (e) {
		ok = false;
		data = { checkError: e.message, data };
	}
	if (!ok) failed++;
	console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : '\n' + text.slice(0, 1500)}`);
	return data;
}

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((x) => x.name).join(', ')}`);

await t('easyeda_status', {}, (d) => d.connected && d.ping.pong && d.context.project.name === 'Demo');
await t('pcb_list_components', {}, (d) => d.count === 2 && d.components[0].designator === 'R1' && d.components[1].x === 25.4);
await t('pcb_get_component', { ref: 'u1' }, (d) => d.pads[0].net === 'GND' && d.pads[0].x === 27.94);
await t('pcb_set_board_outline', { shape: { rect: { x: 0, y: 0, width: 50, height: 30, corner_radius: 2 } } }, (d) => {
	const b = d.created.bbox;
	// 實機驗證：多邊形與圖元同一座標系，不反轉 Y → 原始座標的 Y 應為 0..1181 mil
	const src = calls.filter((c) => c.key === 'pcb_PrimitivePolyline.create').at(-1).args[2].src;
	const ys = src.filter((v, i) => typeof v === 'number' && typeof src[i - 1] === 'number');
	return Math.abs(b.width - 50) < 1e-3 && Math.abs(b.height - 30) < 1e-3 && Math.abs(b.max_y - 30) < 1e-3 && Math.min(...ys) >= 0;
});
await t('pcb_set_board_outline', { shape: { points: [[0, 0], [40, 0], [40, 20], [0, 20]] } }, (d) => d.removed_outlines === 1);
await t('pcb_get_info', {}, (d) => d.copper_layers === 2 && d.board_outline.length === 1 && d.counts.components === 2);
const route = await t('pcb_route_track', { net: 'GND', layer: 'top', width: 0.3, points: [[0, 0], [10, 0], [10, 5]] }, (d) => d.segments_created === 2);
const lc = calls.filter((c) => c.key === 'pcb_PrimitiveLine.create').at(-1);
console.log('  last line args (mil):', JSON.stringify(lc.args));
await t('pcb_add_vias', { vias: [{ x: 10, y: 5, net: 'GND' }] }, (d) => d.vias_created === 1);
await t('pcb_add_copper_pour', { net: 'GND', layer: 'bottom', name: 'GND_B' }, (d) => d.created.net === 'GND' && d.created.layer === 'bottom');
await t('pcb_move_components', { moves: [{ ref: 'R1', x: 5, y: 5, rotation: 180 }] }, (d) => d.moved === 1 && d.components[0].x === 5);
await t('pcb_get_net', { net: 'GND' }, (d) => d.pads[0].ref === 'U1' && d.pads[0].x === 27.94 && d.tracks.length === 2 && d.vias[0].drill === 0.2997 && d.length_mm === 10);
await t('pcb_delete_primitives', { ids: [route.ids[0], 'nope'] }, (d) => d.deleted.Line === 1 && d.not_found[0] === 'nope');
await t('pcb_clear_net_routing', { net: 'GND' }, (d) => d.deleted.lines === 1);
await t('pcb_run_drc', {}, (d) => d.violations === 1 && d.items[0].at[0] === 15 && d.items[0].message === 'Track(A): e1 to Track(B): e2 distance is 0mil');
await t('pcb_save', {}, (d) => d.ok === true);
await t('pcb_import_changes', { wait_seconds: 10 }, (d) => d.changed && d.components_added[0] === 'C1' && d.nets_added[0] === 'VBUS');
await t('pcb_list_components', { filter: '^C' }, (d) => d.components[0].name === '100nF');
await t('eda_call', { path: 'pcb_Net.getAllNetsName' }, (d) => d.length === 4);
const bad = await client.callTool({ name: 'eda_call', arguments: { path: 'constructor.constructor' } });
console.log(`${bad.isError ? 'PASS' : 'FAIL'} eda_call rejects bad path`);
if (!bad.isError) failed++;

// 擴充每 3 秒 register 一次；等兩輪以上，「已連線」提示應該只出現一次
await new Promise((r) => setTimeout(r, 7000));
const okToasts = toasts.filter(([, type]) => type === 'success').length;
console.log(`${okToasts === 1 ? 'PASS' : 'FAIL'} connected toast shown once (got ${okToasts})`);
if (okToasts !== 1) failed++;

await client.close();
for (const s of Object.values(sockets)) s.close();

// 佔埠時每 5 秒重試，對方釋放後自動接手
{
	const { Bridge } = await import('./bridge.js');
	const port2 = await freePort();
	const blocker = net.createServer().listen(port2, '127.0.0.1');
	await new Promise((r) => blocker.on('listening', r));
	const b = new Bridge({ port: port2 });
	const first = await b.start();
	blocker.close();
	await new Promise((r) => setTimeout(r, 6000));
	const ok = first === false && b.status().listening === true;
	console.log(`${ok ? 'PASS' : 'FAIL'} bridge takes over port after it is freed`);
	if (!ok) failed++;
	b.close();
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
