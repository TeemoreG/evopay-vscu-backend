const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// ============================================
// VSCU PROXY ENDPOINT
// ============================================

// Get notices from (KRA)VSCU
router.post('/selectNotices', async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    console.log('📤 Fetching notices from VSCU:', { tin, bhfId, lastReqDt });
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/notices/selectNotices`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch notices from (KRA)VSCU:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LOCAL CRUD OPERATIONS
// ============================================

// Get all notices (local)
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM notices ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save notice (local)
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    await db.runAsync(
      `INSERT OR REPLACE INTO notices 
       (id, title, message, type, priority, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id || Date.now().toString(),
        data.title,
        data.message,
        data.type || 'info',
        data.priority || 'normal',
        data.is_read || 0,
        now
      ]
    );

    res.json({
      success: true,
      message: 'Notice saved successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark notice as read
router.patch('/:id/read', async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date().toISOString();

    await db.runAsync(
      `UPDATE notices SET is_read = 1, read_at = ? WHERE id = ?`,
      [now, id]
    );

    res.json({ success: true, message: 'Notice marked as read' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete notice
router.delete('/:id', async (req, res) => {
  try {
    await db.runAsync(`DELETE FROM notices WHERE id = ?`, [req.params.id]);
    res.json({ success: true, message: 'Notice deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;