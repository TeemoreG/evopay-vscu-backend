// backend/routes/sales.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const vscuClient = require('../services/vscuClient');

// Create sale - DB FIRST, then VSCU
router.post('/', async (req, res) => {
  try {
    console.log('=== CREATE SALE REQUEST ===');
    console.log('Full body:', JSON.stringify(req.body, null, 2));
    
    const { 
      customer, 
      customerPin, 
      cashier, 
      items, 
      subtotal, 
      tax, 
      total, 
      paymentMethod, 
      date, 
      receipt 
    } = req.body;
    
    const invoiceNo = `INV-${Date.now().toString().slice(-6)}`;
    const now = new Date().toISOString();

    // Validate required fields
    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    // Validate and normalize payment method
    let finalPaymentMethod = '01';
    if (paymentMethod !== undefined && paymentMethod !== null && paymentMethod !== '') {
      let method = String(paymentMethod).trim();
      if (method.length === 1 && !isNaN(method)) method = '0' + method;
      if (['01', '02', '03'].includes(method)) {
        finalPaymentMethod = method;
      } else {
        console.warn(`Invalid payment method "${method}", defaulting to "01"`);
      }
    }

    console.log('Final payment method:', finalPaymentMethod);

    // ============================================
    // 1. BUILD VSCU PAYLOAD
    // ============================================
    const vscuPayload = {
      tin: process.env.TIN,
      bhfId: process.env.BHF_ID,
      invcNo: parseInt(invoiceNo.replace('INV-', '')),
      orgInvcNo: 0,
      custTin: customerPin || '',
      custNm: customer || 'Walk-in Customer',
      salesTyCd: 'N',
      rcptTyCd: 'S',
      pmtTyCd: finalPaymentMethod,
      salesSttsCd: '02',
      cfmDt: now.replace(/[-:T.]/g, '').slice(0, 14),
      salesDt: (date || now.slice(0, 10)).replace(/-/g, ''),
      stockRlsDt: now.replace(/[-:T.]/g, '').slice(0, 14),
      cnclReqDt: null,
      cnclDt: null,
      rfdDt: null,
      rfdRsnCd: null,
      totItemCnt: Number(items.length),
      taxblAmtA: 0,
      taxblAmtB: Number(tax || 0),
      taxblAmtC: 0,
      taxblAmtD: 0,
      taxblAmtE: 0,
      taxRtA: 0,
      taxRtB: 16,
      taxRtC: 0,
      taxRtD: 0,
      taxRtE: 0,
      taxAmtA: 0,
      taxAmtB: Number(tax || 0),
      taxAmtC: 0,
      taxAmtD: 0,
      taxAmtE: 0,
      totTaxblAmt: Number(subtotal || 0),
      totTaxAmt: Number(tax || 0),
      totAmt: Number(total || 0),
      prchrAcptcYn: 'N',
      remark: null,
      regrId: cashier || '11999',
      regrNm: cashier || 'TestVSCU',
      modrId: cashier || '45678',
      modrNm: cashier || 'TestVSCU',
      receipt: {
        custTin: customerPin || '',
        custMblNo: null,
        rptNo: 1,
        trdeNm: 'Evopay',
        adrs: '',
        topMsg: receipt?.topMsg || 'Thank you for your business!',
        btmMsg: receipt?.btmMsg || 'KRA eTIMS VSCU v2.0.21',
        prchrAcptcYn: 'N'
      },
      itemList: items.map((item, idx) => ({
        itemSeq: idx + 1,
        itemCd: item.item_cd,
        itemClsCd: item.item_cls_cd || '50101010',
        itemNm: item.item_name,
        bcd: null,
        pkgUnitCd: 'NT',
        pkg: 1,
        qtyUnitCd: 'U',
        qty: Number(item.quantity || 0),
        prc: Number(item.price || 0),
        splyAmt: Number((item.quantity || 0) * (item.price || 0)),
        dcRt: 0,
        dcAmt: 0,
        isrccCd: null,
        isrccNm: null,
        isrcRt: null,
        isrcAmt: null,
        taxTyCd: item.tax_type || 'B',
        taxblAmt: Number(item.total || 0),
        taxAmt: Number(item.tax_amount || 0),
        totAmt: Number(item.total || 0)
      }))
    };

    console.log('..Sale Payload to VSCU..:', JSON.stringify(vscuPayload, null, 2));

    // ============================================
    // 2. SAVE TO DATABASE FIRST (ALWAYS)
    // ============================================
    const result = await db.runAsync(
      `INSERT INTO sales 
       (invoice_no, customer, customer_pin, cashier, subtotal, tax, total, payment_method, 
        status, synced, vscu_signature, receipt_no, date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoiceNo, customer, customerPin, cashier || 'Unknown', subtotal, tax, total, 
       finalPaymentMethod, 'Pending', 0, null, null, 
       date || now.slice(0, 10), now]
    );

    const saleId = result.lastID;
    console.log(`✅ Sale ${invoiceNo} saved to database (synced = 0)`);

    // ============================================
    // 3. SAVE SALE ITEMS TO DATABASE
    // ============================================
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await db.runAsync(
        `INSERT INTO sales_items 
         (sale_id, item_seq, item_cd, item_name, item_cls_cd, quantity, price, tax_type, tax_amount, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [saleId, i + 1, item.item_cd, item.item_name, item.item_cls_cd || '50101010', 
         item.quantity, item.price, item.tax_type, item.tax_amount || 0, item.total || 0]
      );
    }

    // ============================================
    // 4. UPDATE LOCAL STOCK
    // ============================================
    for (const item of items) {
      await db.runAsync(
        `UPDATE items SET stock = stock - ? WHERE item_cd = ?`,
        [item.quantity, item.item_cd]
      );
      await db.runAsync(
        `INSERT INTO stock_movements (item_cd, quantity, type, reference, date, created_at)
         VALUES (?, ?, 'OUT', ?, ?, ?)`,
        [item.item_cd, item.quantity, invoiceNo, date || now.slice(0, 10), now]
      );
    }

    // ============================================
    // 5. THEN TRY TO SYNC TO VSCU
    // ============================================
    let synced = false;
    let queued = false;
    let vscuResponse = null;
    let signature = null;
    let receiptNo = null;

    try {
      const status = await vscuClient.checkStatus();
      
      if (status.connected) {
        vscuResponse = await vscuClient.sendSale(vscuPayload);
        console.log('VSCU Response:', vscuResponse);
        
        if (vscuResponse && (vscuResponse.resultCd === '000' || vscuResponse.resultCd === '00')) {
          synced = true;
          signature = vscuResponse.data?.rcptSign || '';
          receiptNo = vscuResponse.data?.rcptInvcNo || '';
          console.log('✅ Sale approved by VSCU, signature received');
        } else {
          // VSCU rejected - check if we should queue
          const errorMsg = vscuResponse?.resultMsg || vscuResponse?.message || 'VSCU error';
          console.log(`VSCU returned ${vscuResponse?.resultCd || 'unknown'} - queuing sale`);
          await db.runAsync(
            `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
            ['/trnsSales/saveSales', JSON.stringify(vscuPayload), `VSCU: ${errorMsg}`, now]
          );
          queued = true;
        }
      } else {
        // VSCU offline - QUEUE for later
        console.log('VSCU offline - queuing sale for later');
        await db.runAsync(
          `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
          ['/trnsSales/saveSales', JSON.stringify(vscuPayload), 'VSCU offline', now]
        );
        queued = true;
      }
    } catch (vscuError) {
      console.error('VSCU Sync Error:', vscuError.message);
      await db.runAsync(
        `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
        ['/trnsSales/saveSales', JSON.stringify(vscuPayload), vscuError.message || 'Network error', now]
      );
      queued = true;
    }

    // ============================================
    // 6. UPDATE DATABASE WITH SYNC RESULT
    // ============================================
    const finalStatus = synced ? 'Completed' : 'Pending';
    const syncedFlag = synced ? 1 : 0;

    await db.runAsync(
      `UPDATE sales 
       SET status = ?, synced = ?, vscu_signature = ?, receipt_no = ? 
       WHERE id = ?`,
      [finalStatus, syncedFlag, signature || null, receiptNo || null, saleId]
    );

    // ============================================
    // 7. SYNC STOCK TO VSCU (only if sale was synced)
    // ============================================
    if (synced) {
      try {
        for (const item of items) {
          const stockPayload = {
            tin: process.env.TIN,
            bhfId: process.env.BHF_ID,
            sarNo: parseInt(invoiceNo.replace('INV-', '')),
            orgSarNo: 0,
            regTyCd: 'M',
            custTin: customerPin || null,
            custNm: customer || null,
            custBhfId: null,
            sarTyCd: '2', // OUT
            ocrnDt: (date || now.slice(0, 10)).replace(/-/g, ''),
            totItemCnt: 1,
            totTaxblAmt: item.subtotal || 0,
            totTaxAmt: item.tax_amount || 0,
            totAmt: item.total || 0,
            remark: null,
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
              qty: item.quantity || 0,
              itemExprDt: null,
              prc: item.price || 0,
              splyAmt: (item.quantity || 0) * (item.price || 0),
              totDcAmt: 0,
              taxblAmt: item.subtotal || 0,
              taxTyCd: item.tax_type || 'B',
              taxAmt: item.tax_amount || 0,
              totAmt: item.total || 0
            }]
          };

          const stockResponse = await vscuClient.saveStock(stockPayload);
          console.log(`Stock sync for ${item.item_cd}:`, stockResponse?.resultCd === '000' ? 'Success' : 'Failed');
        }
      } catch (stockError) {
        console.error('Stock sync error:', stockError.message);
      }
    }

    // ============================================
    // 8. GET FINAL SALE DATA
    // ============================================
    const updatedSale = await db.getAsync(`SELECT * FROM sales WHERE id = ?`, [saleId]);
    const updatedItems = await db.allAsync(`SELECT * FROM sales_items WHERE sale_id = ?`, [saleId]);
    updatedSale.items = updatedItems;

    // ============================================
    // 9. RETURN RESPONSE
    // ============================================
    res.json({
      success: true,
      synced: synced,
      queued: queued,
      saleId,
      invoiceNo,
      paymentMethod: finalPaymentMethod,
      vscuResponse: vscuResponse,
      signature: signature,
      receipt: {
        number: receiptNo,
        signature: signature,
        status: finalStatus
      },
      message: synced ? 'Sale synced to KRA' : queued ? 'Sale saved and queued for sync' : 'Sale saved locally',
      sale: updatedSale
    });

  } catch (error) {
    console.error('Sale error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get all sales (with items included)
router.get('/', async (req, res) => {
  try {
    const { start, end, status } = req.query;
    let sql = `SELECT * FROM sales WHERE 1=1`;
    const params = [];

    if (start) {
      sql += ` AND date >= ?`;
      params.push(start);
    }
    if (end) {
      sql += ` AND date <= ?`;
      params.push(end);
    }
    if (status) {
      sql += ` AND status = ?`;
      params.push(status);
    }
    sql += ` ORDER BY date DESC, id DESC`;

    const rows = await db.allAsync(sql, params);
    
    for (const sale of rows) {
      const items = await db.allAsync(
        `SELECT * FROM sales_items WHERE sale_id = ?`,
        [sale.id]
      );
      sale.items = items;
      sale.totItemCnt = items.length;
    }
    
    res.json(rows);
  } catch (error) {
    console.error('GET sales error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single sale with items
router.get('/:id', async (req, res) => {
  try {
    const sale = await db.getAsync(`SELECT * FROM sales WHERE id = ?`, [req.params.id]);
    if (!sale) {
      return res.status(404).json({ error: 'Sale not found' });
    }
    const items = await db.allAsync(`SELECT * FROM sales_items WHERE sale_id = ?`, [req.params.id]);
    res.json({ ...sale, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Retry failed sync
router.post('/:id/retry', async (req, res) => {
  try {
    const sale = await db.getAsync(`SELECT * FROM sales WHERE id = ? AND synced = 0`, [req.params.id]);
    if (!sale) {
      return res.status(404).json({ error: 'Sale not found or already synced' });
    }

    const items = await db.allAsync(`SELECT * FROM sales_items WHERE sale_id = ?`, [req.params.id]);
    
    const now = new Date().toISOString();
    const vscuPayload = {
      tin: process.env.TIN,
      bhfId: process.env.BHF_ID,
      invcNo: parseInt(sale.invoice_no.replace('INV-', '')),
      orgInvcNo: 0,
      custTin: sale.customer_pin || '',
      custNm: sale.customer || 'Walk-in Customer',
      salesTyCd: 'N',
      rcptTyCd: 'S',
      pmtTyCd: sale.payment_method || '01',
      salesSttsCd: '02',
      cfmDt: now.replace(/[-:T.]/g, '').slice(0, 14),
      salesDt: sale.date ? sale.date.replace(/-/g, '') : now.replace(/[-:T.]/g, '').slice(0, 8),
      stockRlsDt: now.replace(/[-:T.]/g, '').slice(0, 14),
      cnclReqDt: null,
      cnclDt: null,
      rfdDt: null,
      rfdRsnCd: null,
      totItemCnt: items.length,
      taxblAmtA: 0,
      taxblAmtB: sale.tax || 0,
      taxblAmtC: 0,
      taxblAmtD: 0,
      taxblAmtE: 0,
      taxRtA: 0,
      taxRtB: 16,
      taxRtC: 0,
      taxRtD: 0,
      taxRtE: 0,
      taxAmtA: 0,
      taxAmtB: sale.tax || 0,
      taxAmtC: 0,
      taxAmtD: 0,
      taxAmtE: 0,
      totTaxblAmt: sale.subtotal || 0,
      totTaxAmt: sale.tax || 0,
      totAmt: sale.total || 0,
      prchrAcptcYn: 'N',
      remark: null,
      regrId: sale.cashier || '11999',
      regrNm: sale.cashier || 'TestVSCU',
      modrId: sale.cashier || '45678',
      modrNm: sale.cashier || 'TestVSCU',
      receipt: {
        custTin: sale.customer_pin || '',
        custMblNo: null,
        rptNo: 1,
        trdeNm: 'Evopay',
        adrs: '',
        topMsg: 'Thank you for your business!',
        btmMsg: 'KRA eTIMS VSCU v2.0.21',
        prchrAcptcYn: 'N'
      },
      itemList: items.map((item, idx) => ({
        itemSeq: idx + 1,
        itemCd: item.item_cd,
        itemClsCd: item.item_cls_cd || '50101010',
        itemNm: item.item_name,
        bcd: null,
        pkgUnitCd: 'NT',
        pkg: 1,
        qtyUnitCd: 'U',
        qty: item.quantity || 0,
        prc: item.price || 0,
        splyAmt: (item.quantity || 0) * (item.price || 0),
        dcRt: 0,
        dcAmt: 0,
        isrccCd: null,
        isrccNm: null,
        isrcRt: null,
        isrcAmt: null,
        taxTyCd: item.tax_type || 'B',
        taxblAmt: item.total || 0,
        taxAmt: item.tax_amount || 0,
        totAmt: item.total || 0
      }))
    };

    const vscuResponse = await vscuClient.sendSale(vscuPayload);

    if (vscuResponse && (vscuResponse.resultCd === '000' || vscuResponse.resultCd === '00')) {
      await db.runAsync(
        `UPDATE sales SET status = 'Completed', synced = 1, synced_at = ?, 
         vscu_signature = ?, receipt_no = ? WHERE id = ?`,
        [now, vscuResponse.data?.rcptSign || '', 
         vscuResponse.data?.rcptInvcNo || '', req.params.id]
      );
      res.json({ success: true, synced: true, vscuResponse });
    } else {
      res.json({ success: false, synced: false, vscuResponse });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get sales summary/stats
router.get('/stats/summary', async (req, res) => {
  try {
    const total = await db.getAsync(`SELECT COUNT(*) as count FROM sales`);
    const completed = await db.getAsync(`SELECT COUNT(*) as count, SUM(total) as revenue FROM sales WHERE status = 'Completed'`);
    const pending = await db.getAsync(`SELECT COUNT(*) as count FROM sales WHERE status = 'Pending'`);
    const taxTotal = await db.getAsync(`SELECT SUM(tax) as tax FROM sales WHERE status = 'Completed'`);
    
    res.json({
      total: total?.count || 0,
      completed: completed?.count || 0,
      pending: pending?.count || 0,
      revenue: completed?.revenue || 0,
      tax: taxTotal?.tax || 0,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;