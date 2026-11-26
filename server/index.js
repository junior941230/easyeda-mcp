#!/usr/bin/env node
// EasyEDA Pro MCP server（stdio）
// 環境變數：EASYEDA_MCP_PORT（預設 49625）、EASYEDA_MCP_HOST（預設 127.0.0.1）、EASYEDA_MCP_TIMEOUT_MS（預設 30000）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.js';
import { registerTools } from './tools.js';

// stdout 是 MCP 通道，log 一律走 stderr
const log = (msg) => process.stderr.write(`[easyeda-mcp] ${msg}\n`);

const bridge = new Bridge({
	host: process.env.EASYEDA_MCP_HOST || '127.0.0.1',
	port: Number(process.env.EASYEDA_MCP_PORT || 49625),
	timeoutMs: Number(process.env.EASYEDA_MCP_TIMEOUT_MS || 30000),
	log,
});
await bridge.start();

const server = new McpServer(
	{ name: 'easyeda-pro', version: '0.1.1' },
	{
		instructions: [
			'這個 server 透過 EasyEDA Pro 內的 bridge 擴充操作 PCB 編輯器。',
			'所有長度與座標單位都是 mm，座標系為 EasyEDA PCB 資料座標（Y 軸向上）。',
			'建議流程：easyeda_status → pcb_get_info → pcb_list_components / pcb_get_component / pcb_get_net → 擺放 / 佈線 → pcb_run_drc → pcb_save。',
			'佈線前先用 pcb_get_component 或 pcb_get_net 取得焊盤的實際座標，走線端點要落在焊盤中心。',
			'操作會直接改動使用者開著的 PCB；可在 EasyEDA 用 Ctrl+Z 復原。大範圍刪除前先跟使用者確認。',
		].join('\n'),
	},
);
registerTools(server, bridge);

const shutdown = () => {
	bridge.close();
	process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

await server.connect(new StdioServerTransport());
log('MCP server ready (stdio)');
