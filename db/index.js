// backend/db/index.js
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

let db;

const connectDB = async () => {
  try {
    console.log('📂 Connecting to local SQLite database...');
    db = await open({
      filename: './db/evopay.db',
      driver: sqlite3.Database
    });
    console.log('✅ Local database connected successfully');
    return db;
  } catch (error) {
    console.error('❌ Database connection error:', error.message);
    throw error;
  }
};

const getDB = () => {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB() first.');
  }
  return db;
};

const allAsync = async (sql, params = []) => {
  const db = getDB();
  return db.all(sql, params);
};

const getAsync = async (sql, params = []) => {
  const db = getDB();
  return db.get(sql, params);
};

const runAsync = async (sql, params = []) => {
  const db = getDB();
  return db.run(sql, params);
};

module.exports = {
  connectDB,
  getDB,
  allAsync,
  getAsync,
  runAsync
};