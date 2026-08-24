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

// Helper: Check if item already exists in queue
async function isItemInQueue(endpoint, identifier, value) {
  let sql = '';
  let params = [];

  if (endpoint === '/items/saveItems') {
    sql = `SELECT COUNT(*) as count FROM sync_queue WHERE endpoint = ? AND json_extract(payload, '$.itemCd') = ? AND status = 'pending'`;
    params = [endpoint, value];
  } else if (endpoint === '/trnsSales/saveSales') {
    sql = `SELECT COUNT(*) as count FROM sync_queue WHERE endpoint = ? AND json_extract(payload, '$.invcNo') = ? AND status = 'pending'`;
    params = [endpoint, parseInt(value)];
  } else if (endpoint === '/purchases/savePurchases') {
    sql = `SELECT COUNT(*) as count FROM sync_queue WHERE endpoint = ? AND json_extract(payload, '$.invcNo') = ? AND status = 'pending'`;
    params = [endpoint, parseInt(value)];
  } else if (endpoint === '/stock/saveStockItems') {
    sql = `SELECT COUNT(*) as count FROM sync_queue WHERE endpoint = ? AND json_extract(payload, '$.sarNo') = ? AND status = 'pending'`;
    params = [endpoint, parseInt(value)];
  } else {
    return false;
  }

  const result = await db.getAsync(sql, params);
  return result?.count > 0;
}

// Helper: Process sync queue
async function processSyncQueue() {
  const queue = await db.allAsync(
    `SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY retry_count ASC, created_at ASC LIMIT 50`
  );

  if (queue.length === 0) {
    return { synced: 0, failed: 0 };
  }

  let synced = 0;
  let failed = 0;
  const errors = [];

  for (const item of queue) {
    const now = new Date().toISOString();
    try {
      const payload = JSON.parse(item.payload);
      let response = null;
      let success = false;

      // Route to appropriate VSCU endpoint
      switch (item.endpoint) {
        case '/trnsSales/saveSales':
          response = await vscuClient.sendSale(payload);
          success = response && (response.resultCd === '000' || response.resultCd === '00');
          break;
        case '/items/saveItems':
          response = await vscuClient.saveItem(payload);
          success = response && (response.resultCd === '000' || response.resultCd === '00');
          break;
        case '/items/saveItemComposition':
          response = await vscuClient.sendComposition(payload);
          success = response && (response.resultCd === '000' || response.resultCd === '00');
          break;
        case '/stock/saveStockItems':
          response = await vscuClient.saveStock(payload);
          success = response && (response.resultCd === '000' || response.resultCd === '00');
          break;
        case '/purchases/savePurchases':
          response = await vscuClient.savePurchase(payload);
          success = response && (response.resultCd === '000' || response.resultCd === '00');
          break;
        case '/branches/saveBrancheCustomers':
          response = await vscuClient.saveBranchCustomer(payload);
          success = response && (response.resultCd === '000' || response.resultCd === '00');
          break;
        case '/branches/saveBrancheUsers':
          response = await vscuClient.saveBranchUser(payload);
          success = response && (response.resultCd === '000' || response.resultCd === '00');
          break;
        default:
          await db.runAsync(
            `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = ? WHERE id = ?`,
            ['Unknown endpoint: ' + item.endpoint, now, item.id]
          );
          failed++;
          errors.push({ id: item.id, endpoint: item.endpoint, error: 'Unknown endpoint' });
          continue;
      }

      if (success) {
        await db.runAsync(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
        synced++;
        console.log(`✅ Synced item ${item.id} (${item.endpoint})`);
      } else {
        const errorMsg = response?.resultMsg || response?.message || 'VSCU error';
        await db.runAsync(
          `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = ? WHERE id = ?`,
          [errorMsg, now, item.id]
        );
        failed++;
        errors.push({ id: item.id, endpoint: item.endpoint, error: errorMsg });
        console.log(`❌ Failed to sync item ${item.id}: ${errorMsg}`);
      }
    } catch (itemError) {
      console.error('Error processing sync item:', itemError.message);
      await db.runAsync(
        `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = ? WHERE id = ?`,
        [itemError.message, now, item.id]
      );
      failed++;
      errors.push({ id: item.id, error: itemError.message });
    }
  }

  return { synced, failed, errors };
}

// Process sync queue - send pending items to VSCU
router.post('/process', async (req, res) => {
  try {
    // Check if VSCU is online first
    const isOnline = await vscuClient.checkStatus();
    
    if (!isOnline || !isOnline.connected) {
      return res.json({
        success: false,
        message: 'VSCU is offline. Items will sync later.',
        pending: await getPendingCount(),
        synced: 0,
        failed: 0
      });
    }

    const queue = await db.allAsync(
      `SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY retry_count ASC, created_at ASC LIMIT 50`
    );

    if (queue.length === 0) {
      return res.json({ success: true, synced: 0, failed: 0, message: 'No items to sync' });
    }

    const result = await processSyncQueue();
    const remaining = await getPendingCount();

    res.json({
      success: true,
      ...result,
      remaining,
      message: `Synced ${result.synced} items, ${result.failed} failed. ${remaining} remaining.`
    });
  } catch (error) {
    console.error('Sync process error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get sync queue status - with page filter
router.get('/status', async (req, res) => {
  try {
    const { page } = req.query;
    
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
    
    const byEndpoint = await db.allAsync(
      `SELECT endpoint, COUNT(*) as count FROM sync_queue WHERE status = 'pending' ${endpointFilter} GROUP BY endpoint`
    );
    
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
    console.error('Sync status error:', error);
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
    let success = false;

    switch (item.endpoint) {
      case '/trnsSales/saveSales':
        response = await vscuClient.sendSale(payload);
        success = response && (response.resultCd === '000' || response.resultCd === '00');
        break;
      case '/items/saveItems':
        response = await vscuClient.saveItem(payload);
        success = response && (response.resultCd === '000' || response.resultCd === '00');
        break;
      case '/items/saveItemComposition':
        response = await vscuClient.sendComposition(payload);
        success = response && (response.resultCd === '000' || response.resultCd === '00');
        break;
      case '/stock/saveStockItems':
        response = await vscuClient.saveStock(payload);
        success = response && (response.resultCd === '000' || response.resultCd === '00');
        break;
      case '/purchases/savePurchases':
        response = await vscuClient.savePurchase(payload);
        success = response && (response.resultCd === '000' || response.resultCd === '00');
        break;
      case '/branches/saveBrancheCustomers':
        response = await vscuClient.saveBranchCustomer(payload);
        success = response && (response.resultCd === '000' || response.resultCd === '00');
        break;
      case '/branches/saveBrancheUsers':
        response = await vscuClient.saveBranchUser(payload);
        success = response && (response.resultCd === '000' || response.resultCd === '00');
        break;
      default:
        return res.status(400).json({ error: 'Unknown endpoint: ' + item.endpoint });
    }

    if (success) {
      await db.runAsync(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
      res.json({ success: true, synced: true });
    } else {
      const errorMsg = response?.resultMsg || response?.message || 'VSCU error';
      await db.runAsync(
        `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = ? WHERE id = ?`,
        [errorMsg, now, item.id]
      );
      res.json({ success: false, synced: false, error: errorMsg });
    }
  } catch (error) {
    console.error('Retry error:', error);
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
    console.error('Clear failed error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clear all sync items (with confirmation)
router.delete('/clear-all', async (req, res) => {
  try {
    const result = await db.runAsync(`DELETE FROM sync_queue`);
    res.json({ success: true, deleted: result.changes || 0 });
  } catch (error) {
    console.error('Clear all error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Auto-sync endpoint - called by frontend periodically
router.post('/auto-sync', async (req, res) => {
  try {
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

    const isOnline = await vscuClient.checkStatus();
    
    if (!isOnline || !isOnline.connected) {
      return res.json({ 
        success: false, 
        message: 'VSCU is offline. Items will sync later.',
        pending,
        synced: 0,
        failed: 0
      });
    }

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