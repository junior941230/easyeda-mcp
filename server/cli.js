#!/usr/bin/env node
// 命令列直接呼叫 MCP 工具（除錯 / 實機驗證用）
//   node server/cli.js <tool> ['<json args>'] [<tool2> '<json2>' ...]
//   node server/cli.js --list
// 會啟動一個 MCP server（預設埠 18625），等 EasyEDA 擴充連進來後依序執行。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);

const transport = new StdioClientTransport({
	command: process.execPath,
	args: [path.join(here, 'index.js')],
	env: { ...process.env },
	stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (d) => (stderr += d));
const client = new Client({ name: 'easyeda-cli', version: '0' });
await client.connect(transport);

if (argv[0] === '--list') {
	const { tools } = await client.listTools();
	for (const t of tools) console.log(`${t.name}\n  ${t.description}\n  args: ${JSON.stringify(Object.keys(t.inputSchema.properties ?? {}))}`);
	process.exit(0);
}

// 等擴充連線（擴充每 3 秒重試一次）
const deadline = Date.now() + Number(process.env.EASYEDA_CLI_WAIT_MS || 15000);
for (;;) {
	if (stderr.includes('EasyEDA connected')) break;
	if (stderr.includes('listen error')) {
		console.error(stderr);
		process.exit(2);
	}
	if (Date.now() > deadline) {
		console.error('等不到 EasyEDA 連線。\n' + stderr);
		process.exit(3);
	}
	await new Promise((r) => setTimeout(r, 200));
}

let code = 0;
for (let i = 0; i < argv.length; ) {
	const name = argv[i++];
	let args = {};
	if (i < argv.length && /^\s*[{[]/.test(argv[i])) args = JSON.parse(argv[i++]);
	const res = await client.callTool({ name, arguments: args });
	console.log(`=== ${name} ${res.isError ? '(ERROR)' : ''}`);
	console.log(res.content?.map((c) => c.text).join('\n'));
	if (res.isError) code = 1;
}
await client.close();
process.exit(code);
