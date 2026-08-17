const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// ============================================
// VSCU PROXY ENDPOINTS
// ============================================

// Get import items from VSCU
router.post('/selectImportItems', async (req, res) => {
  console.log('📤 Fetching imports from VSCU');
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/imports/selectImportItems`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('Imports fetched from VSCU');
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch imports from VSCU:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send/update import item to VSCU
router.post('/updateImportItems', async (req, res) => {
  console.log('Sending import update to VSCU:', JSON.stringify(req.body, null, 2));
  try {
    const payload = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/imports/updateImportItems`,
      payload,
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('Import updated in VSCU:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('Failed to update import in VSCU:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LOCAL CRUD OPERATIONS
// ============================================

// ===== RATE LIMITING =====
const rateLimitMap = new Map();

const rateLimit = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60000;
  const maxRequests = 30;

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

// ===== GET ALL IMPORTS =====
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM imports ORDER BY dcl_de DESC, task_cd DESC`
    );
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch imports:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== GET IMPORT BY TASK CODE =====
router.get('/:taskCd', async (req, res) => {
  try {
    const { taskCd } = req.params;
    const row = await db.getAsync(
      `SELECT * FROM imports WHERE task_cd = ?`,
      [taskCd]
    );
    
    if (!row) {
      return res.status(404).json({ error: 'Import record not found' });
    }
    
    res.json(row);
  } catch (error) {
    console.error('Failed to fetch import:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== GET IMPORTS BY STATUS =====
router.get('/status/:status', async (req, res) => {
  try {
    const { status } = req.params;
    
    if (!['0', '1', 'pending', 'matched'].includes(status)) {
      return res.status(400).json({ 
        error: 'Invalid status. Use: 0, 1, pending, or matched' 
      });
    }
    
    let query;
    let params;
    
    if (status === 'pending') {
      query = `SELECT * FROM imports WHERE impt_item_stts_cd = '0' OR impt_item_stts_cd IS NULL ORDER BY dcl_de DESC`;
      params = [];
    } else if (status === 'matched') {
      query = `SELECT * FROM imports WHERE impt_item_stts_cd = '1' ORDER BY dcl_de DESC`;
      params = [];
    } else {
      query = `SELECT * FROM imports WHERE impt_item_stts_cd = ? ORDER BY dcl_de DESC`;
      params = [status];
    }
    
    const rows = await db.allAsync(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch imports by status:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== GET PENDING IMPORTS (for matching) =====
router.get('/pending/matching', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM imports 
       WHERE impt_item_stts_cd = '0' OR impt_item_stts_cd IS NULL 
       ORDER BY dcl_de DESC LIMIT 100`
    );
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch pending imports:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== MATCH IMPORT TO ITEM =====
router.post('/', rateLimit, async (req, res) => {
  try {
    const { taskCd, itemCd, imptItemSttsCd } = req.body;
    
    console.log(`📤 Matching import ${taskCd} to item ${itemCd}`);
    
    if (!taskCd) {
      return res.status(400).json({ error: 'taskCd is required' });
    }
    
    if (!itemCd) {
      return res.status(400).json({ error: 'itemCd is required' });
    }

    const existing = await db.getAsync(
      `SELECT * FROM imports WHERE task_cd = ?`,
      [taskCd]
    );
    
    if (!existing) {
      return res.status(404).json({ error: 'Import record not found' });
    }

    const itemExists = await db.getAsync(
      `SELECT * FROM items WHERE item_cd = ?`,
      [itemCd]
    );
    
    if (!itemExists) {
      return res.status(404).json({ error: `Item "${itemCd}" not found in inventory` });
    }

    const now = new Date().toISOString();
    const status = imptItemSttsCd || '1';

    await db.runAsync(
      `UPDATE imports 
       SET item_cd = ?, 
           impt_item_stts_cd = ?, 
           synced = 1, 
           matched_at = ?,
           updated_at = ?
       WHERE task_cd = ?`,
      [itemCd, status, now, now, taskCd]
    );

    const updated = await db.getAsync(
      `SELECT * FROM imports WHERE task_cd = ?`,
      [taskCd]
    );

    console.log(`Import ${taskCd} matched to ${itemCd}`);

    res.json({ 
      success: true, 
      message: 'Import matched successfully',
      data: updated
    });
  } catch (error) {
    console.error('Failed to match import:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== BULK MATCH IMPORTS =====
router.post('/bulk-match', rateLimit, async (req, res) => {
  try {
    const { matches } = req.body;
    
    console.log(`📤 Bulk matching ${matches?.length || 0} imports`);
    
    if (!matches || !Array.isArray(matches) || matches.length === 0) {
      return res.status(400).json({ 
        error: 'matches array is required with at least one item' 
      });
    }

    const now = new Date().toISOString();
    let matched = 0;
    let failed = 0;
    const errors = [];

    for (const match of matches) {
      try {
        const { taskCd, itemCd, imptItemSttsCd } = match;
        
        if (!taskCd || !itemCd) {
          errors.push({ taskCd, error: 'taskCd and itemCd are required' });
          failed++;
          continue;
        }

        const existing = await db.getAsync(
          `SELECT * FROM imports WHERE task_cd = ?`,
          [taskCd]
        );
        
        if (!existing) {
          errors.push({ taskCd, error: 'Import record not found' });
          failed++;
          continue;
        }

        const itemExists = await db.getAsync(
          `SELECT * FROM items WHERE item_cd = ?`,
          [itemCd]
        );
        
        if (!itemExists) {
          errors.push({ taskCd, itemCd, error: 'Item not found in inventory' });
          failed++;
          continue;
        }

        const status = imptItemSttsCd || '1';

        await db.runAsync(
          `UPDATE imports 
           SET item_cd = ?, 
               impt_item_stts_cd = ?, 
               synced = 1, 
               matched_at = ?,
               updated_at = ?
           WHERE task_cd = ?`,
          [itemCd, status, now, now, taskCd]
        );
        
        matched++;
      } catch (matchError) {
        errors.push({ taskCd: match.taskCd, error: matchError.message });
        failed++;
      }
    }

    console.log(`✅ Bulk match: ${matched} matched, ${failed} failed`);

    res.json({
      success: true,
      message: `Matched ${matched} imports, ${failed} failed`,
      matched,
      failed,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Failed to bulk match imports:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== UNMATCH IMPORT (revert) =====
router.delete('/:taskCd/match', rateLimit, async (req, res) => {
  try {
    const { taskCd } = req.params;
    
    console.log(`📤 Unmatching import ${taskCd}`);
    
    const existing = await db.getAsync(
      `SELECT * FROM imports WHERE task_cd = ?`,
      [taskCd]
    );
    
    if (!existing) {
      return res.status(404).json({ error: 'Import record not found' });
    }

    if (!existing.item_cd) {
      return res.status(400).json({ error: 'Import is not matched to any item' });
    }

    await db.runAsync(
      `UPDATE imports 
       SET item_cd = NULL, 
           impt_item_stts_cd = '0', 
           synced = 0,
           matched_at = NULL,
           updated_at = ?
       WHERE task_cd = ?`,
      [new Date().toISOString(), taskCd]
    );

    console.log(`✅ Import ${taskCd} unmatched`);

    res.json({ 
      success: true, 
      message: 'Import unmatched successfully' 
    });
  } catch (error) {
    console.error('Failed to unmatch import:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===== GET IMPORT STATS =====
router.get('/stats/summary', async (req, res) => {
  try {
    const total = await db.getAsync(`SELECT COUNT(*) as count FROM imports`);
    const matched = await db.getAsync(
      `SELECT COUNT(*) as count FROM imports WHERE impt_item_stts_cd = '1'`
    );
    const pending = await db.getAsync(
      `SELECT COUNT(*) as count FROM imports WHERE impt_item_stts_cd = '0' OR impt_item_stts_cd IS NULL`
    );
    const synced = await db.getAsync(
      `SELECT COUNT(*) as count FROM imports WHERE synced = 1`
    );
    
    res.json({
      total: total?.count || 0,
      matched: matched?.count || 0,
      pending: pending?.count || 0,
      synced: synced?.count || 0
    });
  } catch (error) {
    console.error('Failed to fetch import stats:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;