-- ============================================================
-- EVOPAY VSCU CASHIER SYSTEM — FULL DATABASE SCHEMA
-- KRA eTIMS COMPLIANT
-- ============================================================

-- ============================================================
-- 1. SALES (Parent table for all transactions)
-- ============================================================
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT UNIQUE,
  customer TEXT,
  customer_pin TEXT,
  subtotal REAL,
  tax REAL,
  total REAL,
  payment_method TEXT,
  sales_type TEXT DEFAULT 'N',
  receipt_type TEXT DEFAULT 'S',
  status TEXT DEFAULT 'Pending',
  synced INTEGER DEFAULT 0,
  synced_at TEXT,
  vscu_signature TEXT,
  receipt_no TEXT,
  internal_data TEXT,
  date TEXT,
  created_at TEXT
);

-- ============================================================
-- 2. SALES ITEMS (Line items per sale)
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER,
  item_seq INTEGER,
  item_cd TEXT,
  item_name TEXT,
  item_cls_cd TEXT,
  quantity INTEGER,
  price REAL,
  tax_type TEXT,
  tax_amount REAL,
  total REAL,
  discount_rate REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  FOREIGN KEY (sale_id) REFERENCES sales(id)
);

-- ============================================================
-- 3. ITEMS (Product catalog — FULL KRA FIELDS)
-- ============================================================
CREATE TABLE IF NOT EXISTS items (
  -- Core
  item_cd TEXT PRIMARY KEY,
  item_name TEXT,
  item_std_nm TEXT,
  item_cls_cd TEXT,
  item_ty_cd TEXT DEFAULT '1',          -- 1=Goods, 2=Service
  
  -- Pricing
  price REAL,
  grp_prc_l1 REAL,
  grp_prc_l2 REAL,
  grp_prc_l3 REAL,
  grp_prc_l4 REAL,
  grp_prc_l5 REAL,
  
  -- Tax
  tax_type TEXT,                        -- A, B, C
  
  -- Stock
  stock INTEGER DEFAULT 0,
  sfty_qty INTEGER DEFAULT 0,           -- Safety stock level
  
  -- Origin & Units
  orgn_nat_cd TEXT DEFAULT 'KE',
  pkg_unit_cd TEXT DEFAULT 'NT',
  qty_unit_cd TEXT DEFAULT 'U',
  
  -- Tracking
  btch_no TEXT,                         -- Batch/Lot number
  bcd TEXT,                             -- Barcode
  
  -- Status
  use_yn TEXT DEFAULT 'Y',
  isrc_aplcb_yn TEXT DEFAULT 'N',       -- Insurance applicable (Pharmacy)
  
  -- Additional
  add_info TEXT,
  
  -- Sync
  synced INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

-- ============================================================
-- 4. STOCK MOVEMENTS (Inventory in/out tracking)
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_cd TEXT,
  quantity INTEGER,
  type TEXT,                             -- IN or OUT
  reference TEXT,                        -- Sale ID, Purchase ID, etc.
  note TEXT,
  date TEXT,
  created_at TEXT
);

-- ============================================================
-- 5. CUSTOMERS (B2B)
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  cust_tin TEXT PRIMARY KEY,
  cust_name TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  synced INTEGER DEFAULT 0,
  created_at TEXT
);

-- ============================================================
-- 6. USERS (Cashiers/Operators)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  user_name TEXT,
  password TEXT,
  role TEXT DEFAULT 'cashier',
  use_yn TEXT DEFAULT 'Y',
  synced INTEGER DEFAULT 0,
  created_at TEXT
);

-- ============================================================
-- 7. PURCHASES (Supplier invoices — Input VAT)
-- ============================================================
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT UNIQUE,
  supplier_tin TEXT,
  supplier_name TEXT,
  subtotal REAL,
  tax REAL,
  total REAL,
  date TEXT,
  status TEXT DEFAULT 'Pending',
  synced INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER,
  item_cd TEXT,
  item_name TEXT,
  quantity INTEGER,
  price REAL,
  tax_type TEXT,
  tax_amount REAL,
  total REAL,
  FOREIGN KEY (purchase_id) REFERENCES purchases(id)
);

-- ============================================================
-- 8. IMPORTS (Customs records)
-- ============================================================
CREATE TABLE IF NOT EXISTS imports (
  task_cd TEXT PRIMARY KEY,
  dcl_de TEXT,                           -- Declaration date
  hs_cd TEXT,                            -- HS Code
  item_cd TEXT,
  item_name TEXT,
  quantity INTEGER,
  impt_item_stts_cd TEXT DEFAULT '0',    -- 0=Pending, 1=Matched
  synced INTEGER DEFAULT 0,
  created_at TEXT
);

-- ============================================================
-- 9. BRANCHES
-- ============================================================
CREATE TABLE IF NOT EXISTS branches (
  bhf_id TEXT PRIMARY KEY,
  bhf_name TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  use_yn TEXT DEFAULT 'Y',
  synced INTEGER DEFAULT 0,
  created_at TEXT
);

-- ============================================================
-- 10. BASIC DATA (KRA Reference Data)
-- ============================================================
CREATE TABLE IF NOT EXISTS tax_rates (
  code TEXT PRIMARY KEY,
  rate REAL,
  label TEXT
);

CREATE TABLE IF NOT EXISTS payment_types (
  code TEXT PRIMARY KEY,
  label TEXT
);

CREATE TABLE IF NOT EXISTS unit_codes (
  code TEXT PRIMARY KEY,
  label TEXT
);

CREATE TABLE IF NOT EXISTS classifications (
  code TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  use_yn TEXT DEFAULT 'Y'
);

-- ============================================================
-- 11. NOTICES (KRA notifications)
-- ============================================================
CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  content TEXT,
  date TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT
);

-- ============================================================
-- 12. SYNC QUEUE (Offline fallback)
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT,
  method TEXT DEFAULT 'POST',
  payload TEXT,
  retry_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  error TEXT,
  created_at TEXT
);

-- ============================================================
-- 13. SETTINGS (System configuration)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);

-- ============================================================
-- DEFAULT DATA
-- ============================================================

-- Tax Rates
INSERT OR IGNORE INTO tax_rates (code, rate, label) VALUES
('A', 0, 'Exempt'),
('B', 0.16, 'Standard'),
('C', 0, 'Zero Rated');

-- Payment Types
INSERT OR IGNORE INTO payment_types (code, label) VALUES
('01', 'Cash'),
('02', 'Card'),
('03', 'Mobile Money');

-- Unit Codes
INSERT OR IGNORE INTO unit_codes (code, label) VALUES
('NT', 'Each'),
('U', 'Unit'),
('KG', 'Kilogram'),
('L', 'Liter'),
('M', 'Meter');

-- Default Settings
INSERT OR IGNORE INTO settings (key, value) VALUES
('app_name', 'Evopay VSCU Cashier System'),
('version', '2.0.21'),
('environment', 'sandbox'),
('company_name', 'Evopay Limited'),
('company_pin', 'P000607989R'),
('branch_id', '00'),
('tax_rate_default', 'B');

-- Default Branch
INSERT OR IGNORE INTO branches (bhf_id, bhf_name, address, use_yn) VALUES
('00', 'Head Office', 'Nairobi, Kenya', 'Y');