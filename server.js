// backend/server.js
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
dotenv.config();

const salesRoutes = require('./routes/sales');
const itemsRoutes = require('./routes/items');
const stockRoutes = require('./routes/stock');
const dataRoutes = require('./routes/data');
const syncRoutes = require('./routes/sync');
const purchasesRoutes = require('./routes/purchases');
const importsRoutes = require('./routes/imports');
const branchesRoutes = require('./routes/branches');
const settingsRoutes = require('./routes/settings');
const usersRoutes = require('./routes/users');
const noticesRoutes = require('./routes/notices');
const customersRoutes = require('./routes/customers');
const suppliersRoutes = require('./routes/suppliers');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/sales', salesRoutes);
app.use('/api/items', itemsRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/purchases', purchasesRoutes);
app.use('/api/imports', importsRoutes);
app.use('/api/branches', branchesRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/notices', noticesRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/suppliers', suppliersRoutes);

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// ============================================
// VSCU STATUS ENDPOINT
// ============================================
app.get('/api/vscu/status', async (req, res) => {
  try {
    const vscuClient = require('./services/vscuClient');
    const status = await vscuClient.checkStatus();
    res.json(status);
  } catch (error) {
    res.json({ online: false, error: error.message });
  }
});

// ============================================
// VSCU INITIALIZATION PROXY ENDPOINT
// ============================================
app.post('/api/initializer/selectInitInfo', async (req, res) => {
  try {
    const vscuUrl = process.env.VSCU_URL || 'http://192.168.60.29:8090';
    
    console.log('🔑 Initializing VSCU with:', {
      url: `${vscuUrl}/initializer/selectInitInfo`,
      body: req.body
    });

    const response = await axios.post(
      `${vscuUrl}/initializer/selectInitInfo`,
      req.body,
      { 
        headers: { 
          'Content-Type': 'application/json',
          'tin': req.body.tin || process.env.TIN,
          'bhfId': req.body.bhfId || process.env.BHF_ID
        },
        timeout: 10000 
      }
    );
    
    console.log('✅ Init response:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('❌ Init error:', error.message);
    
    let errorMessage = 'VSCU not reachable. Make sure it is running on port 8090.';
    let statusCode = 500;
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = '❌ VSCU not reachable. Make sure it is running on port 8090.';
    } else if (error.response) {
      errorMessage = error.response.data?.resultMsg || error.response.data?.message || 'VSCU returned an error';
      statusCode = error.response.status;
    } else if (error.request) {
      errorMessage = '❌ No response from VSCU. Make sure it is running.';
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      details: error.message,
      resultCd: error.response?.data?.resultCd || '999'
    });
  }
});

// ============================================
// AUTO-SYNC SCHEDULER
// ============================================
const db = require('./db');
const vscuClient = require('./services/vscuClient');

let isAutoSyncing = false;

async function processAutoSync() {
  if (isAutoSyncing) return;
  isAutoSyncing = true;

  try {
    const status = await vscuClient.checkStatus();
    if (!status.connected || !status.online) {
      isAutoSyncing = false;
      return;
    }

    const pending = await db.allAsync(
      `SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20`
    );

    if (pending.length === 0) {
      isAutoSyncing = false;
      return;
    }

    console.log(`🔄 Auto-sync: Processing ${pending.length} items...`);

    let synced = 0;
    let failed = 0;

    for (const item of pending) {
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
        } else {
          await db.runAsync(
            `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = CURRENT_TIMESTAMP WHERE id = ?`,
            ['Unknown endpoint: ' + item.endpoint, item.id]
          );
          failed++;
          continue;
        }

        if (response && (response.resultCd === '000' || response.resultCd === '00')) {
          await db.runAsync(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
          synced++;
        } else {
          const errorMsg = response?.resultMsg || response?.message || 'Unknown error';
          await db.runAsync(
            `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = CURRENT_TIMESTAMP WHERE id = ?`,
            [errorMsg, item.id]
          );
          failed++;
        }
      } catch (itemError) {
        console.error('Auto-sync item error:', itemError.message);
        await db.runAsync(
          `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = CURRENT_TIMESTAMP WHERE id = ?`,
          [itemError.message, item.id]
        );
        failed++;
      }
    }

    if (synced > 0 || failed > 0) {
      console.log(`✅ Auto-sync: ${synced} synced, ${failed} failed, ${pending.length - synced - failed} remaining`);
    }

  } catch (error) {
    console.error('Auto-sync error:', error.message);
  } finally {
    isAutoSyncing = false;
  }
}

function startAutoSync(intervalMs = 600000) {
  console.log(`🔄 Auto-sync scheduler started (every ${intervalMs / 1000} seconds)`);

  setTimeout(() => {
    processAutoSync();
  }, 10000);

  const interval = setInterval(processAutoSync, intervalMs);
  return interval;
}

// ============================================
// START SERVER
// ============================================
const server = app.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
  console.log(`📡 API ready at http://localhost:${PORT}/api`);
  
  const syncInterval = startAutoSync();
  global.__syncInterval = syncInterval;
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  if (global.__syncInterval) {
    clearInterval(global.__syncInterval);
  }
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  if (global.__syncInterval) {
    clearInterval(global.__syncInterval);
  }
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

module.exports = app;