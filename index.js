const express = require("express");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");

const app = express();

// --- Basic Middleware ---
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));
app.use(cors({ origin: "*" }));
app.use(cookieParser());

// --- Auth / Credit / Logs Middleware (Apply only to API routes) ---
const authMiddleware = require("./src/middleware/authentication.middleware");
const creditMiddleware = require("./src/middleware/creditMiddleware");
const logsMiddleware = require("./src/middleware/logs.middleware");

app.use("/api", authMiddleware.auth);
app.use("/api", creditMiddleware);
app.use("/api", logsMiddleware);

// --- Static Files (Frontend) ---
const isPkg = typeof process.pkg !== "undefined";
const basePath = isPkg ? path.dirname(process.execPath) : __dirname;
const staticFilesPath = path.join(basePath, "out", "dist", "frontend", "browser");

// Serve static files
app.use(express.static(staticFilesPath));

// Serve index.html for root
app.get("/", (req, res) => {
    res.sendFile(path.join(staticFilesPath, "index.html"));
});

// --- Routes ---
const dataRoutes = require("./src/routes/dataRoutes");
const authRoutes = require("./src/routes/authRoutes").router;
const utilityRoutes = require("./src/routes/utilityRoutes");
const printRoutes = require("./src/routes/printRoutes");

app.use("/api", utilityRoutes);
app.use("/api", dataRoutes);
app.use("/api", authRoutes);
app.use("/api", printRoutes);

// --- Error Handler ---
app.use((err, req, res, next) => {
    if (err instanceof require("multer").MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).send({ error: "File size exceeds 200MB limit." });
        }
    }
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal Server Error" });
});

// --- Network Interfaces Endpoint ---
const { getNetworkInterfaces } = require("./src/utils/networkUtils");
app.get("/api/network-interfaces", (req, res) => {
    const addresses = getNetworkInterfaces();
    res.json(addresses);
});

// --- Export for Vercel ---
module.exports = app;
