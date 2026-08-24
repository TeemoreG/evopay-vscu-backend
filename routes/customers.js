const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// ============================================
// VSCU PROXY ENDPOINTS
// ============================================

// Get customer by PIN from VSCU
router.post('/selectCustomer', async (req, res) => {
  console.log('📤 Customer lookup for PIN:', req.body?.custmTin);
  try {
    const { tin, bhfId, custmTin } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/customers/selectCustomer`,
      { tin, bhfId, custmTin },
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('📥 VSCU Response Code:', response.data?.resultCd);
    res.json(response.data);
  } catch (error) {
    console.error('❌ Failed to fetch customer from VSCU:', error.message);
    if (error.response) {
      console.error('VSCU Error Status:', error.response.status);
      console.error('VSCU Error Data:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({ error: error.message });
  }
});

// Get all customers from VSCU
router.post('/selectCustomers', async (req, res) => {
  console.log('📤 Fetching customers from VSCU:', req.body);
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/customers/selectCustomers`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('📥 VSCU Response Code:', response.data?.resultCd);
    console.log('📥 VSCU Response Msg:', response.data?.resultMsg);
    console.log('📦 Customer list length:', response.data?.data?.customerList?.length || 0);
    
    res.json(response.data);
  } catch (error) {
    console.error('❌ Failed to fetch customers from VSCU:', error.message);
    if (error.response) {
      console.error('VSCU Error Status:', error.response.status);
      console.error('VSCU Error Data:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({ error: error.message });
  }
});

// BULK SAVE CUSTOMERS (from VSCU)
router.post('/bulk', async (req, res) => {
  try {
    const customerList = req.body;
    
    if (!Array.isArray(customerList) || customerList.length === 0) {
      return res.status(400).json({ error: 'Customers array is required' });
    }

    const now = new Date().toISOString();
    let saved = 0;

    for (const customer of customerList) {
      await db.runAsync(
        `INSERT OR REPLACE INTO customers (pin, name, phone, email, address, tax_type, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customer.custTin || customer.pin,
          customer.custNm || customer.name || 'Unknown',
          customer.custMblNo || customer.phone || null,
          customer.custEmail || customer.email || null,
          customer.adrs || customer.address || null,
          customer.taxTyCd || customer.tax_type || 'B',
          1,
          now,
          now
        ]
      );
      saved++;
    }

    console.log(`✅ Bulk saved ${saved} customers from VSCU`);
    res.json({ success: true, saved });
  } catch (error) {
    console.error('❌ Bulk save customers error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LOCAL CRUD OPERATIONS
// ============================================

// Get all customers (local)
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM customers ORDER BY name ASC`
    );
    console.log(`📦 Fetched ${rows.length} customers from database`);
    res.json(rows);
  } catch (error) {
    console.error('❌ Error fetching customers:', error.message);
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
    console.error('❌ Error fetching customer:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save customer (add or update) - local
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    if (!data.pin || !data.name) {
      return res.status(400).json({ error: 'PIN and Name are required' });
    }

    console.log('📝 Saving customer:', data.pin, '-', data.name);

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

    console.log(`✅ Customer ${data.pin} saved successfully`);
    res.json({
      success: true,
      customer,
      message: 'Customer saved successfully'
    });
  } catch (error) {
    console.error('❌ Error saving customer:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete customer (soft delete)
router.delete('/:pin', async (req, res) => {
  try {
    console.log('📝 Deactivating customer:', req.params.pin);
    await db.runAsync(
      `UPDATE customers SET is_active = 0 WHERE pin = ?`,
      [req.params.pin]
    );
    console.log(`✅ Customer ${req.params.pin} deactivated`);
    res.json({ success: true, message: 'Customer deactivated' });
  } catch (error) {
    console.error('❌ Error deactivating customer:', error.message);
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
    console.error('❌ Error searching customers:', error.message);
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
    console.error('❌ Error fetching customer stats:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;