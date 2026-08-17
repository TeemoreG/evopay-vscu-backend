const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// ============================================
// VSCU PROXY ENDPOINT
// ============================================

// Get purchases from VSCU
router.post('/selectTrnsPurchaseSales', async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/trnsPurchase/selectTrnsPurchaseSales`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch purchases from VSCU:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LOCAL CRUD + VSCU SYNC
// ============================================

// Get all purchases (local)
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT * FROM purchases ORDER BY created_at DESC`);
    
    for (const purchase of rows) {
      const items = await db.allAsync(
        `SELECT * FROM purchase_items WHERE purchase_id = ?`,
        [purchase.id]
      );
      purchase.items = items;
       purchase.totItemCnt = items.length;
    }
    
    res.json(rows);
  } catch (error) {
    console.error('Error fetching purchases:', error);
    res.status(500).json({ error: error.message });
  }
});

// Save purchase (with VSCU sync)
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    // Validate required fields
    if (!data.supplier_name) {
      return res.status(400).json({ error: 'Supplier name is required' });
    }
    
    if (!data.items || data.items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    // Generate invoice number if not provided
    const invoiceNo = data.invoice_no || `PUR-${Date.now().toString().slice(-6)}`;

    // ============================================
    // 1. BUILD VSCU PAYLOAD
    // ============================================
    const vscuPayload = {
      tin: process.env.TIN,
      bhfId: process.env.BHF_ID,
      invcNo: parseInt(invoiceNo.replace('PUR-', '')) || 1,
      orgInvcNo: 0,
      spplrTin: data.supplier_tin || null,
      spplrBhfId: '00',
      spplrNm: data.supplier_name,
      spplrInvcNo: data.supplier_invoice_no || null,
      regTyCd: 'M',
      pchsTyCd: 'N',
      rcptTyCd: 'P',
      pmtTyCd: data.payment_method || '01',
      pchsSttsCd: '02',
      cfmDt: now.replace(/[-:T.]/g, '').slice(0, 14),
      pchsDt: (data.date || now.slice(0, 10)).replace(/-/g, ''),
      wrhsDt: '',
      cnclReqDt: '',
      cnclDt: '',
      rfdDt: '',
      totItemCnt: Number(data.items.length),
      taxblAmtA: 0,
      taxblAmtB: Number(data.subtotal || 0),
      taxblAmtC: 0,
      taxblAmtD: 0,
      taxblAmtE: 0,
      taxRtA: 0,
      taxRtB: 16,
      taxRtC: 0,
      taxRtD: 0,
      taxRtE: 0,
      taxAmtA: 0,
      taxAmtB: Number(data.tax || 0),
      taxAmtC: 0,
      taxAmtD: 0,
      taxAmtE: 0,
      totTaxblAmt: Number(data.subtotal || 0),
      totTaxAmt: Number(data.tax || 0),
      totAmt: Number(data.total || 0),
      remark: data.remark || null,
      regrNm: data.cashier || 'Admin',
      regrId: data.cashier || 'Admin',
      modrNm: data.cashier || 'Admin',
      modrId: data.cashier || 'Admin',
      itemList: data.items.map((item, idx) => ({
        itemSeq: idx + 1,
        itemCd: item.itemCd,
        itemClsCd: item.itemClsCd || '50101010',
        itemNm: item.itemNm || item.item_name,
        bcd: null,
        spplrItemClsCd: null,
        spplrItemCd: null,
        spplrItemNm: null,
        pkgUnitCd: 'NT',
        pkg: 1,
        qtyUnitCd: 'U',
        qty: Number(item.qty || item.quantity || 0),
        prc: Number(item.prc || item.price || 0),
        splyAmt: Number((item.qty || item.quantity || 0) * (item.prc || item.price || 0)),
        dcRt: 0,
        dcAmt: 0,
        taxblAmt: Number((item.qty || item.quantity || 0) * (item.prc || item.price || 0)),
        taxTyCd: item.taxTyCd || item.tax_type || 'B',
        taxAmt: Number(item.taxAmt || item.tax_amount || 0),
        totAmt: Number(item.totAmt || item.total || 0),
        itemExprDt: null
      }))
    };

    console.log('📤 Purchase Payload to VSCU:', JSON.stringify(vscuPayload, null, 2));

    // ============================================
    // 2. SAVE TO DATABASE FIRST (ALWAYS)
    // ============================================
    const result = await db.runAsync(
      `INSERT INTO purchases 
       (invoice_no, supplier_tin, supplier_name, supplier_invoice_no, 
        subtotal, tax, total, payment_method, status, synced, 
        vscu_signature, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNo,
        data.supplier_tin || null,
        data.supplier_name,
        data.supplier_invoice_no || null,
        Number(data.subtotal || 0),
        Number(data.tax || 0),
        Number(data.total || 0),
        data.payment_method || '01',
        'Pending',
        0,
        null,
        data.date || now.slice(0, 10),
        now
      ]
    );

    const purchaseId = result.lastID;
    console.log(`✅ Purchase ${invoiceNo} saved to database (synced = 0)`);

    // ============================================
    // 3. SAVE PURCHASE ITEMS TO DATABASE
    // ============================================
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      await db.runAsync(
        `INSERT INTO purchase_items 
         (purchase_id, item_seq, item_cd, item_name, item_cls_cd, 
          quantity, price, tax_type, tax_amount, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          purchaseId,
          i + 1,
          item.itemCd || item.item_cd,
          item.itemNm || item.item_name || 'Unknown',
          item.itemClsCd || item.item_cls_cd || '50101010',
          Number(item.qty || item.quantity || 0),
          Number(item.prc || item.price || 0),
          item.taxTyCd || item.tax_type || 'B',
          Number(item.taxAmt || item.tax_amount || 0),
          Number(item.totAmt || item.total || 0)
        ]
      );
    }

    // ============================================
    // 3.5 UPDATE LOCAL STOCK (IN)
    // ============================================
    for (const item of data.items) {
      await db.runAsync(
        `UPDATE items SET stock = stock + ? WHERE item_cd = ?`,
        [Number(item.qty || item.quantity || 0), item.itemCd]
      );
    }

    // ============================================
    // 4. THEN TRY TO SYNC TO VSCU
    // ============================================
    let synced = false;
    let queued = false;
    let vscuResponse = null;
    let signature = null;

    try {
      const status = await vscuClient.checkStatus();
      
      if (status.connected) {
        vscuResponse = await vscuClient.savePurchase(vscuPayload);
        console.log('VSCU Response:', vscuResponse);
        
        if (vscuResponse && (vscuResponse.resultCd === '000' || vscuResponse.resultCd === '00')) {
          synced = true;
          signature = vscuResponse.data?.rcptSign || '';
          console.log(`✅ Purchase ${invoiceNo} synced to VSCU`);
        } else {
          const errorMsg = vscuResponse?.resultMsg || vscuResponse?.message || 'VSCU error';
          console.log(`VSCU returned ${vscuResponse?.resultCd || 'unknown'} - queuing purchase`);
          await db.runAsync(
            `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
            ['/purchases/savePurchases', JSON.stringify(vscuPayload), `VSCU: ${errorMsg}`, now]
          );
          queued = true;
        }
      } else {
        console.log('VSCU offline - queuing purchase for later');
        await db.runAsync(
          `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
          ['/purchases/savePurchases', JSON.stringify(vscuPayload), 'VSCU offline', now]
        );
        queued = true;
      }
    } catch (vscuError) {
      console.error('VSCU sync error:', vscuError.message);
      await db.runAsync(
        `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
        ['/purchases/savePurchases', JSON.stringify(vscuPayload), vscuError.message || 'Network error', now]
      );
      queued = true;
    }

    // ============================================
    // 5. UPDATE DATABASE WITH SYNC RESULT
    // ============================================
    const finalStatus = synced ? 'Completed' : 'Pending';
    const syncedFlag = synced ? 1 : 0;

    await db.runAsync(
      `UPDATE purchases 
       SET status = ?, synced = ?, vscu_signature = ? 
       WHERE id = ?`,
      [finalStatus, syncedFlag, signature || null, purchaseId]
    );

    // ============================================
    // 5.5 SYNC STOCK TO VSCU (only if purchase was synced)
    // ============================================
    if (synced) {
      try {
        for (const item of data.items) {
          const stockPayload = {
            tin: process.env.TIN,
            bhfId: process.env.BHF_ID,
            sarNo: parseInt(invoiceNo.replace('PUR-', '')) || 1,
            orgSarNo: 0,
            regTyCd: 'M',
            custTin: data.supplier_tin || null,
            custNm: data.supplier_name || null,
            custBhfId: null,
            sarTyCd: '1', // IN
            ocrnDt: (data.date || now.slice(0, 10)).replace(/-/g, ''),
            totItemCnt: 1,
            totTaxblAmt: Number(item.subtotal || 0),
            totTaxAmt: Number(item.tax_amount || 0),
            totAmt: Number(item.total || 0),
            remark: null,
            regrId: data.cashier || 'Admin',
            regrNm: data.cashier || 'Admin',
            modrNm: data.cashier || 'Admin',
            modrId: data.cashier || 'Admin',
            itemList: [{
              itemSeq: 1,
              itemCd: item.itemCd,
              itemClsCd: item.itemClsCd || '50101010',
              itemNm: item.itemNm || item.item_name,
              bcd: null,
              pkgUnitCd: 'NT',
              pkg: 1,
              qtyUnitCd: 'U',
              qty: Number(item.qty || item.quantity || 0),
              itemExprDt: null,
              prc: Number(item.prc || item.price || 0),
              splyAmt: Number((item.qty || item.quantity || 0) * (item.prc || item.price || 0)),
              totDcAmt: 0,
              taxblAmt: Number((item.qty || item.quantity || 0) * (item.prc || item.price || 0)),
              taxTyCd: item.taxTyCd || item.tax_type || 'B',
              taxAmt: Number(item.taxAmt || item.tax_amount || 0),
              totAmt: Number(item.totAmt || item.total || 0)
            }]
          };

          const stockResponse = await vscuClient.saveStock(stockPayload);
          console.log(`Stock sync for ${item.itemCd}:`, stockResponse?.resultCd === '000' ? 'Success' : 'Failed');
        }
      } catch (stockError) {
        console.error('Stock sync error:', stockError.message);
      }
    }

    // ============================================
    // 6. GET FINAL PURCHASE DATA
    // ============================================
    const savedPurchase = await db.getAsync(
      `SELECT * FROM purchases WHERE id = ?`,
      [purchaseId]
    );
    const savedItems = await db.allAsync(
      `SELECT * FROM purchase_items WHERE purchase_id = ?`,
      [purchaseId]
    );
    savedPurchase.items = savedItems;

    // ============================================
    // 7. RETURN RESPONSE
    // ============================================
    res.json({
      success: true,
      id: purchaseId,
      invoice_no: invoiceNo,
      synced: synced,
      queued: queued,
      vscuResponse: vscuResponse,
      message: synced ? 'Purchase synced to KRA' : queued ? 'Purchase saved and queued for sync' : 'Purchase saved locally',
      purchase: savedPurchase
    });

  } catch (error) {
    console.error('Save purchase error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;