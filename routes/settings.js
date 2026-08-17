const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all settings
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(`SELECT * FROM settings`);
    const settings = {};
    rows.forEach(row => {
      settings[row.key] = row.value;
    });
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update settings
router.post('/', async (req, res) => {
  try {
    const data = req.body;
    const now = new Date().toISOString();

    for (const [key, value] of Object.entries(data)) {
      await db.runAsync(
        `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
        [key, value, now]
      );
    }

    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;