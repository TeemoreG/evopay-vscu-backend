// backend/routes/sync.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const vscuClient = require('../services/vscuClient');

// Helper: Get pending count with optional page filter
async function getPendingCount(page) {
  let endpointFilter = '';
  if (page === 'items') endpointFilter = "AND endpoint = '/items/saveItems'";
  else if (page === 'stock') endpointFilter = "AND endpoint = '/stock/saveStockItems'";
  else if (page === 'imports') endpointFilter = "AND endpoint = '/imports/updateImportItems'";
  else if (page === 'sales') endpointFilter = "AND endpoint = '/trnsSales/saveSales'";
  else if (page === 'purchases') endpointFilter = "AND endpoint = '/purchases/savePurchases'";
  else if (page === 'branches') endpointFilter = "AND endpoint IN ('/branches/saveBrancheCustomers', '/branches/saveBrancheUsers')";
  else if (page === 'compositions') endpointFilter = "AND endpoint = '/items/saveItemComposition'";
  
  const result = await db.getAsync(
    `SELECT COUNT(*) as count FROM sync_queue WHERE status = 'pending' ${endpointFilter}`
  );
  return result?.count || 0;
}

// Helper: Process sync queue
async function processSyncQueue() {
  const queue = await db.allAsync(
    `SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`
  );

  if (queue.length === 0) {
    return { synced: 0, failed: 0 };
  }

  let synced = 0;
  let failed = 0;

  for (const item of queue) {
    const now = new Date().toISOString();
    try {
      const payload = JSON.parse(item.payload);
      let response = null;

      if (item.endpoint === '/trnsSales/saveSales') {
        response = await vscuClient.sendSale(payload);
      } else if (item.endpoint === '/items/saveItems') {
        response = await vscuClient.saveItem(payload);
      } else if (item.endpoint === '/items/saveItemComposition') {
        response = await vscuClient.sendComposition(payload);
      } else if (item.endpoint === '/stock/saveStockItems') {
        response = await vscuClient.saveStock(payload);
      } else if (item.endpoint === '/purchases/savePurchases') {
        response = await vscuClient.savePurchase(payload);
      } else if (item.endpoint === '/branches/saveBrancheCustomers') {
        response = await vscuClient.saveBranchCustomer(payload);
      } else if (item.endpoint === '/branches/saveBrancheUsers') {
        response = await vscuClient.saveBranchUser(payload);
      }

      if (response && (response.resultCd === '000' || response.resultCd === '00')) {
        await db.runAsync(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
        synced++;
      } else {
        const errorMsg = response?.resultMsg || response?.message || 'Unknown error';
        await db.runAsync(
          `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = ? WHERE id = ?`,
          [errorMsg, now, item.id]
        );
        failed++;
      }
    } catch (itemError) {
      console.error('Error processing sync item:', itemError);
      await db.runAsync(
        `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = ? WHERE id = ?`,
        [itemError.message, now, item.id]
      );
      failed++;
    }
  }

  return { synced, failed };
}

// Process sync queue - send pending items to VSCU
router.post('/process', async (req, res) => {
  try {
    // Check if VSCU is online first
    const isOnline = await vscuClient.checkStatus();
    
    if (!isOnline) {
      return res.json({
        success: false,
        message: 'VSCU is offline. Items will sync later.',
        pending: await getPendingCount()
      });
    }

    const queue = await db.allAsync(
      `SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`
    );

    if (queue.length === 0) {
      return res.json({ success: true, synced: 0, failed: 0, message: 'No items to sync' });
    }

    let synced = 0;
    let failed = 0;
    const errors = [];

    for (const item of queue) {
      const now = new Date().toISOString();
      try {
        const payload = JSON.parse(item.payload);
        let response = null;

        // Route to appropriate VSCU endpoint based on the stored endpoint
        if (item.endpoint === '/trnsSales/saveSales') {
          response = await vscuClient.sendSale(payload);
        } else if (item.endpoint === '/items/saveItems') {
          response = await vscuClient.saveItem(payload);
        } else if (item.endpoint === '/items/saveItemComposition') {
          response = await vscuClient.sendComposition(payload);
        } else if (item.endpoint === '/stock/saveStockItems') {
          response = await vscuClient.saveStock(payload);
        } else if (item.endpoint === '/purchases/savePurchases') {
          response = await vscuClient.savePurchase(payload);
        } else if (item.endpoint === '/branches/saveBrancheCustomers') {
          response = await vscuClient.saveBranchCustomer(payload);
        } else if (item.endpoint === '/branches/saveBrancheUsers') {
          response = await vscuClient.saveBranchUser(payload);
        } else {
          // Unknown endpoint - mark as failed
          await db.runAsync(
            `UPDATE sync_queue SET status = 'failed', error = ?, retry_count = retry_count + 1 WHERE id = ?`,
            ['Unknown endpoint: ' + item.endpoint, item.id]
          );
          failed++;
          continue;
        }

        // Check response - VSCU returns resultCd === '000' for success
        if (response && (response.resultCd === '000' || response.resultCd === '00')) {
          // Success - delete from queue
          await db.runAsync(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
          synced++;
        } else {
          // Failed - increment retry count
          const errorMsg = response?.resultMsg || response?.message || 'Unknown error';
          await db.runAsync(
            `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = ? WHERE id = ?`,
            [errorMsg, now, item.id]
          );
          failed++;
          errors.push({ id: item.id, endpoint: item.endpoint, error: errorMsg });
        }
      } catch (itemError) {
        console.error('Error processing sync item:', itemError);
        await db.runAsync(
          `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = ? WHERE id = ?`,
          [itemError.message, now, item.id]
        );
        failed++;
        errors.push({ id: item.id, error: itemError.message });
      }
    }

    // Get remaining count
    const remaining = await getPendingCount();

    res.json({
      success: true,
      synced,
      failed,
      remaining,
      errors: errors.length > 0 ? errors : undefined,
      message: `Synced ${synced} items, ${failed} failed. ${remaining} remaining.`
    });
  } catch (error) {
    console.error('Sync process error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get sync queue status - UPDATED with page filter
router.get('/status', async (req, res) => {
  try {
    const { page } = req.query;
    
    // Map page to endpoint filter
    let endpointFilter = '';
    if (page === 'items') endpointFilter = "AND endpoint = '/items/saveItems'";
    else if (page === 'stock') endpointFilter = "AND endpoint = '/stock/saveStockItems'";
    else if (page === 'imports') endpointFilter = "AND endpoint = '/imports/updateImportItems'";
    else if (page === 'sales') endpointFilter = "AND endpoint = '/trnsSales/saveSales'";
    else if (page === 'purchases') endpointFilter = "AND endpoint = '/purchases/savePurchases'";
    else if (page === 'branches') endpointFilter = "AND endpoint IN ('/branches/saveBrancheCustomers', '/branches/saveBrancheUsers')";
    else if (page === 'compositions') endpointFilter = "AND endpoint = '/items/saveItemComposition'";
    
    const pending = await db.getAsync(
      `SELECT COUNT(*) as count FROM sync_queue WHERE status = 'pending' ${endpointFilter}`
    );
    
    const total = await db.getAsync(`SELECT COUNT(*) as count FROM sync_queue`);
    
    // Group by endpoint for this page
    const byEndpoint = await db.allAsync(
      `SELECT endpoint, COUNT(*) as count FROM sync_queue WHERE status = 'pending' ${endpointFilter} GROUP BY endpoint`
    );
    
    // Get recent errors for this page
    const recentErrors = await db.allAsync(
      `SELECT id, endpoint, error, retry_count, created_at, last_attempt 
       FROM sync_queue 
       WHERE status = 'pending' AND retry_count > 0 ${endpointFilter}
       ORDER BY last_attempt DESC LIMIT 10`
    );
    
    res.json({
      pending: pending?.count || 0,
      total: total?.count || 0,
      byEndpoint: byEndpoint || [],
      recentErrors: recentErrors || []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Retry specific sync item
router.post('/retry/:id', async (req, res) => {
  try {
    const item = await db.getAsync(`SELECT * FROM sync_queue WHERE id = ?`, [req.params.id]);
    
    if (!item) {
      return res.status(404).json({ error: 'Sync item not found' });
    }

    const payload = JSON.parse(item.payload);
    let response = null;
    const now = new Date().toISOString();

    if (item.endpoint === '/trnsSales/saveSales') {
      response = await vscuClient.sendSale(payload);
    } else if (item.endpoint === '/items/saveItems') {
      response = await vscuClient.saveItem(payload);
    } else if (item.endpoint === '/items/saveItemComposition') {
      response = await vscuClient.sendComposition(payload);
    } else if (item.endpoint === '/stock/saveStockItems') {
      response = await vscuClient.saveStock(payload);
    } else if (item.endpoint === '/purchases/savePurchases') {
      response = await vscuClient.savePurchase(payload);
    } else if (item.endpoint === '/branches/saveBrancheCustomers') {
      response = await vscuClient.saveBranchCustomer(payload);
    } else if (item.endpoint === '/branches/saveBrancheUsers') {
      response = await vscuClient.saveBranchUser(payload);
    }

    if (response && (response.resultCd === '000' || response.resultCd === '00')) {
      await db.runAsync(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
      res.json({ success: true, synced: true });
    } else {
      const errorMsg = response?.resultMsg || response?.message || 'Unknown error';
      await db.runAsync(
        `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = ? WHERE id = ?`,
        [errorMsg, now, item.id]
      );
      res.json({ success: false, synced: false, error: errorMsg });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear failed sync items (with retry_count > 5)
router.delete('/clear', async (req, res) => {
  try {
    const result = await db.runAsync(
      `DELETE FROM sync_queue WHERE status = 'pending' AND retry_count > 5`
    );
    res.json({ success: true, deleted: result.changes || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear all sync items (with confirmation)
router.delete('/clear-all', async (req, res) => {
  try {
    const result = await db.runAsync(`DELETE FROM sync_queue`);
    res.json({ success: true, deleted: result.changes || 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Auto-sync endpoint - called by frontend periodically
router.post('/auto-sync', async (req, res) => {
  try {
    // Check pending count first
    const pending = await getPendingCount();
    
    if (pending === 0) {
      return res.json({ 
        success: true, 
        message: 'No pending items to sync',
        pending: 0,
        synced: 0,
        failed: 0
      });
    }

    // Check if VSCU is online
    const isOnline = await vscuClient.checkStatus();
    
    if (!isOnline) {
      return res.json({ 
        success: false, 
        message: 'VSCU is offline. Items will sync later.',
        pending,
        synced: 0,
        failed: 0
      });
    }

    // Process sync queue
    const result = await processSyncQueue();
    
    const remaining = await getPendingCount();
    
    res.json({
      success: true,
      ...result,
      remaining,
      message: `Auto-sync completed: ${result.synced} synced, ${result.failed} failed. ${remaining} remaining.`
    });
  } catch (error) {
    console.error('Auto-sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;