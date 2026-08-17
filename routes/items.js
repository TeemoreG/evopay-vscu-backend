// backend/routes/items.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// ============================================
// VSCU PROXY ENDPOINTS
// ============================================

// Get items from VSCU
router.post('/selectItems', async (req, res) => {
  console.log('ITEMS POST ROUTE HIT!');
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/items/selectItems`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch items from VSCU:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send Item information (Mapper)
const mapItemToVSCU = (item) => {
  return {
    tin: process.env.TIN,
    bhfId: process.env.BHF_ID,
    itemCd: item.itemCd || item.item_cd,
    itemClsCd: item.itemClsCd || item.item_cls_cd || '50101010',
    itemTyCd: item.itemTyCd || item.item_ty_cd || '1',
    itemNm: item.itemNm || item.item_name,
    itemStdNm: item.itemStdNm || item.item_std_nm || null,
    orgnNatCd: item.orgnNatCd || item.orgn_nat_cd || 'KE',
    pkgUnitCd: item.pkgUnitCd || item.pkg_unit_cd || 'NT',
    qtyUnitCd: item.qtyUnitCd || item.qty_unit_cd || 'U',
    taxTyCd: item.taxTyCd || item.tax_type || 'B',
    btchNo: item.btchNo || item.btch_no || null,
    bcd: item.bcd || null,
    dftPrc: Number(item.dftPrc || item.price || 0),
    grpPrcL1: Number(item.grpPrcL1 || item.price || 0),
    grpPrcL2: Number(item.grpPrcL2 || item.price || 0),
    grpPrcL3: Number(item.grpPrcL3 || item.price || 0),
    grpPrcL4: Number(item.grpPrcL4 || item.price || 0),
    grpPrcL5: item.grpPrcL5 || null,
    addInfo: item.addInfo || item.add_info || null,
    sftyQty: Number(item.sftyQty || item.sfty_qty || 5),
    isrcAplcbYn: item.isrcAplcbYn || item.isrc_aplcb_yn || 'N',
    useYn: item.useYn || item.use_yn || 'Y',
    regrNm: item.regrNm || 'Admin',
    regrId: item.regrId || 'Admin',
    modrNm: item.modrNm || 'Admin',
    modrId: item.modrId || 'Admin'
  };
};

// Get all items
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM items WHERE use_yn = 'Y' ORDER BY item_name`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single item
router.get('/:itemCd', async (req, res) => {
  try {
    const row = await db.getAsync(
      `SELECT * FROM items WHERE item_cd = ?`,
      [req.params.itemCd]
    );
    if (!row) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add or update item
router.post('/', async (req, res) => {
  try {
    const item = req.body;
    const now = new Date().toISOString();

    // Validate required fields
    if (!item.itemCd || !item.itemNm) {
      return res.status(400).json({ error: 'itemCd and itemNm are required' });
    }

    // ============================================
    // BUILD VSCU PAYLOAD
    // ============================================
    const itemCode = item.itemCd || item.item_cd;
    const vscuPayload = mapItemToVSCU(item);

    console.log('📤 Item Payload to VSCU:', JSON.stringify(vscuPayload, null, 2));

    // ============================================
    // 1. SAVE TO DATABASE FIRST (ALWAYS)
    // ============================================
    await db.runAsync(
      `INSERT OR REPLACE INTO items 
       (item_cd, item_name, item_std_nm, item_cls_cd, item_ty_cd, price, tax_type, stock, sfty_qty,
        orgn_nat_cd, pkg_unit_cd, qty_unit_cd, use_yn, isrc_aplcb_yn, btch_no, bcd, add_info,
        synced, sync_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        item.itemCd || item.item_cd,
        item.itemNm || item.item_name,
        item.itemStdNm || item.item_std_nm || null,
        item.itemClsCd || item.item_cls_cd || '50101010',
        item.itemTyCd || item.item_ty_cd || '1',
        Number(item.dftPrc || item.price || 0),
        item.taxTyCd || item.tax_type || 'B',
        Number(item.stock || 0),
        Number(item.sftyQty || item.sfty_qty || 5),
        item.orgnNatCd || item.orgn_nat_cd || 'KE',
        item.pkgUnitCd || item.pkg_unit_cd || 'NT',
        item.qtyUnitCd || item.qty_unit_cd || 'U',
        item.useYn || item.use_yn || 'Y',
        item.isrcAplcbYn || item.isrc_aplcb_yn || 'N',
        item.btchNo || item.btch_no || null,
        item.bcd || null,
        item.addInfo || item.add_info || null,
        null,  // sync_error (default null)
        now,
        now
      ]
    );

    console.log(`✅ Item ${itemCode} saved to database (synced = 0)`);

    // ============================================
    // 2. THEN TRY TO SYNC TO VSCU
    // ============================================
    let synced = false;
    let queued = false;
    let vscuResponse = null;

    try {
      // Check if VSCU is reachable
      const status = await vscuClient.checkStatus();
      
      if (status.connected) {
        vscuResponse = await vscuClient.saveItem(vscuPayload);
        const resCd = vscuResponse?.resultCd;

        if (resCd === '000' || resCd === '00') {
          // VSCU Success - update database
          await db.runAsync(
            `UPDATE items SET synced = 1, sync_error = NULL, updated_at = ? WHERE item_cd = ?`,
            [now, itemCode]
          );
          synced = true;
          console.log(`✅ Item ${itemCode} synced to VSCU`);
        } else {
          // VSCU rejected - DO NOT QUEUE (broken payload)
          const errMsg = vscuResponse?.resultMsg || vscuResponse?.message || 'Validation Error';
          console.error(`❌ VSCU Error - Item ${itemCode} [Code ${resCd}]: ${errMsg}`);
          
          await db.runAsync(
            `UPDATE items SET sync_error = ?, updated_at = ? WHERE item_cd = ?`,
            [`[${resCd}] ${errMsg}`, now, itemCode]
          );
        }
      } else {
        // VSCU offline - QUEUE for later
        console.log('VSCU offline - queuing item for later');
        await db.runAsync(
          `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
          ['/items/saveItems', JSON.stringify(vscuPayload), 'VSCU offline', now]
        );
        queued = true;
        console.log(`Item ${itemCode} queued for VSCU sync (VSCU offline)`);
      }
    } catch (vscuError) {
      // Network/Timeout - QUEUE for later
      console.error('VSCU Network error:', vscuError.message);
      await db.runAsync(
        `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
        ['/items/saveItems', JSON.stringify(vscuPayload), vscuError.message || 'Network Timeout', now]
      );
      queued = true;
      console.log(`Item ${itemCode} queued for VSCU sync (Network error)`);
    }

    const updatedItem = await db.getAsync(`SELECT * FROM items WHERE item_cd = ?`, [itemCode]);

    res.json({
      success: true,
      item: updatedItem,
      synced: synced,
      queued: queued,
      vscuResponse: vscuResponse,
      message: synced ? 'Item synced to KRA' : queued ? 'Item saved and queued for sync' : 'Item saved locally'
    });

  } catch (error) {
    console.error('Save item error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete item (soft delete - set use_yn to 'N')
router.delete('/:itemCd', async (req, res) => {
  try {
    const item = await db.getAsync(`SELECT * FROM items WHERE item_cd = ?`, [req.params.itemCd]);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const now = new Date().toISOString();
    
    // Remove any existing sync_queue entries for this item (prevent duplicate queue)
    await db.runAsync(
      `DELETE FROM sync_queue WHERE endpoint = '/items/saveItems' AND json_extract(payload, '$.itemCd') = ?`,
      [req.params.itemCd]
    );

    // Queue deletion to VSCU
    const vscuPayload = {
      tin: process.env.TIN,
      bhfId: process.env.BHF_ID,
      itemCd: req.params.itemCd,
      useYn: 'N',
      regrId: 'Admin',
      regrNm: 'Admin',
      modrId: 'Admin',
      modrNm: 'Admin'
    };

    await db.runAsync(
      `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
      ['/items/saveItems', JSON.stringify(vscuPayload), 'Deletion queued', now]
    );

    await db.runAsync(
      `UPDATE items SET use_yn = 'N', synced = 0, updated_at = ? WHERE item_cd = ?`,
      [now, req.params.itemCd]
    );

    res.json({ 
      success: true, 
      message: 'Item deactivated and queued for VSCU deletion' 
    });
  } catch (error) {
    console.error('Delete item error:', error);
    res.status(500).json({ error: error.message });
  }
});
// Adjust stock for an item
router.patch('/:itemCd/stock', async (req, res) => {
  try {
    const { quantity, type, reason } = req.body;
    const itemCd = req.params.itemCd;
    const now = new Date().toISOString();

    if (!quantity || !type) {
      return res.status(400).json({ error: 'quantity and type are required' });
    }

    const item = await db.getAsync(`SELECT * FROM items WHERE item_cd = ?`, [itemCd]);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const delta = type === 'IN' ? quantity : -quantity;
    const newStock = Math.max(0, item.stock + delta);

    await db.runAsync(
      `UPDATE items SET stock = ?, updated_at = ? WHERE item_cd = ?`,
      [newStock, now, itemCd]
    );

    await db.runAsync(
      `INSERT INTO stock_movements (item_cd, quantity, type, reference, note, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [itemCd, Math.abs(quantity), type, 'Manual adjustment', reason || null, now.slice(0, 10), now]
    );

    res.json({
      success: true,
      itemCd,
      oldStock: item.stock,
      newStock: newStock,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search items
router.get('/search/:query', async (req, res) => {
  try {
    const query = `%${req.params.query}%`;
    const rows = await db.allAsync(
      `SELECT * FROM items 
       WHERE use_yn = 'Y' 
       AND (item_name LIKE ? OR item_cd LIKE ? OR bcd LIKE ?)
       ORDER BY item_name`,
      [query, query, query]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get items by tax type
router.get('/tax/:taxType', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM items WHERE use_yn = 'Y' AND tax_type = ? ORDER BY item_name`,
      [req.params.taxType]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Bulk import items
router.post('/bulk', async (req, res) => {
  try {
    const items = req.body;
    const now = new Date().toISOString();
    let imported = 0;
    let errors = [];
    let queued = 0;

    for (const item of items) {
      try {
        if (!item.itemCd || !item.itemNm) {
          errors.push({ item, error: 'Missing required fields' });
          continue;
        }

        await db.runAsync(
          `INSERT OR REPLACE INTO items 
           (item_cd, item_name, item_cls_cd, price, tax_type, stock, orgn_nat_cd, pkg_unit_cd, qty_unit_cd, use_yn, synced, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          [
            item.itemCd,
            item.itemNm,
            item.itemClsCd || '50101010',
            Number(item.dftPrc || item.price || 0),
            item.taxTyCd || 'B',
            Number(item.stock || 0),
            item.orgnNatCd || 'KE',
            item.pkgUnitCd || 'NT',
            item.qtyUnitCd || 'U',
            item.useYn || 'Y',
            now,
            now
          ]
        );
        
        try {
          const vscuPayload = mapItemToVSCU(item);
          await db.runAsync(
            `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
            ['/items/saveItems', JSON.stringify(vscuPayload), 'Bulk import queued', now]
          );
          queued++;
        } catch (queueError) {
          errors.push({ item, error: 'Failed to queue for VSCU: ' + queueError.message });
        }
        
        imported++;
      } catch (err) {
        errors.push({ item, error: err.message });
      }
    }

    res.json({
      success: true,
      imported,
      queued,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== ITEM COMPOSITION ROUTES =====

// Get all compositions for an item
router.get('/:itemCd/compositions', async (req, res) => {
  try {
    const { itemCd } = req.params;
    
    const rows = await db.allAsync(
      `SELECT id, parent_item_cd, component_item_cd, component_qty, synced, created_at, updated_at
       FROM item_compositions 
       WHERE parent_item_cd = ? AND use_yn = 'Y'
       ORDER BY created_at DESC`,
      [itemCd]
    );
    
    const compositions = rows.map(row => ({
      id: row.id,
      parentItemCd: row.parent_item_cd,
      cpstItemCd: row.component_item_cd,
      cpstQty: row.component_qty,
      synced: row.synced || 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
    
    res.json({ success: true, data: compositions });
  } catch (error) {
    console.error('Get compositions error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Save item composition (add or update)
router.post('/:itemCd/compositions', async (req, res) => {
  try {
    const { itemCd } = req.params;
    const { cpstItemCd, cpstQty } = req.body;
    const now = new Date().toISOString();

    if (!cpstItemCd || !cpstQty) {
      return res.status(400).json({ 
        success: false, 
        error: 'cpstItemCd and cpstQty are required' 
      });
    }

    const parent = await db.getAsync(
      `SELECT * FROM items WHERE item_cd = ?`,
      [itemCd]
    );
    if (!parent) {
      return res.status(404).json({ 
        success: false, 
        error: 'Parent item not found' 
      });
    }

    const component = await db.getAsync(
      `SELECT * FROM items WHERE item_cd = ?`,
      [cpstItemCd]
    );
    if (!component) {
      return res.status(404).json({ 
        success: false, 
        error: 'Component item not found' 
      });
    }

    const existing = await db.getAsync(
      `SELECT * FROM item_compositions 
       WHERE parent_item_cd = ? AND component_item_cd = ? AND use_yn = 'Y'`,
      [itemCd, cpstItemCd]
    );

    let compositionId;
    if (existing) {
      await db.runAsync(
        `UPDATE item_compositions 
         SET component_qty = ?, updated_at = ?, synced = 0
         WHERE parent_item_cd = ? AND component_item_cd = ?`,
        [cpstQty, now, itemCd, cpstItemCd]
      );
      compositionId = existing.id;
    } else {
      const result = await db.runAsync(
        `INSERT INTO item_compositions 
         (parent_item_cd, component_item_cd, component_qty, synced, use_yn, created_at, updated_at)
         VALUES (?, ?, ?, 0, 'Y', ?, ?)`,
        [itemCd, cpstItemCd, cpstQty, now, now]
      );
      compositionId = result.lastID;
    }

    let synced = false;
    let vscuResponse = null;
    let queued = false;

    try {
      const status = await vscuClient.checkStatus();
      if (status.connected) {
        const vscuPayload = {
          tin: process.env.TIN,
          bhfId: process.env.BHF_ID,
          itemCd: itemCd,
          cpstItemCd: cpstItemCd,
          cpstQty: parseInt(cpstQty),
          regrId: 'Admin',
          regrNm: 'Admin'
        };
        
        vscuResponse = await vscuClient.sendComposition(vscuPayload);
        
        if (vscuResponse && (vscuResponse.resultCd === '000' || vscuResponse.resultCd === '00')) {
          await db.runAsync(
            `UPDATE item_compositions SET synced = 1, updated_at = ? 
             WHERE parent_item_cd = ? AND component_item_cd = ?`,
            [now, itemCd, cpstItemCd]
          );
          synced = true;
          console.log(`✅ Composition ${itemCd}->${cpstItemCd} synced to VSCU`);
        } else {
          const errorMsg = vscuResponse?.resultMsg || vscuResponse?.message || 'Unknown error';
          await db.runAsync(
            `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
            ['/items/saveItemComposition', JSON.stringify(vscuPayload), errorMsg, now]
          );
          queued = true;
          console.log(`Composition ${itemCd}->${cpstItemCd} queued (${errorMsg})`);
        }
      } else {
        const vscuPayload = {
          tin: process.env.TIN,
          bhfId: process.env.BHF_ID,
          itemCd: itemCd,
          cpstItemCd: cpstItemCd,
          cpstQty: parseInt(cpstQty),
          regrId: 'Admin',
          regrNm: 'Admin'
        };
        await db.runAsync(
          `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
          ['/items/saveItemComposition', JSON.stringify(vscuPayload), 'VSCU offline', now]
        );
        queued = true;
        console.log(`VSCU offline - Composition ${itemCd}->${cpstItemCd} queued`);
      }
    } catch (vscuError) {
      console.error('VSCU composition error:', vscuError);
      const vscuPayload = {
        tin: process.env.TIN,
        bhfId: process.env.BHF_ID,
        itemCd: itemCd,
        cpstItemCd: cpstItemCd,
        cpstQty: parseInt(cpstQty),
        regrId: 'Admin',
        regrNm: 'Admin'
      };
      await db.runAsync(
        `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
        ['/items/saveItemComposition', JSON.stringify(vscuPayload), vscuError.message || 'Network error', now]
      );
      queued = true;
    }

    const result = await db.getAsync(
      `SELECT * FROM item_compositions 
       WHERE parent_item_cd = ? AND component_item_cd = ?`,
      [itemCd, cpstItemCd]
    );

    res.json({
      success: true,
      data: {
        id: result.id,
        parentItemCd: result.parent_item_cd,
        cpstItemCd: result.component_item_cd,
        cpstQty: result.component_qty,
        synced: result.synced || 0
      },
      synced: synced,
      queued: queued,
      vscuResponse: vscuResponse
    });

  } catch (error) {
    console.error('Save composition error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete a composition (soft delete)
router.delete('/:itemCd/compositions/:cpstItemCd', async (req, res) => {
  try {
    const { itemCd, cpstItemCd } = req.params;
    const now = new Date().toISOString();

    const existing = await db.getAsync(
      `SELECT * FROM item_compositions 
       WHERE parent_item_cd = ? AND component_item_cd = ? AND use_yn = 'Y'`,
      [itemCd, cpstItemCd]
    );

    if (!existing) {
      return res.status(404).json({ 
        success: false, 
        error: 'Composition not found' 
      });
    }

    await db.runAsync(
      `UPDATE item_compositions 
       SET use_yn = 'N', updated_at = ?, synced = 0
       WHERE parent_item_cd = ? AND component_item_cd = ?`,
      [now, itemCd, cpstItemCd]
    );

    try {
      const status = await vscuClient.checkStatus();
      if (status.connected) {
        const vscuPayload = {
          tin: process.env.TIN,
          bhfId: process.env.BHF_ID,
          itemCd: itemCd,
          cpstItemCd: cpstItemCd,
          cpstQty: existing.component_qty,
          useYn: 'N',
          regrId: 'Admin',
          regrNm: 'Admin'
        };
        
        await db.runAsync(
          `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
          ['/items/saveItemComposition', JSON.stringify(vscuPayload), 'Deletion queued', now]
        );
        console.log(`Composition ${itemCd}->${cpstItemCd} queued for deletion`);
      }
    } catch (queueError) {
      console.error('Queue deletion error:', queueError);
    }

    res.json({ 
      success: true, 
      message: 'Composition removed successfully' 
    });

  } catch (error) {
    console.error('Delete composition error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all compositions for multiple items (bulk)
router.post('/compositions/bulk', async (req, res) => {
  try {
    const { itemCds } = req.body;
    
    if (!itemCds || !Array.isArray(itemCds) || itemCds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'itemCds array is required' 
      });
    }

    const placeholders = itemCds.map(() => '?').join(',');
    const rows = await db.allAsync(
      `SELECT parent_item_cd, component_item_cd, component_qty, synced
       FROM item_compositions 
       WHERE parent_item_cd IN (${placeholders}) AND use_yn = 'Y'
       ORDER BY parent_item_cd, created_at DESC`,
      itemCds
    );

    const grouped = {};
    rows.forEach(row => {
      if (!grouped[row.parent_item_cd]) {
        grouped[row.parent_item_cd] = [];
      }
      grouped[row.parent_item_cd].push({
        cpstItemCd: row.component_item_cd,
        cpstQty: row.component_qty,
        synced: row.synced || 0
      });
    });

    res.json({ success: true, data: grouped });
  } catch (error) {
    console.error('Bulk compositions error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;