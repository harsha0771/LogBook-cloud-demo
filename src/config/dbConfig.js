const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'db.sqlite');

let db;

// Initialize and create table if not exists
function initDB() {
    // Ensure file exists (better-sqlite3 will create automatically if not found)
    db = new Database(DB_PATH);

    // Create table if not exists
    db.prepare(`
        CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    `).run();

    console.log('[SQLite] Database initialized at', DB_PATH);
}

// API methods
const kv = {};

kv.get = (key) => {
    try {
        const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
        return row ? row.value : null;
    } catch {
        return null;
    }
};

kv.getMany = (keys) => {
    try {
        if (!keys.length) return [];
        const placeholders = keys.map(() => '?').join(',');
        const rows = db.prepare(`SELECT key, value FROM kv_store WHERE key IN (${placeholders})`).all(keys);
        return rows;
    } catch {
        return [];
    }
};

kv.createValueStream = () => {
    const { Readable } = require('stream');
    const rows = db.prepare('SELECT value FROM kv_store').all();
    const stream = new Readable({ objectMode: true, read() { } });
    rows.forEach(row => stream.push(row.value));
    stream.push(null);
    return stream;
};

kv.createReadStream = () => {
    try {
        return db.prepare('SELECT * FROM kv_store').all();
    } catch {
        return [];
    }
};

kv.createKeyStream = () => {
    const { Readable } = require('stream');
    const rows = db.prepare('SELECT key FROM kv_store').all();
    const stream = new Readable({ objectMode: true, read() { } });
    rows.forEach(row => stream.push(row.key));
    stream.push(null);
    return stream;
};

kv.del = (key) => {
    try {
        db.prepare('DELETE FROM kv_store WHERE key = ?').run(key);
    } catch {
        // ignore
    }
};

kv.put = (key, value) => {
    try {
        db.prepare(`
            INSERT INTO kv_store (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value);
    } catch {
        // ignore
    }
};

kv.close = () => {
    try {
        db.close();
        console.log('[SQLite] Connection closed');
    } catch (err) {
        console.error('[SQLite] Error closing DB', err.message);
    }
};

initDB();
module.exports = kv;