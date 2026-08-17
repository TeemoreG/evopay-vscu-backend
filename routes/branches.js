const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// Get all branches (local)
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM branches ORDER BY bhf_id`
    );
    console.log(` Fetched ${rows.length} branches from database`);
    res.json(rows);
  } catch (error) {
    console.error('❌ Error fetching branches:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save branch (add or update) - local
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    console.log('📝 Saving branch:', data.bhf_id, '-', data.bhf_name);

    await db.runAsync(
      `INSERT OR REPLACE INTO branches 
       (bhf_id, bhf_name, address, phone, email, use_yn, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.bhf_id,
        data.bhf_name,
        data.address || null,
        data.phone || null,
        data.email || null,
        data.use_yn || 'Y',
        now
      ]
    );

    console.log(`✅ Branch ${data.bhf_id} saved successfully`);
    res.json({
      success: true,
      message: 'Branch saved successfully'
    });
  } catch (error) {
    console.error('❌ Error saving branch:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// VSCU PROXY ENDPOINTS
// ============================================

// Get branches List from VSCU
router.post('/selectBranches', async (req, res) => {
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    console.log('📤 Fetching branches from VSCU:', { tin, bhfId, lastReqDt });

    const response = await axios.post(
      `${vscuClient.baseUrl}/branches/selectBranches`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log(`Fetched branches from VSCU:`, response.data?.resultCd || 'success');
    res.json(response.data);
  } catch (error) {
    console.error('❌ Failed to fetch branches from VSCU:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save branch customer to VSCU
router.post('/saveBrancheCustomers', async (req, res) => {
  try {
    const payload = req.body;
    
    console.log('📤 Saving branch customer to VSCU:', payload.custNm || payload.custTin);

    const response = await axios.post(
      `${vscuClient.baseUrl}/branches/saveBrancheCustomers`,
      payload,
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log(`Branch customer saved:`, response.data?.resultCd || 'success');
    res.json(response.data);
  } catch (error) {
    console.error('❌ Failed to save branch customer:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save branch user to VSCU
router.post('/saveBrancheUsers', async (req, res) => {
  try {
    const payload = req.body;
    
    console.log('📤 Saving branch user to VSCU:', payload.userId || payload.userNm);

    const response = await axios.post(
      `${vscuClient.baseUrl}/branches/saveBrancheUsers`,
      payload,
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log(`Branch user saved:`, response.data?.resultCd || 'success');
    res.json(response.data);
  } catch (error) {
    console.error('❌ Failed to save branch user:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save branch insurance to VSCU
router.post('/saveBrancheInsurances', async (req, res) => {
  try {
    const payload = req.body;
    
    console.log('📤 Saving branch insurance to VSCU:', payload.isrccCd || payload.isrccNm);

    const response = await axios.post(
      `${vscuClient.baseUrl}/branches/saveBrancheInsurances`,
      payload,
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log(`Branch insurance saved:`, response.data?.resultCd || 'success');
    res.json(response.data);
  } catch (error) {
    console.error('❌ Failed to save branch insurance:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;