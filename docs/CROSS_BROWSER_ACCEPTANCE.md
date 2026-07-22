# Cross-Browser Acceptance Test

## 使用資料

第一輪只使用合成測試資料，不使用真實交易明細。

範例：

| 日期 | 交易類型 | 股票代號 | 幣別 | 購買股數 | 購買股價 | 原幣金額 |
|---|---|---|---|---:|---:|---:|
| 2026-01-05 | BUY | 2330 | TWD | 10 | 1000 | 10000 |
| 2026-02-03 | BUY | AAPL | USD | 2 | 200 | 400 |

## 驗收 A：第一次建立雲端版本

1. 使用 Chrome 通過 Cloudflare Access 登入。
2. 上傳測試 Excel 或 CSV。
3. 確認畫面先顯示解析結果、拒收列及新舊差異。
4. 確認更新。
5. 預期結果：
   - `Revision` 從 0 變成 1。
   - Dataset 狀態為 ACTIVE。
   - 交易筆數與測試檔一致。

## 驗收 B：跨瀏覽器還原

1. 關閉 Chrome。
2. 開啟 Edge 或另一個瀏覽器。
3. 使用相同 Email 通過 Cloudflare Access。
4. 不重新上傳任何檔案。
5. 預期結果：
   - 自動載入 Revision 1。
   - 檔名與交易筆數一致。
   - 交易明細一致。

## 驗收 C：更新新版

1. 在 Edge 上傳增加一筆交易的新版檔案。
2. 預期先看到：新增 1 筆、刪除 0 筆。
3. 確認更新。
4. 預期 Revision 從 1 變成 2。
5. 回到 Chrome 並重新整理。
6. 預期 Chrome 自動取得 Revision 2。

## 驗收 D：衝突保護

1. Chrome 與 Edge 同時停留在相同 Revision。
2. Chrome 先完成新版更新。
3. Edge 不重新整理，直接嘗試上傳另一版。
4. 預期 Edge 收到 `VERSION_CONFLICT`，不得覆蓋 Chrome 的新版。

## 驗收 E：失敗不破壞舊資料

1. 上傳包含錯誤日期、空白必要欄位或重複 row hash 的檔案。
2. 預期系統拒絕啟用。
3. 重新整理網站。
4. 預期原本 ACTIVE Dataset、Revision 與交易明細保持不變。

## 通過條件

五組測試全部通過，才可把 Draft PR 視為完成第一個 MVP vertical slice。
