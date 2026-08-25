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

// CORS - Allow both local and production
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3000',
  'https://teemoreg.github.io',
  'https://evopay-vscu-backend.onrender.com',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
    environment: process.env.NODE_ENV || 'development',
    database: process.env.NODE_ENV === 'production' ? 'Supabase' : 'SQLite'
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
    const vscuUrl = process.env.VSCU_URL || 'http://192.168.112.239:8090';
    
    console.log('Initializing VSCU with:', {
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
        timeout: 30000
      }
    );
    
    console.log('Init response:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('Init error:', error.message);
    
    let errorMessage = 'VSCU not reachable. Make sure it is running on port 8090.';
    let statusCode = 500;
    
    if (error.code === 'ECONNREFUSED') {
      errorMessage = 'VSCU not reachable. Make sure it is running on port 8090.';
    } else if (error.code === 'ECONNRESET' || error.message === 'socket hang up') {
      errorMessage = 'VSCU crashed or closed the connection. Check the VSCU terminal for errors.';
    } else if (error.response) {
      errorMessage = error.response.data?.resultMsg || error.response.data?.message || 'VSCU returned an error';
      statusCode = error.response.status;
    } else if (error.request) {
      errorMessage = 'No response from VSCU. Make sure it is running.';
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      details: error.message,
      resultCd: error.response?.data?.resultCd || '999'
    });
  }
});

// ============================================
// SYNC PROCESSING
// ============================================
const { connectDB, query, run } = require('./db');
const vscuClient = require('./services/vscuClient');

let isAutoSyncing = false;
let db;

async function processManualSync() {
  if (isAutoSyncing) return;
  isAutoSyncing = true;

  try {
    const status = await vscuClient.checkStatus();
    if (!status.connected || !status.online) {
      isAutoSyncing = false;
      return { synced: 0, failed: 0, message: 'VSCU offline' };
    }

    // Use query() instead of db.allAsync
    const pending = await query(
      `SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`
    );

    if (pending.length === 0) {
      isAutoSyncing = false;
      return { synced: 0, failed: 0, message: 'No pending items' };
    }

    console.log(`Manual sync: Processing ${pending.length} payloads...`);

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
          await run(
            `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = CURRENT_TIMESTAMP WHERE id = ?`,
            ['Unknown endpoint: ' + item.endpoint, item.id]
          );
          failed++;
          continue;
        }

        if (response && (response.resultCd === '000' || response.resultCd === '00')) {
          await run(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
          synced++;
          console.log(`Synced item ${item.id} (${item.endpoint})`);
        } else {
          const errorMsg = response?.resultMsg || response?.message || 'Unknown error';
          await run(
            `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = CURRENT_TIMESTAMP WHERE id = ?`,
            [errorMsg, item.id]
          );
          failed++;
        }
      } catch (itemError) {
        console.error('Manual sync item error:', itemError.message);
        await run(
          `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = CURRENT_TIMESTAMP WHERE id = ?`,
          [itemError.message, item.id]
        );
        failed++;
      }
    }

    console.log(`Manual sync: ${synced} synced, ${failed} failed`);
    return { synced, failed, message: `Synced ${synced}, failed ${failed}` };

  } catch (error) {
    console.error('Manual sync error:', error.message);
    return { synced: 0, failed: 0, message: error.message };
  } finally {
    isAutoSyncing = false;
  }
}

app._manualSync = processManualSync;

// ============================================
// START SERVER WITH DATABASE CONNECTION
// ============================================
connectDB().then((dbInstance) => {
  db = dbInstance;
  const server = app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
    console.log(`API ready at http://localhost:${PORT}/api`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Database: ${process.env.NODE_ENV === 'production' ? 'Supabase' : 'SQLite'}`);
  });

  process.on('SIGTERM', () => {
    console.log('Shutting down...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('Shutting down...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  });

}).catch(err => {
  console.error('Failed to connect to database:', err.message);
  process.exit(1);
});

module.exports = app;
