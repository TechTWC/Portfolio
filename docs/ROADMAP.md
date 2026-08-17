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

狀態：已完成並進入 owner-only Personal Production v0.9。

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

狀態：核心版本與血緣已完成；管理工具仍待補。

- [x] 交易血緣、估值 Revision 綁定與 STALE 控制（v0.8）
- 資料版本列表
- 還原 ARCHIVED 版本
- 匯出標準化 CSV／JSON
- parser schema mapping UI
- 新增／刪除／修改明細預覽
- R2 原始檔備份，選配；個人使用階段不啟用，避免新增成本

## Phase 3 — portfolio analysis web UI

狀態：帳務、估值、XIRR、歷史 NAV、TWR 與回撤核心已完成；自動行情 v1
在 `codex/market-data-v1` 開發中，完整策略與現金流資料品質仍待後續。

- [x] Python golden dataset
- [x] TypeScript cash ledger
- [x] positions and cost basis
- [x] Point-in-Time valuation、XIRR、歷史 NAV、TWR、年化 TWR、最大／目前回撤
- [ ] daily equity curve（引擎與畫面既有；自動日行情接入與正式驗收中）
- [ ] Modified Dietz
- fees/tax/FX spread modes
- [x] portfolio dashboard 基礎頁

## Phase 4 — strategy comparison

狀態：尚未實作。自動行情 v1 先保存 SPY 與日資料，作為此 Phase 的共用底座。

- equal-principal comparison
- equal-cash-flow-timing comparison
- actual-wealth comparison
- true lump sum
- DCA next-trading-day execution
- benchmark mirror
- drawdown and recovery time
- forward excess-return evidence

## Phase 5 — production hardening

狀態：Access、D1、依賴安全、Production 人工部署 Gate 已完成第一輪；其餘待補。

- audit log
- scheduled backup/export
- [ ] market-data proxy and cache（v1 開發中：使用者觸發、append-only series segments；多來源 fallback 與排程未完成）
- corporate actions
- data source manifest
- mobile UX
- privacy/delete-all workflow
