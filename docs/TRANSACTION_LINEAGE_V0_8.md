# Transaction lineage and valuation STALE controls v0.8

## Goal

同一份金融結果必須能回到精確的交易 Dataset、交易 Revision、估值 Snapshot 與計算版本。
交易更正後，既有估值不能偷偷套用新版交易而改變數字。

## Stable transaction identity

- `transactions.id`：單一 Dataset 內的實體資料列 ID。
- `transactions.transaction_id`：跨 Dataset Revision 的邏輯交易 ID。
- 完全相同的 `rowHash` 優先沿用邏輯 ID，因此單純換列順序不影響血緣。
- 同來源列、類型、標的與幣別的一對一更正可沿用邏輯 ID。
- 已移動的更正只有在日期、類型、標的與幣別皆能一對一配對時才沿用。
- 重複交易造成多對多候選時不猜測，建立新 ID 並在預覽顯示血緣不確定筆數。

## Valuation binding

新估值 Snapshot 必須保存：

- `transaction_dataset_id`
- `transaction_revision`

估值 API 永遠從該 Dataset 載入交易。交易更新後：

1. 舊估值仍使用原交易版本重建，因此金額可重現。
2. `freshness` 變為 `STALE`。
3. 估值、XIRR、歷史 NAV、TWR 與回撤顯示過期警告。
4. 使用者可用相同估值檔重新啟用，建立綁定新版交易的新估值 Revision。

## Cost and deployment boundary

本功能只使用既有 Worker、D1、React 與 GitHub Actions，不建立 R2、KV、排程、行情 API
或新的 Cloudflare 資源。Production 建立、備份／還原與版本操作屬後續里程碑。
