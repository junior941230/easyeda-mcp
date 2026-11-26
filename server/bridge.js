// 本機 WebSocket server：等待 EasyEDA Pro 內的 bridge 擴充連進來，並以 JSON-RPC 風格轉送指令。
import { WebSocketServer } from 'ws';

const HEARTBEAT_MS = 10000;
const RETRY_MS = 5000;

export class Bridge {
	/**
	 * @param {{host?: string, port?: number, timeoutMs?: number, log?: (msg: string) => void}} opts
	 */
	constructor({ host = '127.0.0.1', port = 18625, timeoutMs = 30000, log = () => {} } = {}) {
		this.host = host;
		this.port = port;
		this.timeoutMs = timeoutMs;
		this.log = log;
		/** @type {Array<{ws: import('ws').WebSocket, hello: any, connectedAt: number, alive: boolean}>} */
		this.clients = [];
		this.pending = new Map();
		this.nextId = 1;
		this.listenError = null;
		this.wss = null;
	}

	/** 開始監聽；埠被佔用（例如另一個 Claude 工作階段的 server）時每 5 秒重試，對方關掉後自動接手 */
	start() {
		this.heartbeat ??= setInterval(() => this.#beat(), HEARTBEAT_MS);
		this.heartbeat.unref?.();
		return new Promise((resolve) => this.#listen(resolve));
	}

	#listen(resolve) {
		if (this.closed) return;
		const wss = new WebSocketServer({ host: this.host, port: this.port });
		wss.on('listening', () => {
			this.wss = wss;
			if (this.listenError) this.log(`bridge 已接手 ws://${this.host}:${this.port}`);
			this.listenError = null;
			this.log(`bridge listening on ws://${this.host}:${this.port}`);
			resolve?.(true);
		});
		wss.on('error', (err) => {
			if (this.wss === wss) {
				this.log(`bridge error: ${err.message}`);
				return;
			}
			const first = !this.listenError;
			this.listenError = err;
			if (first) this.log(`bridge listen error: ${err.message}（每 ${RETRY_MS / 1000} 秒重試）`);
			wss.close();
			resolve?.(false);
			this.retryTimer = setTimeout(() => this.#listen(), RETRY_MS);
			this.retryTimer.unref?.();
		});
		wss.on('connection', (ws, req) => this.#onConnection(ws, req));
	}

	// 心跳：協定層 ping 清掉沒回應的連線；另外送應用層 ping，讓擴充能偵測斷線
	#beat() {
		for (const c of [...this.clients]) {
			if (!c.alive) {
				c.ws.terminate();
				continue;
			}
			c.alive = false;
			try {
				c.ws.ping();
				c.ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
			} catch {
				/* ignore */
			}
		}
	}

	#onConnection(ws, req) {
		const client = { ws, hello: null, connectedAt: Date.now(), alive: true, remote: req.socket.remoteAddress };
		this.clients.push(client);
		this.log(`EasyEDA connected from ${client.remote} (clients=${this.clients.length})`);
		ws.on('pong', () => (client.alive = true));
		ws.on('message', (data) => {
			client.alive = true;
			let msg;
			try {
				msg = JSON.parse(data.toString());
			} catch {
				return;
			}
			if (msg.type === 'hello') {
				client.hello = msg;
				ws.send(JSON.stringify({ type: 'welcome', heartbeatMs: HEARTBEAT_MS }));
				return;
			}
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			clearTimeout(p.timer);
			if (msg.ok) p.resolve(msg.result);
			else {
				const e = new Error(msg.error || 'EasyEDA 端回報錯誤');
				e.remoteStack = msg.stack;
				p.reject(e);
			}
		});
		ws.on('close', () => {
			this.clients = this.clients.filter((c) => c !== client);
			this.log(`EasyEDA disconnected (clients=${this.clients.length})`);
			for (const [id, p] of this.pending) {
				if (p.client === client) {
					clearTimeout(p.timer);
					this.pending.delete(id);
					p.reject(new Error('EasyEDA 連線在等待回應時中斷'));
				}
			}
		});
	}

	/** 最近連上的那個 client（EasyEDA 可能因多個編輯器分頁而有多個擴充實例） */
	get activeClient() {
		const open = this.clients.filter((c) => c.ws.readyState === c.ws.OPEN);
		return open.length ? open[open.length - 1] : null;
	}

	status() {
		return {
			listening: !!this.wss && !this.listenError,
			url: `ws://${this.host}:${this.port}`,
			listenError: this.listenError ? String(this.listenError.message) : null,
			clients: this.clients.map((c) => ({
				remote: c.remote,
				bridgeVersion: c.hello?.bridgeVersion ?? null,
				connectedAt: new Date(c.connectedAt).toISOString(),
			})),
		};
	}

	/**
	 * 送一個 RPC 給 EasyEDA 端
	 * @param {string} method
	 * @param {any} params
	 * @param {number} [timeoutMs]
	 */
	request(method, params, timeoutMs = this.timeoutMs) {
		if (this.listenError) {
			const inUse = this.listenError.code === 'EADDRINUSE';
			return Promise.reject(
				new Error(
					`MCP bridge 無法監聽 ws://${this.host}:${this.port}：${this.listenError.message}` +
						(inUse ? '。通常是另一個 easyeda-mcp 已在執行（例如另一個 Claude 工作階段）；本 server 每 5 秒重試，對方關掉後會自動接手。要同時使用，請用環境變數 EASYEDA_MCP_PORT 換埠號並在 EasyEDA「MCP → 設定 server 位址」同步修改。' : ''),
				),
			);
		}
		const client = this.activeClient;
		if (!client) {
			return Promise.reject(
				new Error(
					`EasyEDA Pro 尚未連線到 ws://${this.host}:${this.port}。請確認：(1) EasyEDA Pro 已開啟且已安裝 EasyEDA MCP Bridge 擴充；(2) 擴充管理器裡已開啟該擴充的「外部交互」權限；(3) 在 PCB 編輯器選單「MCP → 連線 MCP server」。`,
				),
			);
		}
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`EasyEDA 在 ${timeoutMs} ms 內沒有回應 (${method})`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer, client });
			client.ws.send(JSON.stringify({ id, method, params }));
		});
	}

	/** 呼叫 eda.<path>(...args) */
	call(path, args = [], { fields, timeoutMs } = {}) {
		return this.request('call', { path, args, fields }, timeoutMs);
	}

	/** 依序執行多個呼叫 */
	batch(calls, { stopOnError = true, timeoutMs } = {}) {
		return this.request('batch', { calls, stopOnError }, timeoutMs ?? Math.max(this.timeoutMs, calls.length * 2000));
	}

	close() {
		this.closed = true;
		clearInterval(this.heartbeat);
		clearTimeout(this.retryTimer);
		for (const c of this.clients) c.ws.close();
		this.wss?.close();
	}
}
