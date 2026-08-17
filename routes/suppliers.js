const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all suppliers
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM suppliers ORDER BY name ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single supplier by ID
router.get('/:id', async (req, res) => {
  try {
    const row = await db.getAsync(
      `SELECT * FROM suppliers WHERE id = ?`,
      [req.params.id]
    );
    if (!row) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get supplier by PIN
router.get('/pin/:pin', async (req, res) => {
  try {
    const row = await db.getAsync(
      `SELECT * FROM suppliers WHERE pin = ?`,
      [req.params.pin]
    );
    if (!row) {
      return res.status(404).json({ error: 'Supplier not found' });
    }
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save supplier (add or update)
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    if (!data.pin || !data.name) {
      return res.status(400).json({ error: 'PIN and Name are required' });
    }

    await db.runAsync(
      `INSERT OR REPLACE INTO suppliers 
       (id, pin, name, phone, email, address, tax_type, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id || Date.now().toString(),
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

    const supplier = await db.getAsync(
      `SELECT * FROM suppliers WHERE pin = ?`,
      [data.pin]
    );

    res.json({
      success: true,
      supplier,
      message: 'Supplier saved successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete supplier (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    await db.runAsync(
      `UPDATE suppliers SET is_active = 0 WHERE id = ?`,
      [req.params.id]
    );
    res.json({ success: true, message: 'Supplier deactivated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search suppliers
router.get('/search/:query', async (req, res) => {
  try {
    const query = `%${req.params.query}%`;
    const rows = await db.allAsync(
      `SELECT * FROM suppliers 
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

// Get supplier stats
router.get('/stats/summary', async (req, res) => {
  try {
    const total = await db.getAsync(`SELECT COUNT(*) as count FROM suppliers WHERE is_active = 1`);
    res.json({
      total: total?.count || 0
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;