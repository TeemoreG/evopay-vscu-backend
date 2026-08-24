// backend/db.js
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const path = require('path');

let db;
const isProduction = process.env.NODE_ENV === 'production';

// Promisify SQLite
const promisifyDb = (db) => {
  db.runAsync = (sql, params) => new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
  });
  db.getAsync = (sql, params) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
  db.allAsync = (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
  return db;
};

async function connectDB() {
  if (isProduction) {
    console.log('🔵 Using Supabase PostgreSQL');
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
    await db.connect();
    console.log('✅ Supabase connected');
  } else {
    console.log('🟢 Using local SQLite');
    db = new sqlite3.Database(path.join(__dirname, 'db', 'evopay.db'));
    promisifyDb(db);
    console.log('✅ SQLite connected');
  }
  return db;
}

function getDb() { return db; }

// Universal query - works for both SQLite and PostgreSQL
async function query(sql, params = []) {
  if (isProduction) {
    const result = await db.query(sql, params);
    return result.rows;
  }
  return db.allAsync(sql, params);
}

async function queryOne(sql, params = []) {
  if (isProduction) {
    const result = await db.query(sql, params);
    return result.rows[0];
  }
  return db.getAsync(sql, params);
}

async function run(sql, params = []) {
  if (isProduction) {
    return db.query(sql, params);
  }
  return db.runAsync(sql, params);
}

module.exports = { connectDB, getDb, query, queryOne, run };