/**
 * EasyEDA MCP Bridge — EasyEDA Pro 擴充端
 *
 * 這個擴充刻意做得很薄：它只負責
 *   1. 以 WebSocket client 連到本機的 MCP server（eda.sys_WebSocket）
 *   2. 收到 {id, method, params} 後呼叫 eda.<module>.<method>(...args)
 *   3. 把結果（含 IPCB_* 圖元物件）序列化成 JSON 回傳
 *
 * 所有 PCB 繪圖邏輯（單位換算、走線拆段、板框、鋪銅…）都在 MCP server 端，
 * 因此新增工具通常不需要重新安裝這個擴充。
 */
import extensionConfig from '../extension.json' with { type: 'json' };

const BRIDGE_VERSION = extensionConfig.version;
const WS_ID = 'easyeda-mcp-bridge';
const DEFAULT_URL = 'ws://127.0.0.1:18625';
const RECONNECT_MS = 3000;

let serviceUrl = DEFAULT_URL;
let keepAliveTimer = null;
let connected = false;
let lastError = '';
let handledCalls = 0;
let lastSeen = 0; // 最後一次收到 server 訊息的時間
let serverHeartbeatMs = 0; // server 回 welcome 時告知的心跳間隔；0 = 舊版 server，不做逾時判斷

// ---------------------------------------------------------------- helpers

function toast(msg, type = 'info') {
	try {
		eda.sys_ToastMessage.showMessage(msg, type, 3);
	} catch {
		/* ignore */
	}
}

function send(obj) {
	eda.sys_WebSocket.send(WS_ID, JSON.stringify(obj));
}

function isThenable(v) {
	return v != null && typeof v.then === 'function';
}

/** 收集物件原型鏈上所有 getState_* 方法名稱 */
function stateGetterNames(obj) {
	const names = new Set();
	let proto = Object.getPrototypeOf(obj);
	while (proto && proto !== Object.prototype) {
		for (const n of Object.getOwnPropertyNames(proto)) {
			if (n.startsWith('getState_') && typeof obj[n] === 'function') names.add(n);
		}
		proto = Object.getPrototypeOf(proto);
	}
	for (const n of Object.keys(obj)) {
		if (n.startsWith('getState_') && typeof obj[n] === 'function') names.add(n);
	}
	return [...names];
}

/** 把 EDA 回傳值轉成可 JSON 化的資料 */
async function serialize(value, depth = 0, fields = null) {
	if (isThenable(value)) value = await value;
	if (value === null || value === undefined) return value ?? null;
	const t = typeof value;
	if (t === 'number' || t === 'string' || t === 'boolean') return value;
	if (t === 'bigint') return value.toString();
	if (t === 'function') return undefined;
	if (depth > 8) return '[max depth]';

	if (Array.isArray(value)) {
		const out = [];
		for (const v of value) out.push(await serialize(v, depth + 1, fields));
		return out;
	}
	if (typeof Blob !== 'undefined' && value instanceof Blob) {
		return { $blob: true, name: value.name ?? null, size: value.size, type: value.type };
	}
	// IPCB_Polygon / IPCB_ComplexPolygon
	if (typeof value.getSource === 'function' && (typeof value.discretize === 'function' || typeof value.toPolygon === 'function')) {
		return { $polygon: value.getSource() };
	}
	let getters = stateGetterNames(value);
	if (fields && getters.length > 0) getters = getters.filter((g) => fields.includes(g.slice('getState_'.length)));
	if (getters.length > 0) {
		const out = {};
		for (const g of getters) {
			try {
				out[g.slice('getState_'.length)] = await serialize(value[g](), depth + 1);
			} catch (e) {
				out[g.slice('getState_'.length)] = { $error: String(e?.message ?? e) };
			}
		}
		return out;
	}
	if (value instanceof Map) {
		const out = {};
		for (const [k, v] of value) out[String(k)] = await serialize(v, depth + 1);
		return out;
	}
	if (value instanceof Set) return serialize([...value], depth);
	const out = {};
	for (const [k, v] of Object.entries(value)) {
		const s = await serialize(v, depth + 1);
		if (s !== undefined) out[k] = s;
	}
	return out;
}

/** 把 JSON 參數中的特殊標記還原成 EDA 物件 */
function revive(arg) {
	if (Array.isArray(arg)) return arg.map(revive);
	if (arg && typeof arg === 'object') {
		const keys = Object.keys(arg);
		// JSON 沒有 undefined；用 {$undefined:true} 表示「省略此參數」（與 null 不同）
		if (keys.length === 1 && keys[0] === '$undefined') return undefined;
		if (keys.length === 1 && keys[0] === '$polygon') {
			const p = eda.pcb_MathPolygon.createPolygon(arg.$polygon);
			if (!p) throw new Error('createPolygon 失敗，請檢查多邊形資料: ' + JSON.stringify(arg.$polygon).slice(0, 200));
			return p;
		}
		if (keys.length === 1 && keys[0] === '$complexPolygon') {
			const p = eda.pcb_MathPolygon.createComplexPolygon(arg.$complexPolygon);
			if (!p) throw new Error('createComplexPolygon 失敗');
			return p;
		}
		const out = {};
		for (const k of keys) out[k] = revive(arg[k]);
		return out;
	}
	return arg;
}

const PATH_RE = /^[a-z]+_[A-Za-z0-9]+\.[A-Za-z][A-Za-z0-9_]*$/;

async function invoke(path, args, fields) {
	if (typeof path !== 'string' || !PATH_RE.test(path)) throw new Error('不合法的 API 路徑: ' + path);
	const [mod, fn] = path.split('.');
	const target = eda[mod];
	if (!target) throw new Error('eda.' + mod + ' 不存在');
	if (typeof target[fn] !== 'function') throw new Error('eda.' + path + ' 不是函式');
	const result = await target[fn](...revive(args ?? []));
	return serialize(result, 0, Array.isArray(fields) && fields.length ? fields : null);
}

// ---------------------------------------------------------------- RPC

const methods = {
	async ping() {
		return { pong: true, bridgeVersion: BRIDGE_VERSION, time: Date.now() };
	},
	async call({ path, args, fields }) {
		return invoke(path, args, fields);
	},
	/** 依序執行多個呼叫；遇錯即停（stopOnError=false 時繼續） */
	async batch({ calls, stopOnError = true }) {
		const results = [];
		for (const c of calls ?? []) {
			try {
				results.push({ ok: true, result: await invoke(c.path, c.args, c.fields) });
			} catch (e) {
				results.push({ ok: false, error: String(e?.message ?? e) });
				if (stopOnError) break;
			}
		}
		return results;
	},
	/** 讀取目前使用中的文件 / 工程 / PCB 資訊 */
	async context() {
		const safe = async (fn) => {
			try {
				return await serialize(await fn());
			} catch (e) {
				return { $error: String(e?.message ?? e) };
			}
		};
		return {
			document: await safe(() => eda.dmt_SelectControl.getCurrentDocumentInfo()),
			project: await safe(() => eda.dmt_Project.getCurrentProjectInfo()),
			pcb: await safe(() => eda.dmt_Pcb.getCurrentPcbInfo()),
		};
	},
};

async function onMessage(event) {
	let msg;
	try {
		msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
	} catch {
		return;
	}
	if (!msg) return;
	lastSeen = Date.now();
	if (msg.type === 'welcome') {
		serverHeartbeatMs = Number(msg.heartbeatMs) || 0;
		return;
	}
	if (msg.id === undefined) return; // ping 等通知
	const handler = methods[msg.method];
	try {
		if (!handler) throw new Error('未知的 method: ' + msg.method);
		const result = await handler(msg.params ?? {});
		handledCalls++;
		send({ id: msg.id, ok: true, result: result ?? null });
	} catch (e) {
		send({ id: msg.id, ok: false, error: String(e?.message ?? e), stack: e?.stack ? String(e.stack).slice(0, 2000) : undefined });
	}
}

function onConnected() {
	// 注意：連線仍活著時再次 register()，EasyEDA 也會再呼叫這個回呼（實測每 3 秒一次），
	// 所以只在「未連線 → 已連線」時才提示與送 hello。
	const wasConnected = connected;
	connected = true;
	lastError = '';
	lastSeen = Date.now();
	if (wasConnected) return;
	serverHeartbeatMs = 0;
	try {
		send({ type: 'hello', bridgeVersion: BRIDGE_VERSION, extension: extensionConfig.name });
	} catch {
		/* ignore */
	}
	toast('EasyEDA MCP 已連線 ' + serviceUrl, 'success');
}

function tryRegister() {
	// 新版 server 會定期送 ping；太久沒收到任何訊息就當作斷線，關掉後重新連
	if (connected && serverHeartbeatMs > 0 && Date.now() - lastSeen > serverHeartbeatMs * 3) {
		connected = false;
		try {
			eda.sys_WebSocket.close(WS_ID, 1000, 'heartbeat timeout');
		} catch {
			/* ignore */
		}
		toast('EasyEDA MCP 連線中斷，重新連線中…', 'warn');
		return; // 下一輪再 register，讓 close 先完成
	}
	try {
		// 同 ID 且仍活躍時 register 不會重連，因此可安全地週期性呼叫當作自動重連
		eda.sys_WebSocket.register(WS_ID, serviceUrl, onMessage, onConnected);
	} catch (e) {
		connected = false;
		lastError = String(e?.message ?? e);
	}
}

function startKeepAlive() {
	tryRegister();
	if (!keepAliveTimer) keepAliveTimer = setInterval(tryRegister, RECONNECT_MS);
}

function stopKeepAlive() {
	if (keepAliveTimer) clearInterval(keepAliveTimer);
	keepAliveTimer = null;
	try {
		eda.sys_WebSocket.close(WS_ID, 1000, 'user disconnect');
	} catch {
		/* ignore */
	}
	connected = false;
}

// ---------------------------------------------------------------- exports (headerMenus)

export function activate(status, arg) {
	// 擴充載入後自動嘗試連線；MCP server 尚未啟動時會每 3 秒重試
	startKeepAlive();
}

export function mcpConnect() {
	startKeepAlive();
	if (lastError) {
		eda.sys_Dialog.showInformationMessage(
			'無法建立 WebSocket 連線：\n' + lastError + '\n\n請確認已在「擴充管理器」中為本擴充開啟「外部交互」權限。',
			'EasyEDA MCP',
		);
	} else {
		toast('正在連線 ' + serviceUrl + ' …');
	}
}

export function mcpDisconnect() {
	stopKeepAlive();
	toast('EasyEDA MCP 已中斷', 'warn');
}

export function mcpStatus() {
	eda.sys_Dialog.showInformationMessage(
		[
			'Bridge 版本：' + BRIDGE_VERSION,
			'MCP server：' + serviceUrl,
			'自動重連：' + (keepAliveTimer ? '開啟' : '關閉'),
			'目前連線：' + (connected ? '是' : '否'),
			lastSeen ? '最後收到訊息：' + Math.round((Date.now() - lastSeen) / 1000) + ' 秒前' : '',
			'已處理指令：' + handledCalls,
			lastError ? '最後錯誤：' + lastError : '',
		]
			.filter(Boolean)
			.join('\n'),
		'EasyEDA MCP',
	);
}

export function mcpSetPort() {
	eda.sys_Dialog.showInputDialog('MCP server WebSocket 位址', '', 'EasyEDA MCP', 'text', serviceUrl, undefined, (value) => {
		if (!value) return;
		stopKeepAlive();
		serviceUrl = String(value).trim();
		startKeepAlive();
	});
}
