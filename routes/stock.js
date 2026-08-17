// backend/routes/stock.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const vscuClient = require('../services/vscuClient');
const axios = require('axios');

// ============================================
// 1. GET STOCK FROM VSCU (Move Stock Request)
// POST /stock/selectStockItems
// ============================================
router.post('/selectStockItems', async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/stock/selectStockItems`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch stock from VSCU:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 2. SEND STOCK I/O TO VSCU (Send Stock Information)
// POST /stock/saveStockItems
// ============================================
router.post('/saveStockItems', async (req, res) => {
  try {
    const payload = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/stock/saveStockItems`,
      payload,
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to send stock to VSCU:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// 3. SAVE STOCK MASTER TO VSCU (Stock Master Save)
// POST /stockMaster/saveStockMaster
// ============================================
router.post('/stockMaster/saveStockMaster', async (req, res) => {
  try {
    const { tin, bhfId, itemCd, rsdQty, regrId, regrNm, modrNm, modrId } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/stockMaster/saveStockMaster`,
      { tin, bhfId, itemCd, rsdQty, regrId, regrNm, modrNm, modrId },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to save stock master:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LOCAL STOCK FUNCTIONS
// ============================================

// Get all stock (local)
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM items WHERE use_yn = 'Y' ORDER BY item_name`
    );
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch stock:', error);
    res.status(500).json({ error: error.message });
  }
});

// Record stock movement (local + VSCU)
router.post('/movement', async (req, res) => {
  try {
    const { itemCd, qty, type, reason, reference, cashier } = req.body;
    const now = new Date().toISOString();

    if (!itemCd || !qty || !type) {
      return res.status(400).json({ error: 'itemCd, qty, and type are required' });
    }

    const item = await db.getAsync(`SELECT * FROM items WHERE item_cd = ?`, [itemCd]);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const delta = type === 'IN' ? qty : -qty;
    const newStock = Math.max(0, item.stock + delta);
    const qtyAbs = Math.abs(qty);

    // ============================================
    // 1. BUILD STOCK PAYLOAD
    // ============================================
    const stockPayload = {
      tin: process.env.TIN,
      bhfId: process.env.BHF_ID,
      sarNo: Math.floor(Date.now() / 1000),
      orgSarNo: 0,
      regTyCd: 'M',
      custTin: null,
      custNm: null,
      custBhfId: null,
      sarTyCd: type === 'IN' ? '1' : '2',
      ocrnDt: now.replace(/[-:T.]/g, '').slice(0, 8),
      totItemCnt: 1,
      totTaxblAmt: qtyAbs * (item.price || 0),
      totTaxAmt: 0,
      totAmt: qtyAbs * (item.price || 0),
      remark: reason || null,
      regrId: cashier || 'Admin',
      regrNm: cashier || 'Admin',
      modrNm: cashier || 'Admin',
      modrId: cashier || 'Admin',
      itemList: [{
        itemSeq: 1,
        itemCd: item.item_cd,
        itemClsCd: item.item_cls_cd || '50101010',
        itemNm: item.item_name,
        bcd: null,
        pkgUnitCd: 'NT',
        pkg: 1,
        qtyUnitCd: 'U',
        qty: qtyAbs,
        itemExprDt: null,
        prc: item.price || 0,
        splyAmt: qtyAbs * (item.price || 0),
        totDcAmt: 0,
        taxblAmt: qtyAbs * (item.price || 0),
        taxTyCd: item.tax_type || 'B',
        taxAmt: 0,
        totAmt: qtyAbs * (item.price || 0)
      }]
    };

    console.log('Stock Payload to VSCU:', JSON.stringify(stockPayload, null, 2));

    // ============================================
    // 2. UPDATE LOCAL DATABASE FIRST (ALWAYS)
    // ============================================
    await db.runAsync(
      `UPDATE items SET stock = ?, updated_at = ? WHERE item_cd = ?`,
      [newStock, now, itemCd]
    );

    await db.runAsync(
      `INSERT INTO stock_movements (item_cd, quantity, type, reference, note, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [itemCd, qtyAbs, type, reference || null, reason || null, now.slice(0, 10), now]
    );

    console.log(`Stock movement for ${itemCd} saved to database`);

    // ============================================
    // 3. THEN TRY TO SYNC TO VSCU
    // ============================================
    let vscuResponse = null;
    let synced = false;
    let queued = false;

    try {
      const status = await vscuClient.checkStatus();
      
      if (status.connected) {
        vscuResponse = await vscuClient.saveStock(stockPayload);
        
        if (vscuResponse && (vscuResponse.resultCd === '000' || vscuResponse.resultCd === '00')) {
          synced = true;
          console.log(`✅ Stock movement for ${itemCd} synced to VSCU`);
        } else {
          const errorMsg = vscuResponse?.resultMsg || vscuResponse?.message || 'VSCU error';
          console.log(`VSCU returned ${vscuResponse?.resultCd || 'unknown'} - queuing stock movement`);
          await db.runAsync(
            `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
            ['/stock/saveStockItems', JSON.stringify(stockPayload), `VSCU: ${errorMsg}`, now]
          );
          queued = true;
        }
      } else {
        console.log('VSCU offline - queuing stock movement');
        await db.runAsync(
          `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
          ['/stock/saveStockItems', JSON.stringify(stockPayload), 'VSCU offline', now]
        );
        queued = true;
      }
    } catch (vscuError) {
      console.error('VSCU stock sync error:', vscuError.message);
      await db.runAsync(
        `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
        ['/stock/saveStockItems', JSON.stringify(stockPayload), vscuError.message || 'Network error', now]
      );
      queued = true;
    }

    const updatedItem = await db.getAsync(`SELECT * FROM items WHERE item_cd = ?`, [itemCd]);

    res.json({
      success: true,
      synced: synced,
      queued: queued,
      itemCd,
      oldStock: item.stock,
      newStock: newStock,
      item: updatedItem,
      message: synced ? 'Stock movement synced to KRA' : queued ? 'Stock movement saved and queued for sync' : 'Stock movement saved locally'
    });

  } catch (error) {
    console.error('Stock movement error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Sync all stock to VSCU (manual trigger)
router.post('/sync', async (req, res) => {
  try {
    const items = await db.allAsync(`SELECT * FROM items WHERE use_yn = 'Y'`);

    let synced = 0;
    let failed = 0;
    let errors = [];

    for (const item of items) {
      try {
        const status = await vscuClient.checkStatus();
        
        if (!status.connected) {
          return res.json({
            success: false,
            message: 'VSCU is offline. Please try again later.',
            synced: 0,
            failed: items.length
          });
        }

        const vscuPayload = {
          tin: process.env.TIN,
          bhfId: process.env.BHF_ID,
          itemCd: item.item_cd,
          rsdQty: item.stock || 0,
          regrId: 'Admin',
          regrNm: 'Admin',
          modrNm: 'Admin',
          modrId: 'Admin'
        };

        const response = await vscuClient.saveStockMaster(vscuPayload);
        
        if (response && (response.resultCd === '000' || response.resultCd === '00')) {
          synced++;
        } else {
          failed++;
          errors.push({ itemCd: item.item_cd, error: response?.resultMsg || 'Unknown error' });
        }
      } catch (error) {
        failed++;
        errors.push({ itemCd: item.item_cd, error: error.message });
      }
    }

    res.json({
      success: true,
      synced,
      failed,
      errors: errors.length > 0 ? errors : undefined,
      message: `Synced ${synced} items, ${failed} failed.`
    });

  } catch (error) {
    console.error('Stock sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get stock movements for an item
router.get('/:itemCd/movements', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM stock_movements WHERE item_cd = ? ORDER BY created_at DESC`,
      [req.params.itemCd]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get low stock alerts
router.get('/alerts/low', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM items WHERE use_yn = 'Y' AND stock <= sfty_qty ORDER BY stock ASC`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;