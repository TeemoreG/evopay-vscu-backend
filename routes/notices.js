const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// ============================================
// VSCU PROXY ENDPOINTS
// ============================================

// Get notices from KRA VSCU
router.post('/selectNotices', async (req, res) => {
  console.log('Fetching notices from VSCU:', req.body);
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/notices/selectNotices`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('VSCU Response Code:', response.data?.resultCd);
    console.log('VSCU Response Msg:', response.data?.resultMsg);
    console.log('Notice list length:', response.data?.data?.noticeList?.length || 0);
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch notices from VSCU:', error.message);
    if (error.response) {
      console.error('VSCU Error Status:', error.response.status);
      console.error('VSCU Error Data:', JSON.stringify(error.response.data, null, 2));
    }
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
    console.log(`Fetched ${rows.length} notices from database`);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching notices:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save notice (local)
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    console.log('Saving notice:', data.title);

    await db.runAsync(
      `INSERT OR REPLACE INTO notices (
        notice_no, title, content, detail_url, regr_nm, reg_dt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.noticeNo || data.notice_no || Date.now().toString(),
        data.title || 'Untitled',
        data.cont || data.content || data.message || null,
        data.dtlUrl || data.detail_url || null,
        data.regrNm || data.regr_nm || 'Admin',
        data.regDt || data.reg_dt || now,
        now
      ]
    );

    console.log(`Notice saved successfully`);
    res.json({
      success: true,
      message: 'Notice saved successfully'
    });
  } catch (error) {
    console.error('Error saving notice:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// BULK SAVE NOTICES (from VSCU)
router.post('/bulk', async (req, res) => {
  try {
    const noticeList = req.body;
    
    if (!Array.isArray(noticeList) || noticeList.length === 0) {
      return res.status(400).json({ error: 'Notices array is required' });
    }

    const now = new Date().toISOString();
    let saved = 0;

    for (const notice of noticeList) {
      await db.runAsync(
        `INSERT OR REPLACE INTO notices (
          notice_no, title, content, detail_url, regr_nm, reg_dt, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          notice.noticeNo || notice.notice_no,
          notice.title || 'Untitled',
          notice.cont || notice.content || null,
          notice.dtlUrl || notice.dtl_url || null,
          notice.regrNm || notice.regr_nm || 'Admin',
          notice.regDt || notice.reg_dt || now,
          now
        ]
      );
      saved++;
    }

    console.log(`Bulk saved ${saved} notices from VSCU`);
    res.json({ success: true, saved });
  } catch (error) {
    console.error('Bulk save notices error:', error.message);
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
    console.error('Error marking notice as read:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Delete notice
router.delete('/:id', async (req, res) => {
  try {
    await db.runAsync(`DELETE FROM notices WHERE id = ?`, [req.params.id]);
    res.json({ success: true, message: 'Notice deleted' });
  } catch (error) {
    console.error('Error deleting notice:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;