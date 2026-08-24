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
  console.log('Fetching purchases from VSCU:', req.body);
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/trnsPurchase/selectTrnsPurchaseSales`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('VSCU Response Code:', response.data?.resultCd);
    console.log('VSCU Response Msg:', response.data?.resultMsg);
    console.log('Purchase list length:', response.data?.data?.purchaseList?.length || 0);
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch purchases from VSCU:', error.message);
    if (error.response) {
      console.error('VSCU Error Status:', error.response.status);
      console.error('VSCU Error Data:', JSON.stringify(error.response.data, null, 2));
    }
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
    
    console.log(`Fetched ${rows.length} purchases from database`);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching purchases:', error);
    res.status(500).json({ error: error.message });
  }
});

// BULK SAVE PURCHASES (from VSCU)
router.post('/bulk', async (req, res) => {
  try {
    const purchaseList = req.body;
    
    if (!Array.isArray(purchaseList) || purchaseList.length === 0) {
      return res.status(400).json({ error: 'Purchases array is required' });
    }

    const now = new Date().toISOString();
    let saved = 0;

    for (const purchase of purchaseList) {
  await db.runAsync(
    `INSERT OR REPLACE INTO purchases (
      invoice_no, supplier_tin, supplier_name, supplier_invoice_no,
      subtotal, tax, total, payment_method, status, synced,
      vscu_signature, date, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      purchase.spplrInvcNo || purchase.invoice_no,
      purchase.spplrTin || purchase.supplier_tin || null,
      purchase.spplrNm || purchase.supplier_name || 'Unknown',
      purchase.spplrInvcNo || purchase.supplier_invoice_no || null,
      purchase.totTaxblAmt || purchase.subtotal || 0,
      purchase.totTaxAmt || purchase.tax || 0,
      purchase.totAmt || purchase.total || 0,
      purchase.pmtTyCd || purchase.payment_method || '01',
      'Completed',
      1,
      null,
      purchase.salesDt || purchase.date || now.slice(0, 10),
      now
    ]
  );
  saved++;
}
    console.log(`Bulk saved ${saved} purchases from VSCU`);
    res.json({ success: true, saved });
  } catch (error) {
    console.error('Bulk save purchases error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save purchase (with VSCU sync)
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    if (!data.supplier_name) {
      return res.status(400).json({ error: 'Supplier name is required' });
    }
    
    if (!data.items || data.items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required' });
    }

    const invoiceNo = data.invoice_no || `PUR-${Date.now().toString().slice(-6)}`;

    let calculatedSubtotal = 0;
    let calculatedTax = 0;
    let calculatedTotal = 0;

    for (const item of data.items) {
      const qty = Number(item.qty || item.quantity || 0);
      const price = Number(item.prc || item.price || 0);
      const taxRate = item.taxTyCd === 'B' ? 16 : 0;
      
      const itemSubtotal = qty * price;
      const itemTax = itemSubtotal * (taxRate / 100);
      
      calculatedSubtotal += itemSubtotal;
      calculatedTax += itemTax;
      calculatedTotal += itemSubtotal + itemTax;
    }

    const subtotal = data.subtotal || calculatedSubtotal;
    const tax = data.tax || calculatedTax;
    const total = data.total || calculatedTotal;

    const vscuPayload = {
      tin: process.env.TIN,
      bhfId: process.env.BHF_ID,
      invcNo: parseInt(invoiceNo.replace('PUR-', '')) || 1,
      orgInvcNo: 0,
      spplrTin: null,
      spplrBhfId: null,
      spplrNm: null,
      spplrInvcNo: null,
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
      taxblAmtB: Number(subtotal),
      taxblAmtC: 0,
      taxblAmtD: 0,
      taxblAmtE: 0,
      taxRtA: 0,
      taxRtB: 18,
      taxRtC: 0,
      taxRtD: 0,
      taxRtE: 0,
      taxAmtA: 0,
      taxAmtB: Number(tax),
      taxAmtC: 0,
      taxAmtD: 0,
      taxAmtE: 0,
      totTaxblAmt: Number(subtotal),
      totTaxAmt: Number(tax),
      totAmt: Number(total),
      remark: data.remark || null,
      regrNm: data.cashier || 'Admin',
      regrId: data.cashier || 'Admin',
      modrNm: data.cashier || 'Admin',
      modrId: data.cashier || 'Admin',
      itemList: data.items.map((item, idx) => {
        const qty = Number(item.qty || item.quantity || 0);
        const price = Number(item.prc || item.price || 0);
        const itemSubtotal = qty * price;
        const taxRate = 18;
        const itemTax = itemSubtotal * (taxRate / 100);
        
        return {
          itemSeq: idx + 1,
          itemCd: item.itemCd,
          itemClsCd: item.itemClsCd || '5059690800',
          itemNm: item.itemNm || item.item_name || 'Unknown',
          bcd: '',
          spplrItemClsCd: null,
          spplrItemCd: null,
          spplrItemNm: null,
          pkgUnitCd: 'NT',
          pkg: 1,
          qtyUnitCd: 'U',
          qty: qty,
          prc: price,
          splyAmt: itemSubtotal,
          dcRt: 0,
          dcAmt: 0,
          taxblAmt: itemSubtotal,
          taxTyCd: item.taxTyCd || item.tax_type || 'B',
          taxAmt: Number(item.taxAmt || item.tax_amount || itemTax),
          totAmt: Number(item.totAmt || item.total || itemSubtotal + itemTax),
          itemExprDt: null
        };
      })
    };

    console.log('Purchase Payload to VSCU:', JSON.stringify(vscuPayload, null, 2));

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
        Number(subtotal),
        Number(tax),
        Number(total),
        data.payment_method || '01',
        'Pending',
        0,
        null,
        data.date || now.slice(0, 10),
        now
      ]
    );

    const purchaseId = result.lastID;
    console.log(`Purchase ${invoiceNo} saved to database (synced = 0)`);

    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      const qty = Number(item.qty || item.quantity || 0);
      const price = Number(item.prc || item.price || 0);
      const itemSubtotal = qty * price;
      const taxRate = item.taxTyCd === 'B' ? 16 : 0;
      const itemTax = itemSubtotal * (taxRate / 100);
      
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
          qty,
          price,
          item.taxTyCd || item.tax_type || 'B',
          Number(item.taxAmt || item.tax_amount || itemTax),
          Number(item.totAmt || item.total || itemSubtotal + itemTax)
        ]
      );
    }

    for (const item of data.items) {
      const qty = Number(item.qty || item.quantity || 0);
      await db.runAsync(
        `UPDATE items SET stock = stock + ? WHERE item_cd = ?`,
        [qty, item.itemCd]
      );
    }

    let synced = false;
    let queued = false;
    let vscuResponse = null;
    let signature = null;

    try {
      const status = await vscuClient.checkStatus();
      
      if (status.connected) {
        try {
          vscuResponse = await vscuClient.savePurchase(vscuPayload);
          console.log('VSCU Response:', JSON.stringify(vscuResponse, null, 2));
          
          if (vscuResponse && (vscuResponse.resultCd === '000' || vscuResponse.resultCd === '00')) {
            synced = true;
            signature = vscuResponse.data?.rcptSign || '';
            console.log(`Purchase ${invoiceNo} synced to VSCU`);
          } else {
            const errorMsg = vscuResponse?.resultMsg || vscuResponse?.message || 'VSCU error';
            console.log(`VSCU returned ${vscuResponse?.resultCd || 'unknown'} - queuing purchase`);
            await db.runAsync(
              `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
              ['/purchases/savePurchases', JSON.stringify(vscuPayload), `VSCU: ${errorMsg}`, now]
            );
            queued = true;
          }
        } catch (vscuError) {
          console.error('VSCU savePurchase error:', vscuError.message);
          if (vscuError.response) {
            console.error('VSCU Error Status:', vscuError.response.status);
            console.error('VSCU Error Data:', JSON.stringify(vscuError.response.data, null, 2));
          }
          await db.runAsync(
            `INSERT INTO sync_queue (endpoint, payload, error_reason, created_at) VALUES (?, ?, ?, ?)`,
            ['/purchases/savePurchases', JSON.stringify(vscuPayload), vscuError.message || 'Network error', now]
          );
          queued = true;
        }
      } else {
        console.log('VSCU offline - queuing purchase');
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

    const finalStatus = synced ? 'Completed' : 'Pending';
    const syncedFlag = synced ? 1 : 0;

    await db.runAsync(
      `UPDATE purchases SET status = ?, synced = ?, vscu_signature = ? WHERE id = ?`,
      [finalStatus, syncedFlag, signature || null, purchaseId]
    );

    if (synced) {
      try {
        for (const item of data.items) {
          const qty = Number(item.qty || item.quantity || 0);
          const price = Number(item.prc || item.price || 0);
          const itemSubtotal = qty * price;
          const taxRate = item.taxTyCd === 'B' ? 16 : 0;
          const itemTax = itemSubtotal * (taxRate / 100);
          
          const stockPayload = {
            tin: process.env.TIN,
            bhfId: process.env.BHF_ID,
            sarNo: parseInt(invoiceNo.replace('PUR-', '')) || 1,
            orgSarNo: 0,
            regTyCd: 'M',
            custTin: data.supplier_tin || null,
            custNm: data.supplier_name || null,
            custBhfId: null,
            sarTyCd: '1',
            ocrnDt: (data.date || now.slice(0, 10)).replace(/-/g, ''),
            totItemCnt: 1,
            totTaxblAmt: itemSubtotal,
            totTaxAmt: itemTax,
            totAmt: itemSubtotal + itemTax,
            remark: null,
            regrId: data.cashier || 'Admin',
            regrNm: data.cashier || 'Admin',
            modrNm: data.cashier || 'Admin',
            modrId: data.cashier || 'Admin',
            itemList: [{
              itemSeq: 1,
              itemCd: item.itemCd,
              itemClsCd: item.itemClsCd || '50101010',
              itemNm: item.itemNm || item.item_name || 'Unknown',
              bcd: null,
              pkgUnitCd: 'NT',
              pkg: 1,
              qtyUnitCd: 'U',
              qty: qty,
              itemExprDt: null,
              prc: price,
              splyAmt: itemSubtotal,
              totDcAmt: 0,
              taxblAmt: itemSubtotal,
              taxTyCd: item.taxTyCd || item.tax_type || 'B',
              taxAmt: itemTax,
              totAmt: itemSubtotal + itemTax
            }]
          };

          try {
            const stockResponse = await vscuClient.saveStock(stockPayload);
            console.log(`Stock sync for ${item.itemCd}:`, stockResponse?.resultCd === '000' ? 'Success' : 'Failed');
          } catch (stockError) {
            console.error(`Stock sync error for ${item.itemCd}:`, stockError.message);
          }
        }
      } catch (stockError) {
        console.error('Stock sync error:', stockError.message);
      }
    }

    const savedPurchase = await db.getAsync(`SELECT * FROM purchases WHERE id = ?`, [purchaseId]);
    const savedItems = await db.allAsync(`SELECT * FROM purchase_items WHERE purchase_id = ?`, [purchaseId]);
    savedPurchase.items = savedItems;

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