# easyeda-mcp

讓 Claude（或任何 MCP client）直接操作 **EasyEDA Pro（嘉立創EDA專業版）PCB 編輯器** 的 MCP server。

## 架構

```
Claude Code ──stdio──▶ MCP server (server/index.js)
                          │  ws://127.0.0.1:49625（server 端監聽）
                          ▼
              EasyEDA Pro 內的 bridge 擴充 (extension/)
                          │  eda.pcb_PrimitiveLine.create(...) 等 pro-api
                          ▼
                     目前開啟的 PCB
```

- EasyEDA 擴充不能開 server，只能當 WebSocket client（`eda.sys_WebSocket.register`），所以由 MCP server 監聽、擴充連進來。
- 擴充刻意做得很薄：只做「呼叫 `eda.<模組>.<方法>(...)` + 把回傳的圖元物件序列化」。單位換算、走線拆段、板框、鋪銅等邏輯都在 server 端，**新增 / 修改工具不必重裝擴充**。
- 擴充每 3 秒嘗試重連，所以 EasyEDA 和 Claude 誰先開都可以。

## 安裝

需要 Node.js 20 以上與 EasyEDA Pro 3.2 以上（桌面版）。

1. 取得原始碼並安裝相依套件：
   ```powershell
   git clone https://github.com/junior941230/easyeda-mcp.git; cd easyeda-mcp; npm install
   ```
2. 取得擴充檔：從 [Releases](https://github.com/junior941230/easyeda-mcp/releases) 下載 `easyeda-mcp-bridge_v*.eext`，或自己打包（產生在 `extension/build/`）：
   ```powershell
   npm run build:ext
   ```
3. EasyEDA Pro → 上方選單「設定 → 擴展 → 擴展管理器」→「導入」，選上面那個 `.eext`。
4. 在擴展管理器裡點開 **EasyEDA MCP Bridge**，勾選 **「外部交互」權限**（沒開的話 WebSocket 會一直失敗）。
5. 開啟一個 PCB，上方選單會多一個 **MCP**，點「連線 MCP server」。右下角出現「EasyEDA MCP 已連線」即成功。
6. 在 MCP client 登記 server。Claude Code（在 easyeda-mcp 資料夾內執行）：
   ```powershell
   claude mcp add easyeda -- node "$PWD/server/index.js"
   ```
   或在專案的 `.mcp.json` 加入：
   ```json
   { "mcpServers": { "easyeda": { "command": "node", "args": ["<easyeda-mcp 的完整路徑>/server/index.js"] } } }
   ```
   重開 Claude Code 工作階段並允許此 MCP server。

## 工具（單位一律 mm，座標為 PCB 資料座標，Y 向上）

| 類別 | 工具 |
|---|---|
| 狀態 / 查詢 | `easyeda_status`、`pcb_get_info`、`pcb_list_components`、`pcb_get_component`（含焊盤座標與網路）、`pcb_list_nets`、`pcb_get_net`（焊盤 + 既有走線）、`pcb_list_primitives`、`pcb_get_selection` |
| 繪製 | `pcb_set_board_outline`（矩形 / 圓角 / 多邊形 / 圓）、`pcb_route_track`、`pcb_add_vias`、`pcb_add_copper_pour`、`pcb_add_keepout`、`pcb_add_fill`、`pcb_draw_polyline`、`pcb_add_text` |
| 擺放 | `pcb_move_components`、`pcb_place_component`（LCSC 編號） |
| 修改 / 刪除 | `pcb_modify_primitive`、`pcb_delete_primitives`、`pcb_clear_net_routing` |
| 文件 | `pcb_import_changes`（從原理圖更新）、`pcb_run_drc`、`pcb_autoroute`、`pcb_set_copper_layers`、`pcb_zoom`、`pcb_save` |
| 萬用 | `eda_call`：直接呼叫任何 `eda.*` API（原生 mil 單位） |

API 完整定義在 EasyEDA 安裝目錄：`C:\Program Files\easyeda-pro\resources\app\assets\pro-api\<版本>\api-types.d.ts`。

## 測試

```powershell
npm run test:mock
```

會啟動真正的 MCP server，並在 Node vm 裡跑**打包後的**擴充 + 假 `eda` 物件，跑過整條 MCP → WebSocket → 擴充 → API 的路徑。

命令列直接呼叫工具（工作階段沒載入 MCP 時也能用；會自己起一個 server 等擴充連線）：

```powershell
node server/cli.js easyeda_status pcb_get_info
```

```powershell
node server/cli.js pcb_route_track '{"net":"GND","layer":"top","points":[[0,0],[10,0]]}'
```

## 實機驗證結果（EasyEDA Pro 3.2.209、pro-api 0.3.59，2026-11-19）

| 項目 | 結果 |
|---|---|
| PCB API 單位 | **mil**（0603 焊盤中心距量到 1.51 mm、焊盤 0.81×0.86 mm） |
| 多邊形座標（板框、鋪銅、填充、禁止區） | 與圖元**同一座標系、Y 向上**。API 文件說要對 Y 取反是錯的（`POLYGON_Y_FLIP = false`） |
| ARC 角度 | 正值 = 逆時針（Y 向上座標系），圓角板框正確外凸 |
| 已實測可用 | 狀態、概況、元件列表 / 詳細、網路、圖元列表、選取、板框、走線、過孔、鋪銅、禁止區、絲印線、文字、移動元件、放置元件、修改、刪除、DRC、縮放、存檔、從原理圖更新 PCB（需在對話框按確認） |
| 尚未實測 | `pcb_autoroute`、`pcb_set_copper_layers`、`pcb_add_fill`、`activationEvents` 開機自動連線 |

### EasyEDA API 的已知怪癖（已在 server 端繞過）

- `pcb_Primitive.getPrimitiveTypeByPrimitiveId` 是空殼，永遠回傳 undefined → 改用各類別的 `get(ids)` 判斷類型。
- `pcb_Net.getAllPrimitivesByNet` 回傳引擎原始物件（`pcbItemPrimitiveType`、`center`…，座標只到 0.1 mil）→ `normalizeRaw()` 轉換。
- `pcb_Document.getPrimitivesInRegion` / `getPrimitiveAtPoint`：範圍內只要有板框等多邊形就丟「单多边形验证不通过」（它把路徑字串包成 `[pathString]` 才驗證）。本 MCP 沒用到，用 `eda_call` 呼叫時要注意。
- DRC 結果的座標和 `getPrimitivesBBox` 的內部值都是 10 mil 單位。
- 元件 `Name` 常是 `={Value}`、`={Manufacturer Part}` 範本 → 從 `OtherProperty` / `ManufacturerId` 展開。
- `pcb_Document.importChanges` / `sch_Document.importChanges` 的 `force` 參數無效：一律跳出「導入變更」確認對話框，並**立刻**回傳 `true`，實際匯入要等使用者按確認。`pcb_import_changes` 因此改成觸發對話框，再輪詢元件 / 網路差異並回報。匯入是全量同步，PCB 上原理圖沒有的元件會被刪掉，新元件會放在板框外。
- 用 `sch_PrimitiveComponent.create` 放的元件 `UniqueId` 是空字串，多顆會被判為重複，生成網表時 EasyEDA 自動改成 `gge1`、`gge2`…（日誌會出現「唯一 ID 與其他元件重複」）。不影響匯入，但之後做原理圖工具時應該在建立後用 `modify({uniqueId})` 給不重複的值。
- 原理圖 API（`sch_*`）只對目前使用中的分頁有效；要先 `dmt_EditorControl.openDocument(<頁面 uuid>)` 切過去。`sch_Netlist.getNetlist` 會卡住沒回應。

## 埠號衝突

同時開兩個 Claude 工作階段時，只有先啟動的 MCP server 能綁到 49625，後啟動的工具會回報 `EADDRINUSE`。後啟動的 server 會每 5 秒重試，先前那個關掉後就自動接手（0.1.1 起）。要兩邊同時用，把其中一個的 `EASYEDA_MCP_PORT` 改掉，並在 EasyEDA「MCP → 設定 server 位址…」改成同一個埠。

## 心跳與提示

- EasyEDA 在連線仍活著時再呼叫 `register()`，也會再觸發「已連線」回呼。擴充（0.1.1 起）只在「未連線 → 已連線」時跳提示。
- server 每 10 秒送應用層 `ping`，並在 hello 後回 `welcome`。擴充超過 30 秒沒收到任何訊息就判定斷線並重連；舊版 server 不送 `welcome`，擴充就不做逾時判斷。
