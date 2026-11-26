// MCP 工具定義：全部以 mm 為單位，座標為 EasyEDA PCB 的資料座標（笛卡爾，Y 向上）
import { z } from 'zod';
import {
	toMil, toMm, layerId, layerName, polygonFromShape, polygonFromPoints, polygonBBox,
} from './geometry.js';

const U = { $undefined: true }; // 省略參數

// ----------------------------------------------------------------- 格式化

const xy = (x, y) => [toMm(x), toMm(y)];

/**
 * 部分 API（例如 pcb_Net.getAllPrimitivesByNet）回傳的是引擎原始物件而不是 IPCB_* 類別，
 * 欄位像 {pcbItemPrimitiveType:'Track', globalIndex, startX, layerId, center:{x,y}, ...}，
 * 這裡轉成與 getState_* 相同的形狀。
 */
function normalizeRaw(r) {
	const type = { Track: 'Line', ArcTrack: 'Arc', Via: 'Via', Pad: 'Pad', Component: 'Component', Text: 'String' }[r.pcbItemPrimitiveType];
	const base = { PrimitiveId: r.globalIndex, Net: r.net, Layer: r.layerId, PrimitiveLock: r.locked };
	switch (r.pcbItemPrimitiveType) {
		case 'Track':
		case 'ArcTrack':
			return { ...base, PrimitiveType: type, StartX: r.startX, StartY: r.startY, EndX: r.endX, EndY: r.endY, LineWidth: r.width, ArcAngle: r.arcAngle };
		case 'Via':
			return { ...base, PrimitiveType: 'Via', X: r.center?.x, Y: r.center?.y, HoleDiameter: r.holeRadius * 2, Diameter: r.radius * 2 };
		case 'Pad':
			return {
				...base, PrimitiveType: r.parentId ? 'ComponentPad' : 'Pad', PadNumber: r.num, X: r.center?.x, Y: r.center?.y, Rotation: r.rotation,
				ParentComponentPrimitiveId: r.parentId, Pad: r.defaultPadShapeAspect, Hole: r.holeAspect,
			};
		case 'Polygon': {
			const kind = { 'Copper Region': 'Pour', Fill: 'Fill', Line: 'Polyline' }[r.type] ?? r.type;
			const poly = Array.isArray(r.pathString?.[0]) ? r.pathString : [r.pathString];
			return { ...base, PrimitiveType: kind, ComplexPolygon: { $polygon: poly }, Polygon: { $polygon: poly[0] }, LineWidth: r.strokeWidth };
		}
		default:
			return { ...base, PrimitiveType: r.pcbItemPrimitiveType, raw: r };
	}
}

function fmtPrimitive(p) {
	if (!p || typeof p !== 'object') return p;
	if (p.pcbItemPrimitiveType && !p.PrimitiveType) p = normalizeRaw(p);
	const t = p.PrimitiveType;
	const base = { id: p.PrimitiveId, type: t };
	switch (t) {
		case 'Line':
			return { ...base, net: p.Net, layer: layerName(p.Layer), start: xy(p.StartX, p.StartY), end: xy(p.EndX, p.EndY), width: toMm(p.LineWidth), locked: p.PrimitiveLock };
		case 'Arc':
			return { ...base, net: p.Net, layer: layerName(p.Layer), start: xy(p.StartX, p.StartY), end: xy(p.EndX, p.EndY), angle: p.ArcAngle, width: toMm(p.LineWidth) };
		case 'Via':
			return { ...base, net: p.Net, x: toMm(p.X), y: toMm(p.Y), drill: toMm(p.HoleDiameter), diameter: toMm(p.Diameter), locked: p.PrimitiveLock };
		case 'Pad':
		case 'ComponentPad':
			return {
				...base, number: p.PadNumber, net: p.Net, layer: layerName(p.Layer), x: toMm(p.X), y: toMm(p.Y), rotation: p.Rotation,
				component_id: p.ParentComponentPrimitiveId, shape_mil: p.Pad, hole_mil: p.Hole,
			};
		case 'Polyline':
			return { ...base, net: p.Net, layer: layerName(p.Layer), width: toMm(p.LineWidth), bbox: polygonBBox(p.Polygon?.$polygon) };
		case 'Pour':
			return { ...base, net: p.Net, layer: layerName(p.Layer), name: p.PourName, fill: p.PourFillMethod, priority: p.PourPriority, bbox: polygonBBox(firstPoly(p.ComplexPolygon)) };
		case 'Fill':
			return { ...base, net: p.Net, layer: layerName(p.Layer), bbox: polygonBBox(firstPoly(p.ComplexPolygon)) };
		case 'Region':
			return { ...base, layer: layerName(p.Layer), name: p.RegionName, rules: p.RuleType, bbox: polygonBBox(firstPoly(p.ComplexPolygon)) };
		case 'String':
			return { ...base, layer: layerName(p.Layer), x: toMm(p.X), y: toMm(p.Y), text: p.Text, size: toMm(p.FontSize), rotation: p.Rotation };
		case 'Component':
			return fmtComponent(p);
		default:
			return p;
	}
}

function firstPoly(cp) {
	const src = cp?.$polygon;
	if (!Array.isArray(src)) return null;
	return Array.isArray(src[0]) ? src[0] : src;
}

function fmtComponent(c) {
	const props = c.OtherProperty ?? {};
	// Name 常是 "={Value}" 這種屬性範本
	const known = { ...props, 'Manufacturer Part': c.ManufacturerId ?? props['Manufacturer Part'], Manufacturer: c.Manufacturer ?? props.Manufacturer };
	let name = typeof c.Name === 'string' ? c.Name.replace(/^=\{([^}]+)\}$/, (_, k) => known[k] ?? _) : c.Name;
	if (typeof name === 'string' && /^=\{/.test(name)) name = props.Value ?? props.Device ?? c.Component?.name ?? name;
	return {
		id: c.PrimitiveId,
		designator: c.Designator,
		name,
		...(props.Value && props.Value !== name ? { value: props.Value } : {}),
		...(props.Device || c.Component?.name ? { device: props.Device ?? c.Component?.name } : {}),
		footprint: c.Footprint?.name ?? c.Footprint?.title ?? c.Footprint?.uuid ?? null,
		layer: layerName(c.Layer),
		x: toMm(c.X),
		y: toMm(c.Y),
		rotation: c.Rotation,
		locked: c.PrimitiveLock,
		...(c.SupplierId ? { lcsc: c.SupplierId } : {}),
	};
}

const COMPONENT_FIELDS = ['PrimitiveType', 'PrimitiveId', 'Designator', 'Name', 'Component', 'Footprint', 'Layer', 'X', 'Y', 'Rotation', 'PrimitiveLock', 'SupplierId', 'ManufacturerId', 'Manufacturer', 'OtherProperty'];
const PAD_FIELDS = ['PrimitiveType', 'PrimitiveId', 'PadNumber', 'Net', 'Layer', 'X', 'Y', 'Rotation', 'Pad', 'Hole', 'ParentComponentPrimitiveId'];
const GENERIC_FIELDS = [
	'PrimitiveType', 'PrimitiveId', 'Net', 'Layer', 'X', 'Y', 'StartX', 'StartY', 'EndX', 'EndY', 'LineWidth', 'ArcAngle',
	'HoleDiameter', 'Diameter', 'PadNumber', 'ParentComponentPrimitiveId', 'PrimitiveLock', 'Designator', 'Rotation', 'Text', 'FontSize',
	'PourName', 'PourFillMethod', 'PourPriority', 'ComplexPolygon', 'Polygon', 'RegionName', 'RuleType', 'Name', 'Footprint',
];

const PRIMITIVE_API = {
	line: 'pcb_PrimitiveLine', arc: 'pcb_PrimitiveArc', via: 'pcb_PrimitiveVia', polyline: 'pcb_PrimitivePolyline',
	pour: 'pcb_PrimitivePour', fill: 'pcb_PrimitiveFill', region: 'pcb_PrimitiveRegion', string: 'pcb_PrimitiveString',
	pad: 'pcb_PrimitivePad', component: 'pcb_PrimitiveComponent', dimension: 'pcb_PrimitiveDimension', image: 'pcb_PrimitiveImage',
};
const TYPE_TO_API = {
	Line: 'pcb_PrimitiveLine', Arc: 'pcb_PrimitiveArc', Via: 'pcb_PrimitiveVia', Polyline: 'pcb_PrimitivePolyline', Pour: 'pcb_PrimitivePour',
	Fill: 'pcb_PrimitiveFill', Region: 'pcb_PrimitiveRegion', String: 'pcb_PrimitiveString', Pad: 'pcb_PrimitivePad',
	Component: 'pcb_PrimitiveComponent', Dimension: 'pcb_PrimitiveDimension', Image: 'pcb_PrimitiveImage', Object: 'pcb_PrimitiveObject',
	Poured: 'pcb_PrimitivePoured', Attribute: 'pcb_PrimitiveAttribute',
};

// ----------------------------------------------------------------- 回應

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `錯誤：${e?.message ?? e}${e?.remoteStack ? `\n\nEasyEDA stack:\n${e.remoteStack}` : ''}` }] });

function wrap(handler) {
	return async (args) => {
		try {
			return json(await handler(args ?? {}));
		} catch (e) {
			return fail(e);
		}
	};
}

function batchSummary(results, label) {
	const okCount = results.filter((r) => r.ok).length;
	const errors = results.map((r, i) => (r.ok ? null : { index: i, error: r.error })).filter(Boolean);
	return { [label]: okCount, ...(errors.length ? { errors } : {}) };
}

// ----------------------------------------------------------------- schema 片段

const Point = z.tuple([z.number(), z.number()]).describe('[x, y] mm');
const LayerArg = z.union([z.string(), z.number()]);
const Shape = z
	.object({
		rect: z.object({ x: z.number().describe('左下角 X (mm)'), y: z.number().describe('左下角 Y (mm)'), width: z.number(), height: z.number(), corner_radius: z.number().optional() }).optional(),
		points: z.array(Point).min(3).optional().describe('多邊形頂點 (mm)，會自動閉合'),
		circle: z.object({ cx: z.number(), cy: z.number(), radius: z.number() }).optional(),
	})
	.describe('rect / points / circle 三擇一');

// ----------------------------------------------------------------- 註冊

/**
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {import('./bridge.js').Bridge} bridge
 */
export function registerTools(server, bridge) {
	const tool = (name, description, inputSchema, handler, annotations) =>
		server.registerTool(name, { description, inputSchema, annotations }, wrap(handler));
	const readOnly = { readOnlyHint: true };

	async function allComponents() {
		return (await bridge.call('pcb_PrimitiveComponent.getAll', [], { fields: COMPONENT_FIELDS })) ?? [];
	}

	/**
	 * primitive ID → 所屬 API 模組。
	 * EasyEDA 3.2.209 的 pcb_Primitive.getPrimitiveTypeByPrimitiveId 是空殼（永遠 undefined），
	 * 所以改成對每個圖元類別呼叫 get(ids)，看誰認得這些 ID。
	 */
	async function classifyIds(ids) {
		const apis = [...new Set(Object.values(TYPE_TO_API))].filter((a) => !['pcb_PrimitivePoured', 'pcb_PrimitiveAttribute'].includes(a));
		const results = await bridge.batch(apis.map((api) => ({ path: `${api}.get`, args: [ids], fields: ['PrimitiveId'] })), { stopOnError: false });
		const map = {};
		results.forEach((r, i) => {
			if (!r.ok || !Array.isArray(r.result)) return;
			for (const p of r.result) if (p?.PrimitiveId && !map[p.PrimitiveId]) map[p.PrimitiveId] = apis[i];
		});
		return map;
	}

	async function resolveComponent(ref, comps) {
		comps ??= await allComponents();
		const c = comps.find((c) => c.PrimitiveId === ref) ?? comps.find((c) => String(c.Designator).toLowerCase() === String(ref).toLowerCase());
		if (!c) throw new Error(`找不到元件 ${ref}`);
		return c;
	}

	// ---------------------------------------------------------------- 狀態 / 資訊

	tool('easyeda_status', '檢查 MCP 與 EasyEDA Pro 的連線狀態，以及目前開啟的工程 / 文件。開始操作前先呼叫一次。', {}, async () => {
		const status = bridge.status();
		if (!bridge.activeClient) return { ...status, connected: false, hint: '在 EasyEDA Pro 的 PCB 編輯器選單點「MCP → 連線 MCP server」' };
		const ping = await bridge.request('ping', {}, 5000);
		const context = await bridge.request('context', {}, 10000);
		return { ...status, connected: true, ping, context };
	}, readOnly);

	tool('pcb_get_info', '取得目前 PCB 的概況：銅層數、板框外框、元件 / 走線 / 過孔 / 鋪銅數量、網路數。', {}, async () => {
		const results = await bridge.batch(
			[
				{ path: 'pcb_Layer.getTheNumberOfCopperLayers', args: [] },
				{ path: 'pcb_PrimitivePolyline.getAll', args: [U, 11], fields: ['PrimitiveId', 'Polygon', 'LineWidth'] },
				{ path: 'pcb_PrimitiveComponent.getAllPrimitiveId', args: [] },
				{ path: 'pcb_PrimitiveLine.getAllPrimitiveId', args: [] },
				{ path: 'pcb_PrimitiveVia.getAllPrimitiveId', args: [] },
				{ path: 'pcb_PrimitivePour.getAll', args: [], fields: ['PrimitiveType', 'PrimitiveId', 'Net', 'Layer', 'PourName', 'ComplexPolygon'] },
				{ path: 'pcb_Net.getAllNetsName', args: [] },
			],
			{ stopOnError: false },
		);
		const v = (i) => (results[i]?.ok ? results[i].result : { error: results[i]?.error });
		const outlines = Array.isArray(v(1)) ? v(1) : [];
		return {
			copper_layers: v(0),
			board_outline: outlines.map((o) => ({ id: o.PrimitiveId, bbox: polygonBBox(o.Polygon?.$polygon) })),
			counts: {
				components: v(2)?.length,
				track_segments: v(3)?.length,
				vias: v(4)?.length,
				nets: v(6)?.length,
			},
			pours: Array.isArray(v(5)) ? v(5).map(fmtPrimitive) : v(5),
			units: 'mm（座標為 EasyEDA PCB 資料座標，Y 向上）',
		};
	}, readOnly);

	tool('pcb_list_components', '列出 PCB 上所有元件（位號、封裝、位置 mm、角度、層）。', {
		filter: z.string().optional().describe('位號正規表示式，例如 "^U" 或 "^(R|C)\\d+"'),
	}, async ({ filter }) => {
		let comps = (await allComponents()).map(fmtComponent);
		if (filter) {
			const re = new RegExp(filter, 'i');
			comps = comps.filter((c) => re.test(c.designator ?? ''));
		}
		comps.sort((a, b) => String(a.designator).localeCompare(String(b.designator), undefined, { numeric: true }));
		return { count: comps.length, components: comps };
	}, readOnly);

	tool('pcb_get_component', '取得單一元件的詳細資料與所有焊盤（腳號、網路、絕對座標 mm），佈線前用來找接點。', {
		ref: z.string().describe('位號（如 U1）或 primitive ID'),
	}, async ({ ref }) => {
		const c = await resolveComponent(ref);
		const pads = (await bridge.call('pcb_PrimitiveComponent.getAllPinsByPrimitiveId', [c.PrimitiveId], { fields: PAD_FIELDS })) ?? [];
		return { ...fmtComponent(c), pads: pads.map(fmtPrimitive).map(({ component_id, type, ...p }) => p) };
	}, readOnly);

	tool('pcb_list_nets', '列出所有網路名稱。', {
		filter: z.string().optional().describe('網路名稱正規表示式'),
	}, async ({ filter }) => {
		let nets = (await bridge.call('pcb_Net.getAllNetsName', [])) ?? [];
		if (filter) {
			const re = new RegExp(filter, 'i');
			nets = nets.filter((n) => re.test(n));
		}
		return { count: nets.length, nets };
	}, readOnly);

	tool('pcb_get_net', '取得某網路的所有焊盤（含所屬元件位號）、已畫的走線與過孔、目前走線長度。用來規劃佈線。', {
		net: z.string(),
	}, async ({ net }) => {
		const [prims, comps, len] = await Promise.all([
			bridge.call('pcb_Net.getAllPrimitivesByNet', [net], { fields: GENERIC_FIELDS }),
			allComponents(),
			bridge.call('pcb_Net.getNetLength', [net]).catch(() => null),
		]);
		const desig = Object.fromEntries(comps.map((c) => [c.PrimitiveId, c.Designator]));
		const out = { net, length_mm: toMm(len), pads: [], tracks: [], vias: [], other: [] };
		for (const p of (prims ?? []).map(fmtPrimitive)) {
			if (p.type === 'ComponentPad' || p.type === 'Pad') out.pads.push({ ref: desig[p.component_id] ?? null, number: p.number, x: p.x, y: p.y, layer: p.layer, id: p.id });
			else if (p.type === 'Line' || p.type === 'Arc') out.tracks.push(p);
			else if (p.type === 'Via') out.vias.push(p);
			else out.other.push(p);
		}
		return out;
	}, readOnly);

	tool('pcb_list_primitives', '列出指定類型的圖元（可依網路 / 層過濾）。', {
		type: z.enum(Object.keys(PRIMITIVE_API)),
		net: z.string().optional(),
		layer: LayerArg.optional(),
		limit: z.number().int().positive().default(500),
	}, async ({ type, net, layer, limit }) => {
		const api = PRIMITIVE_API[type];
		const L = layer === undefined ? U : layerId(layer);
		const N = net === undefined ? U : net;
		const argsByType = {
			line: [N, L], arc: [N, L], polyline: [N, L], pour: [N, L], fill: [L, N], via: [N],
			region: [L], string: [L], pad: [L, N], component: [L], dimension: [L], image: [L],
		};
		const list = (await bridge.call(`${api}.getAll`, argsByType[type], { fields: type === 'component' ? COMPONENT_FIELDS : GENERIC_FIELDS })) ?? [];
		return { count: list.length, truncated: list.length > limit, items: list.slice(0, limit).map(fmtPrimitive) };
	}, readOnly);

	tool('pcb_get_selection', '取得使用者目前在 EasyEDA 中選取的圖元。', {}, async () => {
		const list = (await bridge.call('pcb_SelectControl.getAllSelectedPrimitives', [], { fields: GENERIC_FIELDS })) ?? [];
		return { count: list.length, items: list.map(fmtPrimitive) };
	}, readOnly);

	// ---------------------------------------------------------------- 繪製

	tool('pcb_set_board_outline', '畫板框（Board Outline 層的封閉折線）。可選擇先刪除現有板框。', {
		shape: Shape,
		line_width: z.number().default(0.254).describe('mm'),
		replace_existing: z.boolean().default(true),
	}, async ({ shape, line_width, replace_existing }) => {
		let removed = 0;
		if (replace_existing) {
			const ids = (await bridge.call('pcb_PrimitivePolyline.getAllPrimitiveId', [U, 11])) ?? [];
			if (ids.length) {
				await bridge.call('pcb_PrimitivePolyline.delete', [ids]);
				removed = ids.length;
			}
		}
		const src = polygonFromShape(shape);
		const res = await bridge.call('pcb_PrimitivePolyline.create', ['', 11, { $polygon: src }, toMil(line_width), false], { fields: ['PrimitiveType', 'PrimitiveId', 'Layer', 'Polygon', 'LineWidth', 'Net'] });
		return { removed_outlines: removed, created: fmtPrimitive(res) };
	});

	tool('pcb_route_track', '沿著一串點畫走線（每兩點一段直線）。換層請在換層點另外呼叫 pcb_add_vias。', {
		net: z.string().describe('網路名稱；空字串代表無網路'),
		layer: LayerArg.default('top').describe('top / bottom / inner1… 或層 ID'),
		width: z.number().default(0.254).describe('線寬 mm'),
		points: z.array(Point).min(2),
	}, async ({ net, layer, width, points }) => {
		const L = layerId(layer);
		const calls = [];
		for (let i = 0; i < points.length - 1; i++) {
			const [x1, y1] = points[i];
			const [x2, y2] = points[i + 1];
			if (x1 === x2 && y1 === y2) continue;
			calls.push({ path: 'pcb_PrimitiveLine.create', args: [net, L, toMil(x1), toMil(y1), toMil(x2), toMil(y2), toMil(width), false], fields: ['PrimitiveId'] });
		}
		const results = await bridge.batch(calls);
		return { ...batchSummary(results, 'segments_created'), ids: results.filter((r) => r.ok).map((r) => r.result?.PrimitiveId) };
	});

	tool('pcb_add_vias', '新增一或多個過孔。', {
		vias: z.array(z.object({
			x: z.number(), y: z.number(),
			net: z.string().default(''),
			drill: z.number().default(0.3).describe('孔徑 mm'),
			diameter: z.number().default(0.6).describe('外徑 mm'),
		})).min(1),
	}, async ({ vias }) => {
		const calls = vias.map((v) => ({ path: 'pcb_PrimitiveVia.create', args: [v.net, toMil(v.x), toMil(v.y), toMil(v.drill), toMil(v.diameter)], fields: ['PrimitiveId'] }));
		const results = await bridge.batch(calls, { stopOnError: false });
		return { ...batchSummary(results, 'vias_created'), ids: results.map((r) => (r.ok ? r.result?.PrimitiveId : null)) };
	});

	tool('pcb_add_copper_pour', '新增鋪銅區（例如 GND 鋪銅）。shape 省略時沿用目前板框。', {
		net: z.string(),
		layer: LayerArg.default('top'),
		shape: Shape.optional(),
		fill: z.enum(['solid', 'grid', 'grid45']).default('solid'),
		name: z.string().optional(),
		priority: z.number().int().optional(),
		preserve_islands: z.boolean().default(false).describe('保留孤島'),
	}, async ({ net, layer, shape, fill, name, priority, preserve_islands }) => {
		let polySrc;
		if (shape) polySrc = polygonFromShape(shape);
		else {
			const outlines = (await bridge.call('pcb_PrimitivePolyline.getAll', [U, 11], { fields: ['Polygon'] })) ?? [];
			polySrc = outlines[0]?.Polygon?.$polygon;
			if (!polySrc) throw new Error('目前沒有板框，請先 pcb_set_board_outline 或提供 shape');
		}
		const method = { solid: 'solid', grid: '90grid', grid45: '45grid' }[fill];
		const res = await bridge.call(
			'pcb_PrimitivePour.create',
			[net, layerId(layer), { $polygon: polySrc }, method, preserve_islands, name ?? U, priority ?? U, U, false],
			{ fields: ['PrimitiveType', 'PrimitiveId', 'Net', 'Layer', 'PourName', 'PourFillMethod', 'PourPriority', 'ComplexPolygon'] },
		);
		return { created: fmtPrimitive(res), note: '鋪銅建立後若沒顯示填充，可在 EasyEDA 按「重建鋪銅」(Shift+B)' };
	});

	tool('pcb_add_keepout', '新增禁止區（Region），例如天線下方禁止走線 / 鋪銅。', {
		layer: LayerArg.default('top').describe('top / bottom / inner… 或 multi（所有層）'),
		shape: Shape,
		rules: z.array(z.enum(['no_components', 'no_wires', 'no_fills', 'no_pours', 'no_inner_planes'])).default(['no_wires', 'no_pours', 'no_fills']),
		name: z.string().optional(),
	}, async ({ layer, shape, rules, name }) => {
		const map = { no_components: 2, no_wires: 5, no_fills: 6, no_pours: 7, no_inner_planes: 8 };
		const res = await bridge.call('pcb_PrimitiveRegion.create', [layerId(layer), { $polygon: polygonFromShape(shape) }, rules.map((r) => map[r]), name ?? U], {
			fields: ['PrimitiveType', 'PrimitiveId', 'Layer', 'RegionName', 'RuleType', 'ComplexPolygon'],
		});
		return { created: fmtPrimitive(res) };
	});

	tool('pcb_add_fill', '新增實心銅箔 / 絲印填充（Fill），例如散熱銅面。', {
		layer: LayerArg.default('top'),
		shape: Shape,
		net: z.string().default(''),
	}, async ({ layer, shape, net }) => {
		const res = await bridge.call('pcb_PrimitiveFill.create', [layerId(layer), { $polygon: polygonFromShape(shape) }, net], {
			fields: ['PrimitiveType', 'PrimitiveId', 'Net', 'Layer', 'ComplexPolygon'],
		});
		return { created: fmtPrimitive(res) };
	});

	tool('pcb_draw_polyline', '在任意層畫折線（絲印線條、機構層標記、文件層註記等；不含板框，板框請用 pcb_set_board_outline）。', {
		layer: LayerArg,
		points: z.array(Point).min(2),
		width: z.number().default(0.15).describe('mm'),
		net: z.string().default(''),
		closed: z.boolean().default(false),
	}, async ({ layer, points, width, net, closed }) => {
		const res = await bridge.call('pcb_PrimitivePolyline.create', [net, layerId(layer), { $polygon: polygonFromPoints(points, { close: closed }) }, toMil(width), false], {
			fields: ['PrimitiveType', 'PrimitiveId', 'Net', 'Layer', 'Polygon', 'LineWidth'],
		});
		return { created: fmtPrimitive(res) };
	});

	tool('pcb_add_text', '新增文字（預設頂層絲印）。', {
		text: z.string(),
		x: z.number(), y: z.number(),
		layer: LayerArg.default('top_silk'),
		size: z.number().default(1.0).describe('字高 mm'),
		stroke: z.number().default(0.15).describe('筆畫寬 mm'),
		rotation: z.number().default(0),
		align: z.enum(['left_top', 'left_middle', 'left_bottom', 'center_top', 'center', 'center_bottom', 'right_top', 'right_middle', 'right_bottom']).default('center'),
		mirror: z.boolean().optional().describe('預設：底層自動鏡像'),
	}, async ({ text, x, y, layer, size, stroke, rotation, align, mirror }) => {
		const alignMap = { left_top: 1, left_middle: 2, left_bottom: 3, center_top: 4, center: 5, center_bottom: 6, right_top: 7, right_middle: 8, right_bottom: 9 };
		const L = layerId(layer);
		const mir = mirror ?? [2, 4, 6, 8, 10].includes(L);
		const res = await bridge.call('pcb_PrimitiveString.create', [L, toMil(x), toMil(y), text, 'default', toMil(size), toMil(stroke), alignMap[align], rotation, false, 0, mir, false], {
			fields: ['PrimitiveType', 'PrimitiveId', 'Layer', 'X', 'Y', 'Text', 'FontSize', 'Rotation'],
		});
		return { created: fmtPrimitive(res) };
	});

	// ---------------------------------------------------------------- 元件擺放

	tool('pcb_move_components', '移動 / 旋轉 / 換面一或多個元件。', {
		moves: z.array(z.object({
			ref: z.string().describe('位號或 primitive ID'),
			x: z.number().optional(), y: z.number().optional(),
			rotation: z.number().optional().describe('絕對角度（度）'),
			layer: z.enum(['top', 'bottom']).optional(),
			relative: z.boolean().default(false).describe('true 時 x/y 為位移量'),
			lock: z.boolean().optional(),
		})).min(1),
	}, async ({ moves }) => {
		const comps = await allComponents();
		const calls = [];
		for (const m of moves) {
			const c = await resolveComponent(m.ref, comps);
			const prop = {};
			if (m.x !== undefined) prop.x = m.relative ? c.X + toMil(m.x) : toMil(m.x);
			if (m.y !== undefined) prop.y = m.relative ? c.Y + toMil(m.y) : toMil(m.y);
			if (m.rotation !== undefined) prop.rotation = m.rotation;
			if (m.layer) prop.layer = layerId(m.layer);
			if (m.lock !== undefined) prop.primitiveLock = m.lock;
			calls.push({ path: 'pcb_PrimitiveComponent.modify', args: [c.PrimitiveId, prop], fields: COMPONENT_FIELDS });
		}
		const results = await bridge.batch(calls, { stopOnError: false });
		return { ...batchSummary(results, 'moved'), components: results.map((r) => (r.ok ? fmtComponent(r.result) : null)) };
	});

	tool('pcb_place_component', '從嘉立創系統庫放置元件到 PCB（依 LCSC 編號，例如 C25804）。注意：直接放在 PCB 的元件沒有原理圖網路，正規流程是在原理圖放好後用 pcb_import_changes。', {
		lcsc: z.string(),
		x: z.number(), y: z.number(),
		rotation: z.number().default(0),
		layer: z.enum(['top', 'bottom']).default('top'),
	}, async ({ lcsc, x, y, rotation, layer }) => {
		const dev = await bridge.call('lib_Device.getByLcscIds', [lcsc]);
		if (!dev) throw new Error(`系統庫找不到 ${lcsc}`);
		const res = await bridge.call('pcb_PrimitiveComponent.create', [{ libraryUuid: dev.libraryUuid, uuid: dev.uuid }, layerId(layer), toMil(x), toMil(y), rotation, false], { fields: COMPONENT_FIELDS });
		return { device: { name: dev.name, footprint: dev.footprintName ?? dev.footprint?.name }, created: res ? fmtComponent(res) : null };
	});

	// ---------------------------------------------------------------- 修改 / 刪除

	tool('pcb_delete_primitives', '依 primitive ID 刪除圖元（自動判斷類型）。', {
		ids: z.array(z.string()).min(1),
	}, async ({ ids }) => {
		const found = await classifyIds(ids);
		const groups = {};
		const unknown = [];
		for (const id of ids) {
			const api = found[id];
			if (api) (groups[api] ??= []).push(id);
			else unknown.push(id);
		}
		const results = await bridge.batch(Object.entries(groups).map(([api, list]) => ({ path: `${api}.delete`, args: [list] })), { stopOnError: false });
		return {
			deleted: Object.fromEntries(Object.entries(groups).map(([api, list], i) => [api.replace('pcb_Primitive', ''), results[i]?.ok ? list.length : `失敗：${results[i]?.error}`])),
			...(unknown.length ? { not_found: unknown } : {}),
		};
	}, { destructiveHint: true });

	tool('pcb_clear_net_routing', '刪除某網路（或全部）的走線、圓弧走線與過孔。', {
		net: z.string().optional().describe('省略則清除整張板子的佈線'),
		include_vias: z.boolean().default(true),
	}, async ({ net, include_vias }) => {
		const N = net ?? U;
		const [lines, arcs, vias] = await Promise.all([
			bridge.call('pcb_PrimitiveLine.getAllPrimitiveId', [N]),
			bridge.call('pcb_PrimitiveArc.getAllPrimitiveId', [N]),
			include_vias ? bridge.call('pcb_PrimitiveVia.getAllPrimitiveId', [N]) : [],
		]);
		const calls = [];
		if (lines?.length) calls.push({ path: 'pcb_PrimitiveLine.delete', args: [lines] });
		if (arcs?.length) calls.push({ path: 'pcb_PrimitiveArc.delete', args: [arcs] });
		if (vias?.length) calls.push({ path: 'pcb_PrimitiveVia.delete', args: [vias] });
		if (calls.length) await bridge.batch(calls);
		return { net: net ?? '(all)', deleted: { lines: lines?.length ?? 0, arcs: arcs?.length ?? 0, vias: vias?.length ?? 0 } };
	}, { destructiveHint: true });

	tool('pcb_modify_primitive', '修改單一圖元的屬性。property 直接傳給 EasyEDA modify()，長度欄位請用 mm，會自動換算（x, y, startX, startY, endX, endY, lineWidth, holeDiameter, diameter, fontSize）。', {
		id: z.string(),
		property: z.record(z.string(), z.any()),
	}, async ({ id, property }) => {
		const api = (await classifyIds([id]))[id];
		if (!api) throw new Error(`找不到圖元 ${id}`);
		const LEN = ['x', 'y', 'startX', 'startY', 'endX', 'endY', 'lineWidth', 'holeDiameter', 'diameter', 'fontSize', 'topLeftX', 'topLeftY', 'width', 'height'];
		const prop = {};
		for (const [k, v] of Object.entries(property)) {
			if (LEN.includes(k) && typeof v === 'number') prop[k] = toMil(v);
			else if (k === 'layer') prop[k] = layerId(v);
			else prop[k] = v;
		}
		const res = await bridge.call(`${api}.modify`, [id, prop], { fields: GENERIC_FIELDS });
		return { modified: fmtPrimitive(res) };
	});

	// ---------------------------------------------------------------- 文件操作

	tool('pcb_import_changes', '從原理圖更新 PCB（等同「設計 → 從原理圖更新 PCB」）。會在 EasyEDA 跳出「導入變更」對話框，需要使用者按確認；工具會等待並回報新增 / 刪除的元件與網路。新元件通常落在板框外，之後用 pcb_move_components 擺放。', {
		wait_seconds: z.number().int().min(0).max(600).default(120).describe('等使用者在對話框按確認的最長秒數'),
	}, async ({ wait_seconds }) => {
		const snapshot = async () => {
			const [comps, nets] = await Promise.all([bridge.call('pcb_PrimitiveComponent.getAll', [], { fields: ['PrimitiveId', 'Designator'] }), bridge.call('pcb_Net.getAllNetsName', [])]);
			return { comps: new Map((comps ?? []).map((c) => [c.PrimitiveId, c.Designator])), nets: new Set(nets ?? []) };
		};
		const before = await snapshot();
		// EasyEDA 3.2.209 實測：不論 force 為何都會跳出「導入變更」確認對話框，呼叫會立刻回傳 true，
		// 實際匯入要等使用者按確認後才發生，所以這裡改用輪詢元件 / 網路差異來判斷結果
		const ok = await bridge.call('pcb_Document.importChanges', [U, false], { timeoutMs: 30000 });
		const deadline = Date.now() + wait_seconds * 1000;
		let after = before;
		let changed = false;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 1500));
			after = await snapshot();
			changed = after.comps.size !== before.comps.size || [...after.comps.keys()].some((k) => !before.comps.has(k)) || after.nets.size !== before.nets.size || [...after.nets].some((n) => !before.nets.has(n));
			if (changed) {
				// 匯入是分批套用的，再等一下直到穩定
				await new Promise((r) => setTimeout(r, 2000));
				after = await snapshot();
				break;
			}
		}
		const added = [...after.comps].filter(([k]) => !before.comps.has(k)).map(([, d]) => d);
		const removed = [...before.comps].filter(([k]) => !after.comps.has(k)).map(([, d]) => d);
		return {
			dialog_opened: ok,
			changed,
			...(changed ? {} : { hint: `${wait_seconds} 秒內沒偵測到變化：可能使用者還沒按確認、取消了對話框，或原理圖與 PCB 本來就一致` }),
			components_added: added,
			components_removed: removed,
			nets_added: [...after.nets].filter((n) => !before.nets.has(n)),
			nets_removed: [...before.nets].filter((n) => !after.nets.has(n)),
			component_count: after.comps.size,
		};
	});

	tool('pcb_run_drc', '執行 DRC 設計規則檢查並回傳違規清單。', {
		strict: z.boolean().default(false),
		limit: z.number().int().positive().default(100),
	}, async ({ strict, limit }) => {
		const res = await bridge.call('pcb_Drc.check', [strict, false, true], { timeoutMs: 180000 });
		// 回傳是巢狀分類 {name, list:[{name, list:[違規…]}]}，攤平成一筆一筆
		const leaves = [];
		const walk = (n) => {
			if (Array.isArray(n)) return n.forEach(walk);
			if (!n || typeof n !== 'object') return;
			if (n.errorType || n.obj1) return leaves.push(n);
			if (n.list) walk(n.list);
		};
		walk(res);
		const items = leaves.map((e) => {
			const ex = e.explanation ?? {};
			const param = ex.param ?? {};
			let message = ex.str ?? '';
			message = message.replace(/\{(\w+)\}/g, (_, k) => (k === 'obj1' ? `${e.obj1?.typeName ?? ''}${e.obj1?.suffix ?? ''}` : k === 'obj2' ? `${e.obj2?.typeName ?? ''}${e.obj2?.suffix ?? ''}` : param[k] ?? `{${k}}`));
			const pos = ex.errData?.position;
			return {
				type: e.errorType, objects: e.errorObjType, rule: e.ruleName, layer: e.layer, message,
				// DRC 座標是引擎原生單位 10 mil（實測 x=59.055 對應 15 mm）
				...(pos ? { at: [toMm(pos.x * 10), toMm(pos.y * 10)] } : {}),
			};
		});
		const summary = {};
		for (const i of items) summary[`${i.type} / ${i.objects}`] = (summary[`${i.type} / ${i.objects}`] ?? 0) + 1;
		return { violations: items.length, summary, truncated: items.length > limit, items: items.slice(0, limit) };
	}, readOnly);

	tool('pcb_autoroute', '執行 EasyEDA 內建自動佈線（可能需要數分鐘）。', {
		nets: z.array(z.string()).optional().describe('只佈這些網路；省略則全部'),
		layers: z.array(LayerArg).optional(),
	}, async ({ nets, layers }) => {
		const props = {};
		if (nets) props.RoutingNets = nets;
		if (layers) props.layers = layers.map(layerId);
		return bridge.call('pcb_Document.autoRouting', [props], { timeoutMs: 600000 });
	});

	tool('pcb_set_copper_layers', '設定銅層數（2、4、6…）。', {
		layers: z.number().int(),
	}, async ({ layers }) => ({ ok: await bridge.call('pcb_Layer.setTheNumberOfCopperLayers', [layers]) }));

	tool('pcb_zoom', '調整 EasyEDA 視圖：縮放到板框，或導航到指定區域 / 座標。', {
		region: z.object({ min_x: z.number(), min_y: z.number(), max_x: z.number(), max_y: z.number() }).optional(),
		point: Point.optional(),
	}, async ({ region, point }) => {
		if (region) return { ok: await bridge.call('pcb_Document.navigateToRegion', [toMil(region.min_x), toMil(region.max_x), toMil(region.max_y), toMil(region.min_y)]) };
		if (point) return { ok: await bridge.call('pcb_Document.navigateToCoordinates', [toMil(point[0]), toMil(point[1])]) };
		return { ok: await bridge.call('pcb_Document.zoomToBoardOutline', []) };
	}, readOnly);

	tool('pcb_save', '儲存目前 PCB 文件。', {}, async () => ({ ok: await bridge.call('pcb_Document.save', [], { timeoutMs: 60000 }) }));

	// ---------------------------------------------------------------- 萬用逃生口

	tool('eda_call', `直接呼叫任意 EasyEDA Pro API：eda.<path>(...args)。注意單位是 EasyEDA 原生（PCB 為 mil，1 mm = 39.3701 mil），座標笛卡爾 Y 向上；多邊形參數傳 {"$polygon": [...]}（SVG 座標，Y 向下）；要省略某參數傳 {"$undefined": true}。API 參考在 EasyEDA 安裝目錄 resources/app/assets/pro-api/*/api-types.d.ts。`, {
		path: z.string().describe('例如 "pcb_PrimitiveArc.create"、"pcb_Layer.getAllLayers"'),
		args: z.array(z.any()).default([]),
		fields: z.array(z.string()).optional().describe('只回傳這些 getState_ 欄位，例如 ["PrimitiveId","X","Y"]'),
		timeout_ms: z.number().int().optional(),
	}, async ({ path, args, fields, timeout_ms }) => bridge.call(path, args, { fields, timeoutMs: timeout_ms }));
}
