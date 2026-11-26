// 編譯並打包 EasyEDA Pro 擴充 (.eext)
// 格式依官方 easyeda-api-sdk：esbuild iife + globalName edaEsbuildExportName，
// 再把 extension.json / dist / images 以 zip 打包（不含外層資料夾）。
import { build } from 'esbuild';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'extension.json'), 'utf8'));

await build({
	entryPoints: { index: path.join(root, 'src/index.js') },
	entryNames: '[name]',
	outdir: path.join(root, 'dist'),
	bundle: true,
	minify: false, // 官方 SDK 註明：用於內部方法調用，請勿修改
	platform: 'browser',
	format: 'iife',
	globalName: 'edaEsbuildExportName',
	target: 'es2020',
	logLevel: 'info',
});

// 產生 64x64 的 logo（若不存在）
const logoPath = path.join(root, 'images/logo.png');
if (!fs.existsSync(logoPath)) {
	fs.mkdirSync(path.dirname(logoPath), { recursive: true });
	fs.writeFileSync(logoPath, makeLogo(64));
}

const zip = new JSZip();
const add = (rel) => zip.file(rel, fs.readFileSync(path.join(root, rel)));
add('extension.json');
add('dist/index.js');
add('images/logo.png');
if (fs.existsSync(path.join(root, 'README.md'))) add('README.md');

const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${cfg.name}_v${cfg.version}.eext`);
fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } }));
console.log('Packaged:', out);

// ---- 簡易 PNG 產生器：深綠底 + 白色 "M" 形走線
function makeLogo(n) {
	const px = Buffer.alloc(n * (n * 4 + 1));
	const on = (x, y) => {
		const s = n / 64;
		const X = x / s, Y = y / s;
		const stroke = 6;
		if (Y < 14 || Y > 50 || X < 12 || X > 52) return false;
		if (X < 12 + stroke || X > 52 - stroke) return true; // 兩側直線
		const mid = 32, d1 = Math.abs((X - 12) - (Y - 14) * (20 / 22)), d2 = Math.abs((52 - X) - (Y - 14) * (20 / 22));
		return (X <= mid && d1 < stroke * 0.8 && Y < 36) || (X >= mid && d2 < stroke * 0.8 && Y < 36);
	};
	for (let y = 0; y < n; y++) {
		px[y * (n * 4 + 1)] = 0;
		for (let x = 0; x < n; x++) {
			const o = y * (n * 4 + 1) + 1 + x * 4;
			const [r, g, b] = on(x, y) ? [255, 255, 255] : [18, 110, 72];
			px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
		}
	}
	const crcTable = Array.from({ length: 256 }, (_, k) => {
		let c = k;
		for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
	ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(px)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}
