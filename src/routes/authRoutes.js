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
const axios = require("axios");

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });

const create_cookie = async (payload) => {
    let id = randomUUID() + Date.now().toString();
    const encryptedId = CryptoJS.AES.encrypt(payload.id, `${id} + 123`).toString();
    let content = { id: id, user_id: encryptedId };
    await addData('auth_cookies', content);
    return id;
}

const get_cookie = async (cookie_id) => {
    const payload = await getData('auth_cookies', cookie_id);
    try {
        const bytes = CryptoJS.AES.decrypt(payload.user_id, `${payload.id} + 123`).toString(CryptoJS.enc.Utf8);
        await deleteData(`auth_cookies`, cookie_id + 'k');
        let cookie = await create_cookie({ id: bytes });
        let user = await getData('user', bytes);
        return { user, cookie };
    } catch (e) {
        return null;
    }
}

router.post("/signup", limiter, async (req, res) => {
    const { name, phoneNumber, password } = req.body;
    if (!phoneNumber || !password) {
        console.log("Signup error: Missing fields");
        return res.status(400).send({ error: "All fields are required" });
    }
    try {
        const userExists = await db.get(`user:phone:${phoneNumber}`).catch(() => null);
        if (userExists) {
            console.log("Signup error: User already exists for phone", phoneNumber);
            return res.status(400).send({ message: "User with this phone number already exists" });
        }
        const hashedPassword = await bcrypt.hash(password + 'ems&sort_by=sold&limit=20', 10);
        const id = await generateId("user");
        console.log("Generated user id:", id);

        let count = 0;
        const stream = db.createKeyStream ? await db.createKeyStream() : await db.createReadStream({ keys: true, values: false });
        for await (var key of stream) {
            key = key.toString()
            if (typeof key === "string" && key.startsWith("user:") && !key.startsWith("user:phone:")) {
                count++;
            }
        }
        console.log("User count in DB:", count);

        count = Number(count);

        let roleData = {};
        if (count === 0) {
            const rid = await generateId("roles");
            roleData = {
                id: rid,
                name: "superuser",
                permissions: ["home", "inventory_management", "sales", "access_control", "reportings_sales", "settings"],
                created: new Date(),
            };
            await db.put(`roles:${rid}`, JSON.stringify(roleData));
            console.log("Created superuser role:", roleData);
        }
        const user = {
            id,
            name,
            phoneNumber,
            password: hashedPassword,
            createdAt: new Date(),
            ...(count === 0 && { roles: [roleData] }),
        };
        const phoneKey = `user:phone:${phoneNumber}`;
        const userKey = `user:${id}`;
        await db.put(phoneKey, userKey);
        await db.put(userKey, JSON.stringify(user));
        console.log("User saved to DB:", user);

        const token = jwt.sign(user, "YOUR_SECRET_KEY", { expiresIn: '1h' });
        let cookie = await create_cookie(user);
        console.log("Signup successful, cookie created:", cookie);

        res.cookie('auth_token', cookie, { httpOnly: true, sameSite: 'lax', maxAge: 600000 });
        res.status(201).send({
            message: "User registered successfully",
            user: { id, name, phoneNumber, roles: user.roles },
            token,
        });
    } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).send({ error: "Error creating user", details: error.message });
    }
});

router.post("/signin", limiter, async (req, res) => {
    const { phoneNumber, password } = req.body;
    if (!phoneNumber || !password) {
        return res.status(400).send({ message: "Phone number and password are required" });
    }
    try {
        const userKey = await db.get(`user:phone:${phoneNumber}`).catch(() => null);
        if (!userKey) return res.status(404).send({ error: "User not found" });
        const userData = await db.get(userKey).catch((err) => {
            console.error("Error retrieving user data:", err);
            return null;
        });
        if (!userData) return res.status(500).send({ error: "Error retrieving user information" });
        const user = JSON.parse(userData);
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).send({ message: "Invalid credentials" });
        const token = jwt.sign(
            { id: user.id, phoneNumber, name: user.name },
            "YOUR_SECRET_KEY",
            { expiresIn: '1h' }
        );
        let cookie = await create_cookie(user);
        res.cookie('auth_token', cookie, { httpOnly: true, sameSite: 'lax', maxAge: 600000 });
        res.status(200).send({
            message: "Sign-in successful",
            token,
            user: { id: user.id, phoneNumber, name: user.name, createdAt: user.createdAt },
        });
    } catch (error) {
        console.error("Error in sign-in process:", error);
        res.status(500).send({ message: "Error signing in", details: error.message });
    }
});

router.post("/verify-google-token", async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: "Token is required" });
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: "1012711247018-rat4mho4oav87obdrpmi0gcj32vb7d32.apps.googleusercontent.com",
        });
        const payload = ticket.getPayload();
        const googleEmail = payload.email + "_google_auth";
        const googlePassword = CryptoJS.SHA256(payload.sub + "_google_auth_47_password").toString();

        let signinResponse;
        try {
            signinResponse = await axios.post("http://localhost:90/signin", {
                phoneNumber: googleEmail,
                password: googlePassword
            }, {
                headers: { "Content-Type": "application/json" }
            });
        } catch (err) {
            signinResponse = err.response;
        }
        const signinData = signinResponse ? signinResponse.data : {};

        if (!signinData.token) {
            if (signinData.error === "User not found") {
                let signupResponse;
                try {
                    signupResponse = await axios.post("http://localhost:90/signup", {
                        name: payload.given_name || "Google",
                        phoneNumber: googleEmail,
                        password: googlePassword,
                    }, {
                        headers: { "Content-Type": "application/json" }
                    });
                } catch (err) {
                    signupResponse = err.response;
                }
                const signupData = signupResponse ? signupResponse.data : {};
                if (!signupData.token) throw new Error(signupData.error || "Registration failed");
                let cookie = await create_cookie(signupData.user);
                res.cookie('auth_token', cookie, { httpOnly: true, sameSite: 'lax', maxAge: 600000 });
                return res.json({ success: true, token: signupData.token, user: signupData.user });
            }
            throw new Error(signinData.error || "Authentication failed");
        }
        let cookie = await create_cookie(signinData.user);
        res.cookie('auth_token', cookie, { httpOnly: true, sameSite: 'lax', maxAge: 600000 });
        res.json({ success: true, token: signinData.token, user: signinData.user });
    } catch (error) {
        console.error("Google authentication error:", error);
        res.status(500).json({ success: false, error: error.message || "Google authentication failed" });
    }
});


function generateProfileToken(user) {
    const payload = {
        ...user,
        password: Math.random().toString(36).substring(2),
        id: randomUUID()
    };

    let token = jwt.sign(
        payload,
        process.env.JWT_SECRET || "+ZgoEWzWThsO+PClatF06ETJUMsdRMMi91hDMXYQO2GVDUydnIr1oMj4c6flr/tDl/mA8SOiquuKCX0RmBfgPEadeCgOHGKgRQcw5Z/GnWGaIkbbV2c6hFq1j3irI+aUPEFvoSgV1Zaidp++EeemFECCCnq3TLG0iS/kn01GBVmwN4rMP0jxGYH2/QwBEoX8CMgbbks86k596vYecUcnIJF6BhOOc2MufNU7G48kWf6OMZQ7cqQcrgn9+q2sADOok3xBm0nnTUHQV7Xxrn3uJyXSpGBC9K+JlLjIgYqCTigYIe5NvK4AIgLEd0nCoxf4WU21O9Sfj07pqHr2fBmljxR6jZ7JL0TpN9hT6e3rf8CET1/T/Ih8fH6Y6bJTeg1rN2yCaD8n6261Aa3Wi8CkaapFu1QqybbnEFV/bAWPksrUJlJdeYJ+OZB+3Wx6MxHp5CkdihfpQ2okRy7WFUumQ5rh",
        { expiresIn: '100000s' }
    );
    const timeWindow = Math.floor(Date.now() / (3 * 10000));
    const encryptionKey = `${timeWindow} + 1lqTmlabVF5TVdNNSIsImE1Mz`;
    token = CryptoJS.AES.encrypt(token, encryptionKey).toString();

    return token;
}

router.get("/profile", (req, res) => {
    //   console.log(req.user, "User profile request received");

    const token = generateProfileToken(req.user);
    return res.json({ data: token });
})

router.get("/signout", (req, res) => {
    res.clearCookie('auth_token', { httpOnly: true, sameSite: 'lax' });
    return res.status(200).json({ message: "Signed out successfully" });
})

module.exports = { router, get_cookie, create_cookie };