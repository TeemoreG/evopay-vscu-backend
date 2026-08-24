// backend/db/index.js
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

let db;
let isConnected = false;

const DB_PATH = path.join(__dirname, 'evopay.db');

const connectDB = async () => {
  try {
    console.log('Connecting to local SQLite database...');
    
    // Ensure the db directory exists
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database
    });

    // Enable foreign keys
    await db.run('PRAGMA foreign_keys = ON');
    
    isConnected = true;
    console.log('Local database connected successfully');
    return db;
  } catch (error) {
    console.error('Database connection error:', error.message);
    throw error;
  }
};

const getDB = () => {
  if (!db || !isConnected) {
    throw new Error('Database not initialized. Call connectDB() first.');
  }
  return db;
};

const allAsync = async (sql, params = []) => {
  const db = getDB();
  try {
    return await db.all(sql, params);
  } catch (error) {
    console.error('SQL allAsync error:', error.message);
    throw error;
  }
};

const getAsync = async (sql, params = []) => {
  const db = getDB();
  try {
    return await db.get(sql, params);
  } catch (error) {
    console.error('SQL getAsync error:', error.message);
    throw error;
  }
};

const runAsync = async (sql, params = []) => {
  const db = getDB();
  try {
    const result = await db.run(sql, params);
    return result;
  } catch (error) {
    console.error('SQL runAsync error:', error.message);
    throw error;
  }
};

const checkDatabase = async () => {
  try {
    if (fs.existsSync(DB_PATH)) {
      const stats = fs.statSync(DB_PATH);
      console.log(`Database file found at: ${DB_PATH} (${(stats.size / 1024).toFixed(2)} KB)`);
      return true;
    } else {
      console.log('Database file not found. Will create on first connection.');
      return false;
    }
  } catch (error) {
    console.log('Database check skipped:', error.message);
    return false;
  }
};

const closeDB = async () => {
  if (db && isConnected) {
    try {
      await db.close();
      isConnected = false;
      console.log('Database connection closed.');
    } catch (error) {
      console.error('Error closing database:', error.message);
    }
  }
};

module.exports = {
  connectDB,
  getDB,
  allAsync,
  getAsync,
  runAsync,
  checkDatabase,
  closeDB
};