const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');
dotenv.config();

// ============================================
// LOGGER HELPERS
// ============================================
const colors = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

const log = {
  info: (msg) => console.log(`${colors.cyan}[INFO]${colors.reset} ${msg}`),
  ok: (msg) => console.log(`${colors.green}[ OK ]${colors.reset} ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  err: (msg) => console.log(`${colors.red}[FAIL]${colors.reset} ${msg}`),
  req: (method, path, extra = '') =>
    console.log(`${colors.magenta}[REQ ]${colors.reset} ${method.padEnd(6)} ${path} ${colors.gray}${extra}${colors.reset}`),
  res: (status, method, path, ms, extra = '') => {
    const color = status >= 500 ? colors.red : status >= 400 ? colors.yellow : colors.green;
    console.log(`${color}[RES ]${colors.reset} ${String(status).padEnd(4)} ${method.padEnd(6)} ${path} ${colors.gray}(${ms}ms)${colors.reset} ${extra}`);
  },
  vscu: (msg) => console.log(`${colors.blue}[VSCU]${colors.reset} ${msg}`),
  db: (msg) => console.log(`${colors.green}[ DB ]${colors.reset} ${msg}`),
  line: () => console.log(`${colors.gray}${'─'.repeat(70)}${colors.reset}`),
};

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
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'http://192.168.112.120:5173',
    'http://192.168.60.29:3000'
  ],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ============================================
// REQUEST LOGGER MIDDLEWARE
// ============================================
const QUIET_PATHS = ['/api/health', '/api/vscu/status'];
const isQuiet = (p) => QUIET_PATHS.some((q) => p === q || p.startsWith(q));

app.use((req, res, next) => {
  const start = Date.now();
  const quiet = isQuiet(req.path);

  if (!quiet) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '-';
    log.req(req.method, req.originalUrl, `from ${ip}`);

    if (req.method !== 'GET' && req.body && Object.keys(req.body).length) {
      const body = JSON.stringify(req.body);
      const preview = body.length > 200 ? body.slice(0, 200) + '...' : body;
      console.log(`${colors.gray}       ${preview}${colors.reset}`);
    }
  }

  const origJson = res.json.bind(res);
  res.json = (payload) => {
    if (!quiet) {
      const ms = Date.now() - start;
      let summary = '';
      if (payload && typeof payload === 'object') {
        if (Array.isArray(payload)) {
          summary = `${payload.length} item(s)`;
        } else if (payload.error) {
          summary = `${colors.red}${payload.error}${colors.reset}`;
        } else if (payload.resultCd) {
          summary = `resultCd=${payload.resultCd}`;
        } else if (payload.synced !== undefined) {
          summary = `synced=${payload.synced} failed=${payload.failed || 0}`;
        } else {
          const str = JSON.stringify(payload);
          summary = str.length > 120 ? str.slice(0, 120) + '...' : str;
        }
      }
      log.res(res.statusCode, req.method, req.originalUrl, ms, summary);
    }
    return origJson(payload);
  };

  next();
});

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
    const vscuUrl = process.env.VSCU_URL || 'http://192.168.112.239:8090';

    log.vscu(`Initializing device → ${vscuUrl}/initializer/selectInitInfo`);

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

    log.vscu(`Init OK → resultCd=${response.data?.resultCd}`);
    res.json(response.data);
  } catch (error) {
    log.err(`Init error: ${error.message}`);

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
const db = require('./db');
const vscuClient = require('./services/vscuClient');

let isAutoSyncing = false;

async function processManualSync() {
  if (isAutoSyncing) return;
  isAutoSyncing = true;

  try {
    const status = await vscuClient.checkStatus();
    if (!status.connected || !status.online) {
      isAutoSyncing = false;
      return { synced: 0, failed: 0, message: 'VSCU offline' };
    }

    const pending = await db.allAsync(
      `SELECT * FROM sync_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT 50`
    );

    if (pending.length === 0) {
      isAutoSyncing = false;
      return { synced: 0, failed: 0, message: 'No pending items' };
    }

    log.info(`Manual sync: ${pending.length} payload(s) queued`);
    log.line();

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
          log.err(`Unknown endpoint: ${item.endpoint}`);
          failed++;
          continue;
        }

        if (response && (response.resultCd === '000' || response.resultCd === '00')) {
          await db.runAsync(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
          log.ok(`${item.endpoint} → ${payload.itemCd || payload.invcNo || item.id}`);
          synced++;
        } else {
          const errorMsg = response?.resultMsg || response?.message || 'Unknown error';
          await db.runAsync(
            `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = CURRENT_TIMESTAMP WHERE id = ?`,
            [errorMsg, item.id]
          );
          log.err(`${item.endpoint} → ${errorMsg}`);
          failed++;
        }
      } catch (itemError) {
        log.err(`Sync item error: ${itemError.message}`);
        await db.runAsync(
          `UPDATE sync_queue SET retry_count = retry_count + 1, error = ?, last_attempt = CURRENT_TIMESTAMP WHERE id = ?`,
          [itemError.message, item.id]
        );
        failed++;
      }
    }

    log.line();
    log.info(`Manual sync done: ${synced} synced, ${failed} failed`);

    return { synced, failed, message: `Synced ${synced}, failed ${failed}` };

  } catch (error) {
    log.err(`Manual sync error: ${error.message}`);
    return { synced: 0, failed: 0, message: error.message };
  } finally {
    isAutoSyncing = false;
  }
}

app._manualSync = processManualSync;

// ============================================
// GLOBAL ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  log.err(`Unhandled: ${err.message}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

process.on('uncaughtException', (err) => {
  log.err(`Uncaught exception: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log.err(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

// ============================================
// START SERVER
// ============================================
const { connectDB } = require('./db');

log.line();
log.info(`${colors.bold}Evopay VSCU Backend${colors.reset}`);
log.info(`Node ${process.version} · Port ${PORT}`);
log.info(`VSCU target: ${process.env.VSCU_URL || 'not set'}`);
log.line();

connectDB().then(async () => {
  log.db('Connected');

  try {
    const { initTablesOnce } = require('./routes/data');
    await initTablesOnce();
    log.db('Tables ready');
  } catch (e) {
    log.err(`Init tables failed: ${e.message}`);
  }

  const server = app.listen(PORT, () => {
    log.line();
    log.ok(`${colors.bold}API ready → http://localhost:${PORT}/api${colors.reset}`);
    log.line();
  });

  process.on('SIGTERM', () => {
    log.warn('SIGTERM — shutting down');
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    log.warn('SIGINT — shutting down');
    server.close(() => process.exit(0));
  });

}).catch(err => {
  log.err(`DB connect failed: ${err.message}`);
  process.exit(1);
});

module.exports = app;