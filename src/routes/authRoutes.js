const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const db = require("../config/dbConfig");
const { generateId, getData, addData, deleteData } = require("../utils/dbUtils");
const { OAuth2Client } = require("google-auth-library");
const client = new OAuth2Client("1012711247018-rat4mho4oav87obdrpmi0gcj32vb7d32.apps.googleusercontent.com");
const rateLimit = require("express-rate-limit");
const CryptoJS = require("crypto-js");
const { randomUUID } = require("crypto");

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });

const PASSWORD_SALT = 'ems&sort_by=sold&limit=20';
const JWT_SECRET = process.env.JWT_SECRET || "SUPER_SECRET_KEY";

// ---------------- Cookie Management ----------------

async function create_cookie(payload) {
    const id = randomUUID() + Date.now().toString();
    const encryptedId = CryptoJS.AES.encrypt(payload.id, `${id} + 123`).toString();
    const content = { id, user_id: encryptedId };
    await addData('auth_cookies', content);
    return id;
}

async function get_cookie(cookie_id) {
    const payload = await getData('auth_cookies', cookie_id);
    if (!payload) return null;

    try {
        const bytes = CryptoJS.AES.decrypt(payload.user_id, `${payload.id} + 123`).toString(CryptoJS.enc.Utf8);
        await deleteData('auth_cookies', cookie_id); // FIXED: remove stray 'k'
        const cookie = await create_cookie({ id: bytes });
        const user = await getData('user', bytes);
        return { user, cookie };
    } catch (e) {
        return null;
    }
}

// ---------------- Signup ----------------

router.post("/signup", limiter, async (req, res) => {
    const { name, phoneNumber, password } = req.body;
    if (!phoneNumber || !password) {
        return res.status(400).send({ error: "All fields are required" });
    }

    try {
        // Check existing user
        const userExists = await db.get(`user:phone:${phoneNumber}`);
        if (userExists) return res.status(400).send({ message: "User with this phone already exists" });

        const hashedPassword = await bcrypt.hash(password + PASSWORD_SALT, 10);
        const id = await generateId("user");

        // Count existing users (assign first user as superuser)
        let count = 0;
        let keysArray = [];

        // Use createKeyStream if available, otherwise fallback to createReadStream
        if (db.createKeyStream) {
            const keyStream = await db.createKeyStream();
            for await (const key of keyStream) {
                if (key) keysArray.push(key.toString());
            }
        } else if (db.createReadStream) {
            const rows = await db.createReadStream(); // returns array of {key, value}
            keysArray = rows.map(row => row.key.toString());
        }

        // Count only user keys (ignore phone mappings)
        for (const key of keysArray) {
            if (key.startsWith("user:") && !key.startsWith("user:phone:")) {
                count++;
            }
        }



        let roles = [];
        if (count === 0) {
            const rid = await generateId("roles");
            const roleData = {
                id: rid,
                name: "superuser",
                permissions: ["home", "inventory_management", "sales", "access_control", "reportings_sales", "settings"],
                created: new Date(),
            };
            await db.put(`roles:${rid}`, JSON.stringify(roleData));
            roles.push(roleData);
        }

        const user = {
            id,
            name,
            phoneNumber,
            password: hashedPassword,
            createdAt: new Date(),
            ...(roles.length && { roles }),
        };

        // Save mappings
        await db.put(`user:phone:${phoneNumber}`, `user:${id}`);
        await db.put(`user:${id}`, JSON.stringify(user));

        // Create JWT + cookie
        const token = jwt.sign({ id, phoneNumber, name }, JWT_SECRET, { expiresIn: '1h' });
        const cookie = await create_cookie(user);

        res.cookie('auth_token', cookie, { httpOnly: true, sameSite: 'lax', maxAge: 600000 });
        res.status(201).send({
            message: "User registered successfully",
            user: { id, name, phoneNumber, roles },
            token,
        });
    } catch (error) {
        console.error("Signup error:", error);
        res.status(500).send({ error: "Error creating user", details: error.message });
    }
});

// ---------------- Signin ----------------

router.post("/signin", limiter, async (req, res) => {
    const { phoneNumber, password } = req.body;
    if (!phoneNumber || !password) {
        return res.status(400).send({ message: "Phone number and password are required" });
    }

    try {
        const userKey = await db.get(`user:phone:${phoneNumber}`).catch(() => null);
        if (!userKey) return res.status(404).send({ error: "User not found" });

        const userData = await db.get(userKey).catch(() => null);
        if (!userData) return res.status(500).send({ error: "Error retrieving user information" });

        const user = JSON.parse(userData);

        const isMatch = await bcrypt.compare(password + PASSWORD_SALT, user.password); // FIXED: add same salt
        if (!isMatch) return res.status(401).send({ message: "Invalid credentials" });

        const token = jwt.sign({ id: user.id, phoneNumber, name: user.name }, JWT_SECRET, { expiresIn: '1h' });
        const cookie = await create_cookie(user);

        res.cookie('auth_token', cookie, { httpOnly: true, sameSite: 'lax', maxAge: 600000 });
        res.status(200).send({
            message: "Sign-in successful",
            token,
            user: { id: user.id, phoneNumber, name: user.name, createdAt: user.createdAt },
        });
    } catch (error) {
        console.error("Signin error:", error);
        res.status(500).send({ message: "Error signing in", details: error.message });
    }
});

// ---------------- Signout ----------------

router.get("/signout", (req, res) => {
    res.clearCookie('auth_token', { httpOnly: true, sameSite: 'lax' });
    return res.status(200).json({ message: "Signed out successfully" });
});

module.exports = { router, get_cookie, create_cookie };
