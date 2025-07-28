const { Readable } = require('stream');
const { Pool } = require('pg');

// Use Supabase connection string
const connectionString = 'postgresql://postgres.rpovxetsvbtkvppdekmj:8bJIrgzHOyCjOceI@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';

let pool;

async function initAppDB() {
    pool = new Pool({
        connectionString,
        ssl: { rejectUnauthorized: false } // Required by Supabase
    });

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS kv_store (
                key TEXT PRIMARY KEY,
                value TEXT
            );
        `);
        console.log('[PostgreSQL] kv_store table ready ✅');
    } catch (err) {
        console.error('[PostgreSQL] Table init error ❌', err.message);
        throw err;
    }
}

const db = {};

db.get = async (key) => {
    try {
        const res = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
        return res.rows[0]?.value ?? null;
    } catch {
        return null;
    }
};

db.getMany = async (keys) => {
    try {
        if (!keys.length) return [];
        const placeholders = keys.map((_, i) => `$${i + 1}`).join(',');
        const res = await pool.query(`SELECT key, value FROM kv_store WHERE key IN (${placeholders})`, keys);
        return res.rows;
    } catch {
        return [];
    }
};

db.createValueStream = async () => {
    try {
        const res = await pool.query('SELECT value FROM kv_store');
        const stream = new Readable({ objectMode: true, read() { } });
        res.rows.forEach(row => stream.push(row.value));
        stream.push(null);
        return stream;
    } catch {
        const stream = new Readable({ objectMode: true, read() { } });
        stream.push(null);
        return stream;
    }
};

db.createReadStream = async () => {
    try {
        const res = await pool.query('SELECT * FROM kv_store');
        return res.rows;
    } catch {
        return [];
    }
};

db.createKeyStream = async () => {
    try {
        const res = await pool.query('SELECT key FROM kv_store');
        const stream = new Readable({ objectMode: true, read() { } });
        res.rows.forEach(row => stream.push(row.key));
        stream.push(null);
        return stream;
    } catch {
        const stream = new Readable({ objectMode: true, read() { } });
        stream.push(null);
        return stream;
    }
};

db.del = async (key) => {
    try {
        await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
    } catch { }
};

db.put = async (key, value) => {
    try {
        await pool.query(`
            INSERT INTO kv_store (key, value)
            VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
        `, [key, value]);
    } catch { }
};

db.close = async () => {
    try {
        await pool.end();
    } catch (err) {
        console.error('[PostgreSQL] Close error ❌', err.message);
    }
};

(async () => {
    await initAppDB();
})();

module.exports = db;
