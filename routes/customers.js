const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// ============================================
// VSCU PROXY ENDPOINT
// ============================================

// Get customer by PIN from VSCU
router.post('/selectCustomer', async (req, res) => {
  // In router.post('/selectCustomer') - after the request
console.log('📤 Customer lookup for PIN:', custmTin);
  try {
    const { tin, bhfId, custmTin } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/customers/selectCustomer`,
      { tin, bhfId, custmTin },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch customer from VSCU:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LOCAL CRUD OPERATIONS
// ============================================

// Get all customers
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM customers ORDER BY name ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single customer by PIN
router.get('/:pin', async (req, res) => {
  try {
    const row = await db.getAsync(
      `SELECT * FROM customers WHERE pin = ?`,
      [req.params.pin]
    );
    
    if (!row) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save customer (add or update)
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    if (!data.pin || !data.name) {
      return res.status(400).json({ error: 'PIN and Name are required' });
    }

    await db.runAsync(
      `INSERT OR REPLACE INTO customers 
       (pin, name, phone, email, address, tax_type, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.pin,
        data.name,
        data.phone || null,
        data.email || null,
        data.address || null,
        data.tax_type || 'B',
        data.is_active !== undefined ? data.is_active : 1,
        now,
        now
      ]
    );

    const customer = await db.getAsync(
      `SELECT * FROM customers WHERE pin = ?`,
      [data.pin]
    );

    res.json({
      success: true,
      customer,
      message: 'Customer saved successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete customer (soft delete)
router.delete('/:pin', async (req, res) => {
  try {
    await db.runAsync(
      `UPDATE customers SET is_active = 0 WHERE pin = ?`,
      [req.params.pin]
    );
    res.json({ success: true, message: 'Customer deactivated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search customers
router.get('/search/:query', async (req, res) => {
  try {
    const query = `%${req.params.query}%`;
    const rows = await db.allAsync(
      `SELECT * FROM customers 
       WHERE is_active = 1 
       AND (name LIKE ? OR pin LIKE ? OR phone LIKE ?)
       ORDER BY name ASC`,
      [query, query, query]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get customer stats
router.get('/stats/summary', async (req, res) => {
  try {
    const total = await db.getAsync(`SELECT COUNT(*) as count FROM customers WHERE is_active = 1`);
    const b2b = await db.getAsync(`SELECT COUNT(*) as count FROM customers WHERE tax_type = 'B' AND is_active = 1`);
    const b2c = await db.getAsync(`SELECT COUNT(*) as count FROM customers WHERE tax_type = 'C' AND is_active = 1`);
    
    res.json({
      total: total?.count || 0,
      b2b: b2b?.count || 0,
      b2c: b2c?.count || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;