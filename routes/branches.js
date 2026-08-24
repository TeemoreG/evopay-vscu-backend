const express = require('express');
const router = express.Router();
const db = require('../db');
const axios = require('axios');
const vscuClient = require('../services/vscuClient');

// ============================================
// LOCAL CRUD
// ============================================

// Get all branches (local)
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT * FROM branches ORDER BY bhf_id`
    );
    console.log(`Fetched ${rows.length} branches from database`);
    res.json(rows);
  } catch (error) {
    console.error('Error fetching branches:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Save branch (add or update) - local
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    console.log('Saving branch:', data.bhf_id, '-', data.bhf_name);

    await db.runAsync(
      `INSERT OR REPLACE INTO branches (
        bhf_id, bhf_name, bhf_stts_cd, prvnc_nm, dstrt_nm, sctr_nm,
        loc_desc, mgr_nm, mgr_tel_no, mgr_email, hq_yn,
        address, phone, email, use_yn, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.bhf_id,
        data.bhf_name,
        data.bhf_stts_cd || '01',
        data.prvnc_nm || null,
        data.dstrt_nm || null,
        data.sctr_nm || null,
        data.loc_desc || null,
        data.mgr_nm || null,
        data.mgr_tel_no || null,
        data.mgr_email || null,
        data.hq_yn || 'N',
        data.address || null,
        data.phone || null,
        data.email || null,
        data.use_yn || 'Y',
        now
      ]
    );

    console.log(`Branch ${data.bhf_id} saved successfully`);
    res.json({
      success: true,
      message: 'Branch saved successfully'
    });
  } catch (error) {
    console.error('Error saving branch:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// BULK SAVE BRANCHES (from VSCU)
router.post('/bulk', async (req, res) => {
  try {
    const branchList = req.body;
    
    if (!Array.isArray(branchList) || branchList.length === 0) {
      return res.status(400).json({ error: 'Branches array is required' });
    }

    const now = new Date().toISOString();
    let saved = 0;

    for (const branch of branchList) {
      await db.runAsync(
        `INSERT OR REPLACE INTO branches (
          bhf_id, bhf_name, bhf_stts_cd, prvnc_nm, dstrt_nm, sctr_nm,
          loc_desc, mgr_nm, mgr_tel_no, mgr_email, hq_yn,
          address, phone, email, use_yn, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          branch.bhfId || branch.bhf_id,
          branch.bhfNm || branch.bhf_name || 'Unknown',
          branch.bhfSttsCd || branch.bhf_stts_cd || '01',
          branch.prvncNm || branch.prvnc_nm || null,
          branch.dstrtNm || branch.dstrt_nm || null,
          branch.sctrNm || branch.sctr_nm || null,
          branch.locDesc || branch.loc_desc || null,
          branch.mgrNm || branch.mgr_nm || null,
          branch.mgrTelNo || branch.mgr_tel_no || null,
          branch.mgrEmail || branch.mgr_email || null,
          branch.hqYn || branch.hq_yn || 'N',
          branch.adrs || branch.addr || branch.address || null,
          branch.telNo || branch.phone || null,
          branch.email || null,
          branch.useYn || branch.use_yn || 'Y',
          now
        ]
      );
      saved++;
    }

    console.log(`Bulk saved ${saved} branches from VSCU`);
    res.json({ success: true, saved });
  } catch (error) {
    console.error('Bulk save branches error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// VSCU PROXY ENDPOINTS
// ============================================

// Get branches List from VSCU
router.post('/selectBranches', async (req, res) => {
  console.log('Fetching branches from VSCU:', req.body);
  try {
    const { tin, bhfId, lastReqDt } = req.body;
    
    const response = await axios.post(
      `${vscuClient.baseUrl}/branches/selectBranches`,
      { tin, bhfId, lastReqDt },
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('VSCU Response Code:', response.data?.resultCd);
    console.log('VSCU Response Msg:', response.data?.resultMsg);
    console.log('Branch list length:', response.data?.data?.bhfList?.length || 0);
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to fetch branches from VSCU:', error.message);
    if (error.response) {
      console.error('VSCU Error Status:', error.response.status);
      console.error('VSCU Error Data:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({ error: error.message });
  }
});

// Save branch customer to VSCU
router.post('/saveBrancheCustomers', async (req, res) => {
  console.log('Saving branch customer to VSCU:', req.body?.custNm || req.body?.custTin);
  try {
    const payload = req.body;

    // Ensure required fields
    if (!payload.custTin && !payload.custNm) {
      return res.status(400).json({ error: 'custTin and custNm are required' });
    }

    const response = await axios.post(
      `${vscuClient.baseUrl}/branches/saveBrancheCustomers`,
      payload,
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('VSCU Response Code:', response.data?.resultCd);
    console.log('VSCU Response Msg:', response.data?.resultMsg);
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to save branch customer:', error.message);
    if (error.response) {
      console.error('VSCU Error Status:', error.response.status);
      console.error('VSCU Error Data:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({ error: error.message });
  }
});

// Save branch user to VSCU
router.post('/saveBrancheUsers', async (req, res) => {
  console.log('Saving branch user to VSCU:', req.body?.userId || req.body?.userNm);
  try {
    const payload = req.body;

    // Ensure required fields
    if (!payload.userId && !payload.userNm) {
      return res.status(400).json({ error: 'userId and userNm are required' });
    }

    const response = await axios.post(
      `${vscuClient.baseUrl}/branches/saveBrancheUsers`,
      payload,
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('VSCU Response Code:', response.data?.resultCd);
    console.log('VSCU Response Msg:', response.data?.resultMsg);
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to save branch user:', error.message);
    if (error.response) {
      console.error('VSCU Error Status:', error.response.status);
      console.error('VSCU Error Data:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({ error: error.message });
  }
});

// Save branch insurance to VSCU
router.post('/saveBrancheInsurances', async (req, res) => {
  console.log('Saving branch insurance to VSCU:', req.body?.isrccCd || req.body?.isrccNm);
  try {
    const payload = req.body;

    // Ensure required fields
    if (!payload.isrccCd && !payload.isrccNm) {
      return res.status(400).json({ error: 'isrccCd and isrccNm are required' });
    }

    const response = await axios.post(
      `${vscuClient.baseUrl}/branches/saveBrancheInsurances`,
      payload,
      { headers: vscuClient.getHeaders(true) }
    );
    
    console.log('VSCU Response Code:', response.data?.resultCd);
    console.log('VSCU Response Msg:', response.data?.resultMsg);
    
    res.json(response.data);
  } catch (error) {
    console.error('Failed to save branch insurance:', error.message);
    if (error.response) {
      console.error('VSCU Error Status:', error.response.status);
      console.error('VSCU Error Data:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;