// 單位、層名與多邊形工具
//
// EasyEDA Pro 的 PCB API 內部單位是 mil；本 MCP 對外一律使用 mm。
// 圖元座標（元件、走線、過孔…）是笛卡爾座標（Y 向上），
// TPCB_PolygonSourceArray（板框、鋪銅、填充…）實測與圖元同一座標系（見 POLYGON_Y_FLIP）。

export const MIL_PER_MM = 1000 / 25.4;
export const toMil = (mm) => (mm == null ? mm : mm * MIL_PER_MM);
export const toMm = (mil) => (typeof mil === 'number' ? Math.round((mil / MIL_PER_MM) * 10000) / 10000 : mil);

// API 文件宣稱多邊形是 SVG 座標（Y 向下）需反轉，但 2026-11-19 在 EasyEDA Pro 3.2.209 實測：
// Polyline 與 Line 的座標原樣送進引擎，getPrimitivesBBox 顯示兩者同一座標系 → 不需反轉。
export const POLYGON_Y_FLIP = false;
const py = (yMil) => (POLYGON_Y_FLIP ? -yMil : yMil);
const unpy = (y) => (POLYGON_Y_FLIP ? -y : y);

export const LAYERS = {
	top: 1, bottom: 2,
	top_silk: 3, top_silkscreen: 3, bottom_silk: 4, bottom_silkscreen: 4,
	top_mask: 5, top_solder_mask: 5, bottom_mask: 6, bottom_solder_mask: 6,
	top_paste: 7, top_paste_mask: 7, bottom_paste: 8, bottom_paste_mask: 8,
	top_assembly: 9, bottom_assembly: 10,
	board_outline: 11, outline: 11, multi: 12, multilayer: 12,
	document: 13, mechanical: 14, drill_drawing: 56, ratline: 57,
};
for (let i = 1; i <= 30; i++) {
	LAYERS[`inner${i}`] = 14 + i;
	LAYERS[`in${i}`] = 14 + i;
}
const LAYER_NAMES = Object.fromEntries(
	Object.entries(LAYERS)
		.filter(([k]) => !/^in\d|_silkscreen$|_solder_mask$|_paste_mask$|^outline$|^multilayer$/.test(k))
		.map(([k, v]) => [v, k]),
);

/** 'top' / 'Top' / 'inner2' / 1 → 層 ID */
export function layerId(layer) {
	if (typeof layer === 'number') return layer;
	const key = String(layer).trim().toLowerCase().replace(/[\s-]+/g, '_');
	if (/^\d+$/.test(key)) return Number(key);
	const id = LAYERS[key];
	if (id === undefined) throw new Error(`未知的層：${layer}。可用：top, bottom, inner1..inner30, top_silk, bottom_silk, board_outline, multi, document, mechanical…`);
	return id;
}
export const layerName = (id) => LAYER_NAMES[id] ?? id;

/** [[x,y],...] (mm, 笛卡爾) → polygon source (mil, SVG)，自動閉合 */
export function polygonFromPoints(points, { close = true } = {}) {
	if (!Array.isArray(points) || points.length < 2) throw new Error('points 至少需要 2 個點');
	const pts = points.map(([x, y]) => [toMil(x), py(toMil(y))]);
	if (close) {
		const [fx, fy] = pts[0];
		const [lx, ly] = pts[pts.length - 1];
		if (Math.abs(fx - lx) > 1e-6 || Math.abs(fy - ly) > 1e-6) pts.push([fx, fy]);
	}
	const src = [pts[0][0], pts[0][1], 'L'];
	for (const [x, y] of pts.slice(1)) src.push(x, y);
	return src;
}

/** 矩形（可圓角）→ polygon source。x,y 為左下角（mm, 笛卡爾） */
export function polygonFromRect({ x, y, width, height, corner_radius = 0 }) {
	const r = Math.min(corner_radius, width / 2, height / 2);
	if (!(r > 0)) return polygonFromPoints([[x, y], [x + width, y], [x + width, y + height], [x, y + height]]);
	const x0 = x, y0 = y, x1 = x + width, y1 = y + height;
	const P = (a, b) => [toMil(a), py(toMil(b))];
	// 逆時針（畫面上）走一圈，四個 90° 圓角
	const seq = [
		['L', P(x1 - r, y0)], ['ARC', P(x1, y0 + r)],
		['L', P(x1, y1 - r)], ['ARC', P(x1 - r, y1)],
		['L', P(x0 + r, y1)], ['ARC', P(x0, y1 - r)],
		['L', P(x0, y0 + r)], ['ARC', P(x0 + r, y0)],
	];
	const src = [...P(x0 + r, y0)];
	for (const [kind, [px, pyy]] of seq) {
		if (kind === 'L') src.push('L', px, pyy);
		else src.push('ARC', ARC_CCW_ANGLE, px, pyy);
	}
	return src;
}
// 畫面上逆時針的 90° 圓弧角度（API 說明：負值為順時針）。實機若圓角方向反了，改成 -90。
export const ARC_CCW_ANGLE = 90;

export function polygonFromCircle({ cx, cy, radius }) {
	return ['CIRCLE', toMil(cx), py(toMil(cy)), toMil(radius)];
}

/** 由 shape 參數（rect / points / circle 三擇一）產生 polygon source */
export function polygonFromShape(shape) {
	if (!shape) throw new Error('需要 shape');
	if (shape.rect) return polygonFromRect(shape.rect);
	if (shape.points) return polygonFromPoints(shape.points);
	if (shape.circle) return polygonFromCircle(shape.circle);
	throw new Error('shape 需提供 rect、points 或 circle 其中之一');
}

/** 粗略計算 polygon source 的外框（回傳 mm, 笛卡爾）。只看數字座標，ARC 以端點近似。 */
export function polygonBBox(src) {
	if (!Array.isArray(src)) return null;
	const xs = [], ys = [];
	let i = 0;
	const takePair = () => {
		xs.push(src[i]);
		ys.push(src[i + 1]);
		i += 2;
	};
	while (i < src.length) {
		const t = src[i];
		if (typeof t === 'number') {
			if (typeof src[i + 1] === 'number') takePair();
			else i++;
		} else if (t === 'ARC' || t === 'CARC') {
			i += 2; // 跳過關鍵字與角度
			takePair();
		} else if (t === 'R') {
			const [x, y, w, h] = src.slice(i + 1, i + 5);
			xs.push(x, x + w);
			ys.push(y, y + h);
			i += 7;
		} else if (t === 'CIRCLE') {
			const [cx, cy, r] = src.slice(i + 1, i + 4);
			xs.push(cx - r, cx + r);
			ys.push(cy - r, cy + r);
			i += 4;
		} else i++;
	}
	if (!xs.length) return null;
	const yC = ys.map(unpy);
	const b = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...yC), maxY: Math.max(...yC) };
	return {
		min_x: toMm(b.minX), min_y: toMm(b.minY), max_x: toMm(b.maxX), max_y: toMm(b.maxY),
		width: toMm(b.maxX - b.minX), height: toMm(b.maxY - b.minY),
	};
}
