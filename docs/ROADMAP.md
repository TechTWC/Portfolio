# Development Roadmap

## Phase 0 — correctness baseline

狀態：已完成第一輪。

- 一次性投入本金修正
- 外幣資金來源修正
- 外幣出金匯率修正
- strict ledger
- 非交易日順延
- raw price basis
- MDD 名稱、交易日分位數與基本測試

## Phase 1 — cross-browser vertical slice

狀態：GitHub／CI 已完成；完整上傳、驗證、差異預覽與快取流程正在 Draft PR #2，之後進行 Cloudflare 部署驗收。

驗收條件：

1. Browser A 登入並上傳交易明細。
2. D1 建立 ACTIVE Dataset v1。
3. 關閉 Browser A。
4. Browser B 使用同一 Email 登入。
5. 自動恢復相同交易明細。
6. Browser B 上傳 v2。
7. Browser A 重新載入取得 v2。
8. 舊 revision 嘗試更新時取得 409。

## Phase 2 — dataset operations

- 資料版本列表
- 還原 ARCHIVED 版本
- 匯出標準化 CSV／JSON
- parser schema mapping UI
- 新增／刪除／修改明細預覽
- R2 原始檔備份，選配

## Phase 3 — portfolio analysis web UI

- Python golden dataset
- TypeScript cash ledger
- positions and cost basis
- daily equity curve
- TWR、XIRR、Modified Dietz
- fees/tax/FX spread modes
- portfolio dashboard

## Phase 4 — strategy comparison

- equal-principal comparison
- equal-cash-flow-timing comparison
- actual-wealth comparison
- true lump sum
- DCA next-trading-day execution
- benchmark mirror
- drawdown and recovery time
- forward excess-return evidence

## Phase 5 — production hardening

- audit log
- scheduled backup/export
- market-data proxy and cache
- corporate actions
- data source manifest
- mobile UX
- privacy/delete-all workflow
