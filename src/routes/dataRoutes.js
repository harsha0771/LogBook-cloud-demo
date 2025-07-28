const express = require("express");
const router = express.Router();
const db = require("../config/dbConfig");
const { addData, parseExcelFile, addBulkData, HashSearch, removeDuplicates } = require("../utils/dbUtils");
const { multiUpload } = require("../config/multerConfig");
const CryptoJS = require("crypto-js");
const { v4: uuidv4 } = require('uuid');
const { hash } = require("bcrypt");

router.post("/add/:entity", async (req, res) => {
    try {
        const { entity } = req.params;
        const data = req.body;
        const result = await addData(entity, data, true);
        res.json(result);
    } catch (error) {
        res.status(500).send("Error: " + error.message);
    }
});

const bulkProcessStatus = {};

// Validation function
function validateRow(row, schema) {
    const errors = [];

    for (const key in schema) {
        const rules = schema[key];
        const value = row[key];

        // Required check
        if (rules.required && (value === undefined || value === null || value === "")) {
            errors.push(`${key} is required`);
            continue;
        }

        // Skip further checks if value is missing and not required
        if (value === undefined || value === null || value === "") continue;

        // Type check
        if (rules.type) {
            if (rules.type === "number" && isNaN(Number(value))) {
                errors.push(`${key} must be a number`);
            } else if (rules.type === "string" && typeof value !== "string") {
                errors.push(`${key} must be a string`);
            }
        }

        // Min/Max validation
        if (rules.min !== undefined) {
            if (rules.type === "string" && value.length < rules.min) {
                errors.push(`${key} must be at least ${rules.min} characters`);
            } else if (rules.type === "number" && Number(value) < rules.min) {
                errors.push(`${key} must be >= ${rules.min}`);
            }
        }

        if (rules.max !== undefined) {
            if (rules.type === "string" && value.length > rules.max) {
                errors.push(`${key} must be at most ${rules.max} characters`);
            } else if (rules.type === "number" && Number(value) > rules.max) {
                errors.push(`${key} must be <= ${rules.max}`);
            }
        }

        // Pattern (e.g., email)
        if (rules.pattern === "email") {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(value)) {
                errors.push(`${key} must be a valid email`);
            }
        }
    }

    return errors;
}

router.post("/add/bulk/:entity", multiUpload, async (req, res) => {
    try {
        const { entity } = req.params;

        if (!req.files || req.files.length === 0) {
            return res.status(400).send({ error: "No file uploaded" });
        }

        // Parse required fields schema
        let requiredFields = {};
        if (req.body.requiredFields) {
            requiredFields =
                typeof req.body.requiredFields === "string"
                    ? JSON.parse(req.body.requiredFields)
                    : req.body.requiredFields;
        }

        // Generate unique process ID
        const processId = uuidv4();
        bulkProcessStatus[processId] = { percentage: 0, status: "processing" };
        console.log(`Bulk upload started for entity: ${entity}, Process ID: ${processId}`);

        // Respond immediately
        res.json({ processId });

        // Process files asynchronously
        (async () => {
            let allResults = [];
            let insertedIds = [];

            try {
                // Calculate total rows
                let totalRows = req.files.reduce((sum, file) => {
                    const dataArray = parseExcelFile(file.path);
                    return sum + dataArray.length;
                }, 0);
                bulkProcessStatus[processId].totalRows = totalRows;

                let processedRows = 0;
                let fileIndex = 0;

                for (const file of req.files) {
                    const dataArray = parseExcelFile(file.path);
                    fileIndex++;

                    let rowIndex = 0;
                    for (const row of dataArray) {
                        rowIndex++;

                        // Skip empty rows
                        if (Object.keys(row).length === 0) continue;

                        // Validate row
                        const validationErrors = validateRow(row, requiredFields);

                        if (validationErrors.length > 0) {
                            bulkProcessStatus[processId].status = "failed";
                            bulkProcessStatus[processId].message = `Validation failed in file "${file.originalname}", row ${rowIndex + 1} ${validationErrors.join(", ")}`;
                            bulkProcessStatus[processId].percentage = ((processedRows / totalRows) * 100).toFixed(2);

                            // Rollback inserted items
                            for (const id of insertedIds) {
                                await deleteItem(entity, id);
                            }

                            return;
                        }

                        try {
                            const result = await addData(entity, row, true);

                            if (result && result.id) {
                                insertedIds.push(result.id);
                            }

                            allResults.push({
                                row,
                                status: "success",
                                result
                            });
                        } catch (err) {
                            bulkProcessStatus[processId].status = "failed";
                            bulkProcessStatus[processId].message = `Insert failed in file "${file.originalname}", row ${rowIndex + 1} ${err.message}`;
                            bulkProcessStatus[processId].percentage = ((processedRows / totalRows) * 100).toFixed(2);

                            for (const id of insertedIds) {
                                await deleteItem(entity, id);
                            }

                            return;
                        }

                        processedRows++;
                        bulkProcessStatus[processId].percentage = ((processedRows / totalRows) * 100).toFixed(2);
                        bulkProcessStatus[processId].processedRows = processedRows;
                    }
                }

                // Completed
                bulkProcessStatus[processId].status = "completed";
                bulkProcessStatus[processId].percentage = 100;
                bulkProcessStatus[processId].results = allResults;
            } catch (err) {
                bulkProcessStatus[processId].status = "failed";
                bulkProcessStatus[processId].message = `Unexpected error - ${err.message}`;

                for (const id of insertedIds) {
                    await deleteItem(entity, id);
                }
            }
        })();
    } catch (error) {
        res.status(500).send("Error: " + error.message);
    }
});



router.get("/bulk/status/:processId", (req, res) => {
    const { processId } = req.params;
    const status = bulkProcessStatus[processId];
    if (!status) {
        return res.status(404).send({ error: "Process not found" });
    }
    res.json(status);
});

router.get("/search", async (req, res) => {
    const { keyword, schema, filterBy, limit } = req.query;
    try {
        const results = await HashSearch(keyword, schema, filterBy, parseInt(limit, 10));
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

router.get("/read/:entity/:start/:end", async (req, res) => {
    let { entity, start, end } = req.params;
    start = parseInt(start, 10) || 0;
    end = parseInt(end, 10) || 50;

    try {
        // Fetch all rows from kv_store
        const rows = await db.createReadStream();
        const results = [];
        let currentIndex = 0;

        // Filter and process rows
        for (const row of rows) {
            const [storedEntity] = row.key.split(":");
            if (storedEntity === entity) {
                if (currentIndex >= start && currentIndex < end) {
                    try {
                        results.push(JSON.parse(row.value));
                    } catch (parseError) {
                        //   console.error(`Error parsing value for key ${row.key}:`, parseError.message);
                        // Optionally skip or handle malformed JSON
                    }
                }
                currentIndex++;
            }
        }

        res.status(200).send(results);
    } catch (error) {
        console.error("Error processing request:", error);
        res.status(500).send({ error: "Error processing request", details: error.message });
    }
});

router.get("/read/:entity/:id", async (req, res) => {
    const { entity, id } = req.params;
    try {
        const key = `${entity}:${id}`;
        const item = await db.get(key).catch(() => null);
        if (!item) return res.status(404).send({ error: "Item not found" });
        res.send(JSON.parse(item));
    } catch (error) {
        console.log("Error fetching item:", error);

        res.status(500).send({ error: "Error fetching item", details: error });
    }
});

router.get("/read_key_value/:entity/search/:key/:value", async (req, res) => {
    const { entity, key, value } = req.params;
    let results = [];
    try {
        await db.createReadStream()
            .on("data", (data) => {
                const [storedEntity, id] = data.key.split(":");
                const item = JSON.parse(data.value);
                if (storedEntity === entity && item[key] === value) results.push(item);
            })
            .on("end", () => res.send(results))
            .on("error", (error) =>
                res.status(500).send({ error: "Error fetching data", details: error })
            );
    } catch (error) {
        res.status(500).send({ error: "Error processing request", details: error });
    }
});

router.put("/update/:entity/:id", async (req, res) => {
    const { entity, id } = req.params;
    const updatedItem = { ...req.body, last_updated: new Date().toISOString() };
    if (updatedItem.password) {
        updatedItem.password = await hash(updatedItem.password + 'ems&sort_by=sold&limit=20', 10);
    }
    try {
        const key = `${entity}:${id}`;
        const result = await db.get(key);
        const existingItem = result ? JSON.parse(result.toString("utf-8")) : null;
        if (!existingItem) return res.status(404).send({ error: "Item not found" });
        await db.put(key, JSON.stringify(updatedItem));
        let updatedHashes = [];
        for (let [key, value] of Object.entries(updatedItem)) {
            const oldValue = existingItem[key];
            if (oldValue && oldValue != value) {
                updatedHashes.push(key);
                let valuies = oldValue.toString().toLowerCase().split(" ");
                for (const element3 of valuies) {
                    const hashedText = CryptoJS.SHA256(element3.replace(/[,.]/g, "")).toString();
                    let hs = await db.get("HashData:" + hashedText).then((data) => JSON.parse(data.toString("utf-8"))).catch(() => null);
                    if (hs) {
                        hs[oldValue] = hs[oldValue] || {};
                        hs[oldValue][entity] = hs[oldValue][entity] || {};
                        hs[oldValue][entity][key] = hs[oldValue][entity][key] || [];
                        const index = hs[oldValue][entity][key].indexOf(id);
                        if (index > -1) hs[oldValue][entity][key].splice(index, 1);
                        await db.put("HashData:" + hashedText, JSON.stringify(hs));
                    }
                }
            }
        }
        for (const key of updatedHashes) {
            await require("../utils/dbUtils").makeHash(updatedItem[key], key, entity, id);
        }
        res.send({ message: `Item updated successfully in ${entity}`, updatedItem });
    } catch (error) {
        console.error("Error updating item:", error);
        res.status(500).send({ error: "Error updating item", details: error });
    }
});

async function deleteItem(entity, id) {
    const key = `${entity}:${id}`;

    try {
        const result = await db.get(key);
        const existingItem = result ? JSON.parse(result.toString("utf-8")) : null;

        if (!existingItem) {
            return { success: false, message: "Item not found" };
        }

        // Remove hashed references
        for (const [fieldKey, value] of Object.entries(existingItem)) {
            let values = value.toString().toLowerCase().split(" ");

            for (const word of values) {
                const hashedText = CryptoJS.SHA256(word.replace(/[,.]/g, "")).toString();

                let hs = await db
                    .get("HashData:" + hashedText)
                    .then((data) => JSON.parse(data.toString("utf-8")))
                    .catch(() => null);

                if (hs) {
                    hs[value] = hs[value] || {};
                    hs[value][entity] = hs[value][entity] || {};
                    hs[value][entity][fieldKey] = hs[value][entity][fieldKey] || [];

                    const index = hs[value][entity][fieldKey].indexOf(id);
                    if (index > -1) hs[value][entity][fieldKey].splice(index, 1);

                    await db.put("HashData:" + hashedText, JSON.stringify(hs));
                }
            }
        }

        // Delete the item
        await db.del(key);

        return { success: true, message: `Item deleted successfully from ${entity}` };
    } catch (error) {
        return { success: false, message: "Error deleting item", error };
    }
}

router.delete("/delete/:entity/:id", async (req, res) => {
    const { entity, id } = req.params;
    const result = await deleteItem(entity, id);

    if (!result.success) {
        return res.status(result.message === "Item not found" ? 404 : 500).send(result);
    }

    res.send({ message: result.message });
});

module.exports = router;