const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// ===== RATE LIMITING =====
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

// ===== HELPER: SEED DEFAULT KRA eTIMS PAYMENT TYPES =====
const ensurePaymentTypesSeeded = async () => {
  try {
    // Check if db is connected
    await db.runAsync('SELECT 1');
    
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS payment_types (
        code TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        description TEXT
      )
    `);

    const countRow = await db.getAsync(`SELECT COUNT(*) as count FROM payment_types`);
    
    if (!countRow || countRow.count === 0) {
      const defaultTypes = [
        ['01', 'Cash', 'Physical currency payment'],
        ['02', 'Card', 'Credit or Debit card payment'],
        ['03', 'Mobile Money', 'M-Pesa, Airtel Money, or other mobile wallet']
      ];

      for (const [code, label, description] of defaultTypes) {
        await db.runAsync(
          `INSERT OR IGNORE INTO payment_types (code, label, description) VALUES (?, ?, ?)`,
          [code, label, description]
        );
      }
      console.log('Default payment types seeded with descriptions.');
    }
  } catch (error) {
    console.log('Payment types seeding skipped - database not ready:', error.message);
  }
};

// Seed payment types on file load (with error handling)
ensurePaymentTypesSeeded();

// ===== TAX RATES =====
router.get('/tax-rates', async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT * FROM tax_rates ORDER BY code`);
    res.json(rows);
  } catch (error) {
    console.error('Tax rates error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== PAYMENT TYPES =====
router.get('/payment-types', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT code, label, is_active, description FROM payment_types ORDER BY code ASC`
    );
    res.json(rows);
  } catch (error) {
    console.error('Payment types error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/payment-types', rateLimit, async (req, res) => {
  try {
    const { code, label, is_active = 1, description } = req.body;
    if (!code || !label) {
      return res.status(400).json({ error: 'Both code and label are required.' });
    }

    if (!/^\d{2}$/.test(code)) {
      return res.status(400).json({ error: 'Code must be exactly 2 digits.' });
    }

    await db.runAsync(
      `INSERT INTO payment_types (code, label, is_active, description) 
       VALUES (?, ?, ?, ?) 
       ON CONFLICT(code) DO UPDATE SET label=excluded.label, is_active=excluded.is_active, description=excluded.description`,
      [code, label, is_active, description || null]
    );

    res.json({ success: true, message: 'Payment type updated successfully.' });
  } catch (error) {
    console.error('Payment type save error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/payment-types/:code', rateLimit, async (req, res) => {
  try {
    const { code } = req.params;
    
    const defaultTypes = ['01', '02', '03'];
    if (defaultTypes.includes(code)) {
      return res.status(400).json({ 
        error: 'Cannot delete default payment types (Cash, Card, Mobile Money).' 
      });
    }

    await db.runAsync(
      `DELETE FROM payment_types WHERE code = ?`,
      [code]
    );
    res.json({ success: true, message: 'Payment type deleted successfully.' });
  } catch (error) {
    console.error('Payment type delete error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== UNIT CODES =====
router.get('/unit-codes', async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT * FROM unit_codes ORDER BY code`);
    res.json(rows);
  } catch (error) {
    console.error('Unit codes error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/unit-codes', rateLimit, async (req, res) => {
  try {
    const { code, label, description } = req.body;
    if (!code || !label) {
      return res.status(400).json({ error: 'Both code and label are required.' });
    }

    if (!/^[A-Z]{2}$/.test(code)) {
      return res.status(400).json({ error: 'Code must be exactly 2 uppercase letters.' });
    }

    await db.runAsync(
      `INSERT OR REPLACE INTO unit_codes (code, label, description) VALUES (?, ?, ?)`,
      [code, label, description || null]
    );

    res.json({ success: true, message: 'Unit code saved successfully.' });
  } catch (error) {
    console.error('Unit code save error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== CLASSIFICATIONS =====
router.get('/classifications', async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT * FROM classifications ORDER BY code`);
    res.json(rows);
  } catch (error) {
    console.error('Classifications error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/classifications', rateLimit, async (req, res) => {
  try {
    const { code, name, description } = req.body;
    if (!code || !name) {
      return res.status(400).json({ error: 'Both code and name are required.' });
    }

    if (!/^\d{8}$/.test(code)) {
      return res.status(400).json({ error: 'Code must be exactly 8 digits.' });
    }

    await db.runAsync(
      `INSERT OR REPLACE INTO classifications (code, name, description) VALUES (?, ?, ?)`,
      [code, name, description || null]
    );

    res.json({ success: true, message: 'Classification saved successfully.' });
  } catch (error) {
    console.error('Classification save error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ===== SYSTEM SETTINGS =====
const VALID_SETTINGS_KEYS = [
  'company_name',
  'company_address',
  'company_phone',
  'company_email',
  'company_tin',
  'tax_rate',
  'currency',
  'receipt_footer',
  'receipt_header',
  'low_stock_threshold',
  'auto_sync_interval',
  'default_payment_method',
  'invoice_prefix'
];

router.get('/settings', async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT * FROM settings`);
    const settings = {};
    rows.forEach((row) => {
      settings[row.key] = row.value;
    });
    res.json(settings);
  } catch (error) {
    console.error('Settings error:', error.message);
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
        errors.push(`Invalid setting key: "${key}"`);
        continue;
      }

      if (key === 'tax_rate' || key === 'low_stock_threshold' || key === 'auto_sync_interval') {
        const numValue = parseFloat(value);
        if (isNaN(numValue) || numValue < 0) {
          errors.push(`"${key}" must be a positive number`);
          continue;
        }
      }

      if (key === 'company_tin' && value && !/^[A-Z0-9]{9,16}$/.test(value)) {
        errors.push(`"${key}" must be a valid TIN (9-16 characters, letters and numbers)`);
        continue;
      }

      if (key === 'currency' && value && !/^[A-Z]{3}$/.test(value)) {
        errors.push(`"${key}" must be a 3-letter currency code (e.g., KES, USD)`);
        continue;
      }

      validUpdates[key] = value;
    }

    if (errors.length > 0) {
      return res.status(400).json({ 
        success: false, 
        errors: errors,
        message: 'Some settings were invalid and were not saved.'
      });
    }

    for (const [key, value] of Object.entries(validUpdates)) {
      await db.runAsync(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
        [key, value, now]
      );
    }

    res.json({ 
      success: true, 
      message: `Saved ${Object.keys(validUpdates).length} settings.`,
      saved: validUpdates,
      errors: errors
    });
  } catch (error) {
    console.error('Settings save error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.get('/settings/:key', async (req, res) => {
  try {
    const { key } = req.params;
    
    if (!VALID_SETTINGS_KEYS.includes(key)) {
      return res.status(400).json({ error: `Invalid setting key: "${key}"` });
    }

    const row = await db.getAsync(
      `SELECT * FROM settings WHERE key = ?`,
      [key]
    );
    
    if (!row) {
      return res.status(404).json({ error: `Setting "${key}" not found.` });
    }
    
    res.json({ key: row.key, value: row.value, updated_at: row.updated_at });
  } catch (error) {
    console.error('Settings get error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// VSCU PROXY ENDPOINTS
// ============================================

// 1. Get Code List
router.post('/code/selectCodes', async (req, res) => {
  console.log('📤 Get Code List called with:', req.body);
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/code/selectCodes`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch codes:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 2. Get Item Classification List
router.post('/itemClass/selectItemsClass', async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/itemClass/selectItemsClass`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch classifications:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 3. Get Customer by PIN
router.post('/customers/selectCustomer', async (req, res) => {
  try {
    const { tin, bhfId, custmTin } = req.body;
    
    console.log('📤 Looking up customer PIN:', custmTin);
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/customers/selectCustomer`,
      { tin, bhfId, custmTin },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch customer:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 4. Get Notice List
router.post('/notices/selectNotices', async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/notices/selectNotices`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch notices:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;