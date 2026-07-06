# DATA REGISTRY — machine-consumable files (upload this file to Dropbox /agent.skill/data_registry.md)
Rules: runner and reports consume ONLY files registered here. New files land in /Data/Inbox,
get auto-analyzed, appear in the confirmation email, and are registered only after human approval.
The live file always keeps the _CURRENT name; Dropbox version history is the archive.

## 1. Promo Calendar
- Path: /Data/Calendar/Promo_Calendar_CURRENT.xlsx
- Read: weekly tabs; B&M store promos = columns N & O; ecomm promo rows per day
- Cadence: seasonal update by marketing | Consumes: R1, R2, R5
## 2. PO Style Margins  (PENDING — Ashley providing)
- Path: /Data/Margins/PO_Style_Margins_CURRENT.xlsx
- Read: style/SKU -> cost; PO qty + date if present (enables sell-through %)
- Until present: cost = 24% x original ticket (76% IMU standard; jewelry/accessories 80-84%)
- Cadence: monthly | Consumes: R3 Returns, R6 Reorders, margin guardrails
## 3. Inventory  (FUTURE)
- Path: /Data/Inventory/Inventory_CURRENT.xlsx
- Read: style-level on-hand (replaces reconstructed inventory in R3)
- Cadence: weekly | Consumes: R3, R6
