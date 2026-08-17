const express = require('express');
const router = express.Router();
const db = require('../db');

// Get all users
router.get('/', async (req, res) => {
  try {
    const rows = await db.allAsync(
      `SELECT user_id, user_name, full_name, role, use_yn, synced, created_at 
       FROM users ORDER BY user_id`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create or update user
router.post('/', async (req, res) => {
  try {
    const { user_id, user_name, full_name, password, role, use_yn } = req.body;
    const now = new Date().toISOString();

    if (!user_id || !user_name) {
      return res.status(400).json({ error: 'User ID and Username are required' });
    }

    const existing = await db.getAsync(
      `SELECT user_id FROM users WHERE user_id = ?`,
      [user_id]
    );

    let query, params;
    if (existing) {
      if (password) {
        query = `UPDATE users SET user_name = ?, full_name = ?, password = ?, role = ?, use_yn = ?, updated_at = ? WHERE user_id = ?`;
        params = [user_name, full_name || null, password, role || 'cashier', use_yn || 'Y', now, user_id];
      } else {
        query = `UPDATE users SET user_name = ?, full_name = ?, role = ?, use_yn = ?, updated_at = ? WHERE user_id = ?`;
        params = [user_name, full_name || null, role || 'cashier', use_yn || 'Y', now, user_id];
      }
    } else {
      if (!password) {
        return res.status(400).json({ error: 'Password is required for new users' });
      }
      query = `INSERT INTO users (user_id, user_name, full_name, password, role, use_yn, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
      params = [user_id, user_name, full_name || null, password, role || 'cashier', use_yn || 'Y', now];
    }

    await db.runAsync(query, params);
    res.json({ success: true, message: 'User saved successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete user
router.delete('/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    
    const managers = await db.allAsync(
      `SELECT user_id FROM users WHERE role = 'manager' AND use_yn = 'Y'`
    );
    
    if (managers.length === 1 && managers[0].user_id === userId) {
      return res.status(400).json({ error: 'Cannot delete the last active manager' });
    }

    await db.runAsync(
      `DELETE FROM users WHERE user_id = ?`,
      [userId]
    );
    
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login - authenticate user
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = await db.getAsync(
      `SELECT user_id, user_name, full_name, role, use_yn FROM users 
       WHERE user_name = ? AND password = ? AND use_yn = 'Y'`,
      [username, password]
    );
    
    if (user) {
      res.json({
        success: true,
        user: {
          user_id: user.user_id,
          user_name: user.user_name,
          full_name: user.full_name || user.user_name,
          role: user.role || 'cashier'
        }
      });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;