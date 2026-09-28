const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// RATE LIMITING
const rateLimitMap = new Map();

const rateLimit = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60000;
  const maxRequests = 100;

  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now });
    return next();
  }

  const userData = rateLimitMap.get(ip);
  const timeSinceFirst = now - userData.firstRequest;

  if (timeSinceFirst > windowMs) {
    rateLimitMap.set(ip, { count: 1, firstRequest: now });
    return next();
  }

  if (userData.count >= maxRequests) {
    return res.status(429).json({
      error: 'Too many requests. Please try again later.',
      retryAfter: Math.ceil((windowMs - timeSinceFirst) / 1000)
    });
  }

  userData.count++;
  rateLimitMap.set(ip, userData);
  next();
};

setInterval(() => {
  const now = Date.now();
  const windowMs = 60000;
  for (const [ip, data] of rateLimitMap) {
    if (now - data.firstRequest > windowMs) {
      rateLimitMap.delete(ip);
    }
  }
}, 300000);

// ============================================
// CREATE TABLES
// ============================================
const initTables = async () => {
  try {
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS payment_types (
        code TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        description TEXT
      )
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS tax_rates (
        code TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        rate REAL DEFAULT 0,
        description TEXT,
        updated_at TEXT
      )
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS unit_codes (
        code TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT
      )
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS code_classifications (
        cd_cls TEXT PRIMARY KEY,
        cd_cls_nm TEXT NOT NULL,
        use_yn TEXT DEFAULT 'Y',
        created_at TEXT,
        updated_at TEXT
      )
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS codes (
        cd_cls TEXT,
        cd TEXT,
        cd_nm TEXT NOT NULL,
        cd_desc TEXT,
        use_yn TEXT DEFAULT 'Y',
        user_dfn_cd1 TEXT,
        user_dfn_cd2 TEXT,
        synced INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT,
        PRIMARY KEY (cd_cls, cd)
      )
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS classifications (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        level INTEGER DEFAULT 1,
        use_yn TEXT DEFAULT 'Y',
        synced INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      )
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      )
    `);

    const count = await db.getAsync(`SELECT COUNT(*) as count FROM payment_types`);
    if (!count || count.count === 0) {
      const defaults = [
        ['01', 'Cash', 'Physical currency payment'],
        ['02', 'Card', 'Credit or Debit card payment'],
        ['03', 'Mobile Money', 'M-Pesa, Airtel Money, or other mobile wallet']
      ];
      for (const [code, label, desc] of defaults) {
        await db.runAsync(
          `INSERT OR IGNORE INTO payment_types (code, label, description) VALUES (?, ?, ?)`,
          [code, label, desc]
        );
      }
    }
    console.log('Tables initialized');
  } catch (error) {
    console.error('Init tables failed:', error.message);
  }
};

let tablesInitialized = false;
const initTablesOnce = async () => {
  if (!tablesInitialized) {
    await initTables();
    tablesInitialized = true;
  }
};

// ============================================
// VSCU PROXY ENDPOINTS
// ============================================

// Get Code List
router.post('/code/selectCodes', async (req, res) => {
  console.log('===== VSCU SELECT CODES PROXY =====');
  try {
    let { tin, bhfId, lastReqDt } = req.body;

    if (!tin) tin = process.env.TIN;
    if (!bhfId) bhfId = process.env.BHF_ID;
    if (!lastReqDt) lastReqDt = '20230328000000';

    const headers = {
      'tin': tin,
      'bhfId': bhfId,
      'cmckey': process.env.CMCKEY,
      'Content-Type': 'application/json'
    };

    const payload = { tin, bhfId, lastReqDt };

    console.log('Headers:', JSON.stringify(headers, null, 2));
    console.log('Payload:', JSON.stringify(payload, null, 2));
    console.log('Target:', `${vscuClient.baseUrl}/code/selectCodes`);

    const response = await axios.post(
      `${vscuClient.baseUrl}/code/selectCodes`,
      payload,
      { headers, timeout: 30000 }
    );

    console.log('Response Code:', response.data?.resultCd);
    console.log('Response Msg:', response.data?.resultMsg);
    console.log('clsList length:', response.data?.data?.clsList?.length || 0);

    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch codes:', error.message);
    if (error.response) {
      return res.status(error.response.status || 500).json(error.response.data);
    }
    res.status(500).json({ resultCd: '999', resultMsg: error.message });
  }
});

// Get Item Classification List
router.post('/itemClass/selectItemsClass', async (req, res) => {
  console.log('===== VSCU SELECT ITEM CLASS PROXY =====');
  try {
    let { tin, bhfId, lastReqDt } = req.body;

    if (!tin) tin = process.env.TIN;
    if (!bhfId) bhfId = process.env.BHF_ID;
    if (!lastReqDt) lastReqDt = '20180523000000';

    const headers = {
      'tin': tin,
      'bhfId': bhfId,
      'cmckey': process.env.CMCKEY,
      'Content-Type': 'application/json'
    };

    const payload = { tin, bhfId, lastReqDt };

    console.log('Headers:', JSON.stringify(headers, null, 2));
    console.log('Payload:', JSON.stringify(payload, null, 2));
    console.log('Target:', `${vscuClient.baseUrl}/itemClass/selectItemsClass`);

    const response = await axios.post(
      `${vscuClient.baseUrl}/itemClass/selectItemsClass`,
      payload,
      { headers, timeout: 30000 }
    );

    console.log('Response Code:', response.data?.resultCd);
    console.log('Response Msg:', response.data?.resultMsg);
    console.log('itemClsList length:', response.data?.data?.itemClsList?.length || 0);

    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch classifications:', error.message);
    if (error.response) {
      return res.status(error.response.status || 500).json(error.response.data);
    }
    res.status(500).json({ resultCd: '999', resultMsg: error.message });
  }
});

// ============================================
// BULK SAVE ENDPOINTS
// ============================================

router.post('/codes/bulk', async (req, res) => {
  console.log('===== BULK SAVE CODES =====');
  try {
    const clsList = req.body;
    if (!Array.isArray(clsList) || clsList.length === 0) {
      return res.status(400).json({ error: 'Invalid data' });
    }

    const now = new Date().toISOString();
    let totalCodes = 0;

    for (const cls of clsList) {
      await db.runAsync(
        `INSERT OR REPLACE INTO code_classifications 
         (cd_cls, cd_cls_nm, use_yn, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [cls.cdCls, cls.cdClsNm, cls.useYn || 'Y', now, now]
      );

      if (cls.dtlList && cls.dtlList.length > 0) {
        for (const dtl of cls.dtlList) {
          await db.runAsync(
            `INSERT OR REPLACE INTO codes 
             (cd_cls, cd, cd_nm, cd_desc, use_yn, user_dfn_cd1, user_dfn_cd2, synced, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            [
              cls.cdCls,
              dtl.cd,
              dtl.cdNm,
              dtl.cdDesc || null,
              dtl.useYn || 'Y',
              dtl.userDfnCd1 || null,
              dtl.userDfnCd2 || null,
              now,
              now
            ]
          );
          totalCodes++;
        }
      }
    }

    console.log(`Saved ${totalCodes} codes`);

    await syncCodesToDisplayTables();

    res.json({ success: true, saved: totalCodes });
  } catch (error) {
    console.error('Bulk save codes error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/classifications/bulk', async (req, res) => {
  console.log('===== BULK SAVE CLASSIFICATIONS =====');
  try {
    const itemClsList = req.body;
    if (!Array.isArray(itemClsList) || itemClsList.length === 0) {
      return res.status(400).json({ error: 'Invalid data' });
    }

    const now = new Date().toISOString();
    let saved = 0;

    for (const cls of itemClsList) {
      await db.runAsync(
        `INSERT OR REPLACE INTO classifications 
         (code, name, description, level, use_yn, synced, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          cls.itemClsCd,
          cls.itemClsNm,
          cls.itemClsDesc || null,
          cls.itemClsLvl || 1,
          cls.useYn || 'Y',
          now,
          now
        ]
      );
      saved++;
    }

    console.log(`Saved ${saved} classifications`);
    res.json({ success: true, saved });
  } catch (error) {
    console.error('Bulk save classifications error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// SYNC CODES TO DISPLAY TABLES
// ============================================
const syncCodesToDisplayTables = async () => {
  try {
    console.log('Syncing codes to display tables...');

    await db.runAsync(`
      INSERT OR REPLACE INTO tax_rates (code, label, rate, description, updated_at)
      SELECT cd, cd_nm, CAST(COALESCE(user_dfn_cd1, '0') AS REAL) / 100, cd_desc, updated_at
      FROM codes WHERE cd_cls = '04' AND use_yn = 'Y'
    `);

    await db.runAsync(`
      INSERT OR REPLACE INTO payment_types (code, label, description, is_active)
      SELECT cd, cd_nm, cd_desc, CASE WHEN use_yn = 'Y' THEN 1 ELSE 0 END
      FROM codes WHERE cd_cls = '07' AND use_yn = 'Y'
    `);

    await db.runAsync(`
      INSERT OR REPLACE INTO unit_codes (code, label, description)
      SELECT cd, cd_nm, cd_desc FROM codes WHERE cd_cls = '10' AND use_yn = 'Y'
    `);

    const taxCount = await db.getAsync('SELECT COUNT(*) as count FROM tax_rates');
    const paymentCount = await db.getAsync('SELECT COUNT(*) as count FROM payment_types');
    const unitCount = await db.getAsync('SELECT COUNT(*) as count FROM unit_codes');

    console.log(`Display tables: Tax=${taxCount.count}, Payment=${paymentCount.count}, Unit=${unitCount.count}`);
  } catch (error) {
    console.error('Sync display tables failed:', error.message);
  }
};

// ============================================
// LOCAL DATA ENDPOINTS (UI Display)
// ============================================

router.get('/codes/all', async (req, res) => {
  try {
    const clsList = await db.allAsync(
      `SELECT cd_cls, cd_cls_nm, use_yn FROM code_classifications ORDER BY cd_cls`
    );
    const result = [];
    for (const cls of clsList) {
      const dtlList = await db.allAsync(
        `SELECT cd, cd_nm, cd_desc, use_yn, user_dfn_cd1, user_dfn_cd2 
         FROM codes WHERE cd_cls = ? ORDER BY cd`,
        [cls.cd_cls]
      );
      result.push({
        cdCls: cls.cd_cls,
        cdClsNm: cls.cd_cls_nm,
        useYn: cls.use_yn,
        dtlList: dtlList.map(d => ({
          cd: d.cd,
          cdNm: d.cd_nm,
          cdDesc: d.cd_desc,
          useYn: d.use_yn,
          userDfnCd1: d.user_dfn_cd1,
          userDfnCd2: d.user_dfn_cd2
        }))
      });
    }
    res.json({
      resultCd: '000',
      resultMsg: 'Successful',
      resultDt: new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14),
      data: { clsList: result }
    });
  } catch (error) {
    console.error('Get all codes error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CRUD ENDPOINTS FOR TABS
// ============================================

const crudRoutes = (path, table, columns, idColumn = 'code') => {
  router.get(`/${path}`, async (req, res) => {
    try {
      const rows = await db.allAsync(`SELECT * FROM ${table} ORDER BY ${idColumn}`);
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post(`/${path}`, rateLimit, async (req, res) => {
    try {
      const data = req.body;
      if (!data[idColumn] || !data.label) {
        return res.status(400).json({ error: `${idColumn} and label are required` });
      }
      const cols = columns.join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      const values = columns.map(col => data[col] ?? null);
      await db.runAsync(
        `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`,
        values
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete(`/${path}/:id`, rateLimit, async (req, res) => {
    try {
      await db.runAsync(`DELETE FROM ${table} WHERE ${idColumn} = ?`, [req.params.id]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post(`/${path}/bulk`, async (req, res) => {
    try {
      const items = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Array required' });
      }

      for (const item of items) {
        const values = columns.map(col => item[col] ?? null);
        const placeholders = columns.map(() => '?').join(', ');
        const cols = columns.join(', ');
        await db.runAsync(
          `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`,
          values
        );
      }
      res.json({ success: true, saved: items.length });
    } catch (error) {
      console.error(`Bulk save ${table} error:`, error.message);
      res.status(500).json({ error: error.message });
    }
  });
};

crudRoutes('tax-rates', 'tax_rates', ['code', 'label', 'rate', 'description', 'updated_at']);
crudRoutes('payment-types', 'payment_types', ['code', 'label', 'description', 'is_active']);
crudRoutes('unit-codes', 'unit_codes', ['code', 'label', 'description']);
crudRoutes('classifications', 'classifications', ['code', 'name', 'description', 'level', 'use_yn', 'updated_at']);

// ============================================
// SETTINGS
// ============================================
const VALID_SETTINGS_KEYS = [
  'company_name', 'company_address', 'company_phone', 'company_email',
  'company_tin', 'tax_rate', 'currency', 'receipt_footer', 'receipt_header',
  'low_stock_threshold', 'auto_sync_interval', 'default_payment_method', 'invoice_prefix'
];

router.get('/settings', async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT * FROM settings`);
    const settings = {};
    rows.forEach(row => settings[row.key] = row.value);
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/settings', rateLimit, async (req, res) => {
  try {
    const updates = req.body;
    const now = new Date().toISOString();
    const errors = [];
    const validUpdates = {};

    for (const [key, value] of Object.entries(updates)) {
      if (!VALID_SETTINGS_KEYS.includes(key)) {
        errors.push(`Invalid key: "${key}"`);
        continue;
      }
      if (['tax_rate', 'low_stock_threshold', 'auto_sync_interval'].includes(key)) {
        const num = parseFloat(value);
        if (isNaN(num) || num < 0) {
          errors.push(`"${key}" must be a positive number`);
          continue;
        }
      }
      if (key === 'company_tin' && value && !/^[A-Z0-9]{9,16}$/.test(value)) {
        errors.push(`"${key}" must be a valid TIN`);
        continue;
      }
      validUpdates[key] = value;
    }

    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    for (const [key, value] of Object.entries(validUpdates)) {
      await db.runAsync(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
        [key, value, now]
      );
    }

    res.json({ success: true, saved: Object.keys(validUpdates).length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;
    if (!VALID_SETTINGS_KEYS.includes(key)) {
      return res.status(400).json({ error: `Invalid key: "${key}"` });
    }
    const row = await db.getAsync(`SELECT * FROM settings WHERE key = ?`, [key]);
    if (!row) return res.status(404).json({ error: 'Setting not found' });
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
module.exports.initTablesOnce = initTablesOnce;