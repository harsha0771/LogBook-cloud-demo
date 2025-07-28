const CryptoJS = require("crypto-js");
const db = require("../config/dbConfig");
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;


const numberToBase36 = (number) => {
    const chars = "QHZ0WSX1C2DER4FV3BGTN7AYUJ8M96K5IOLP";
    number += 40;
    let base36 = "";
    while (number > 0) {
        let remainder = number % 36;
        base36 = chars[remainder] + base36;
        number = Math.floor(number / 36);
    }
    return base36 || "0";
};

const generateId = async (entity) => {
    let count = await db.get(`count:${entity}`);
    count = count > 0 ? count.toString("utf-8") : Math.floor(Math.random() * 101);
    count = Number(count) + 1;
    await db.put(`count:${entity}`, count.toString());
    return `${numberToBase36(count)}`;
};

const getHashData = async (hashedText) => {
    try {
        const buffer = await db.get("HashData:" + hashedText);
        if (buffer) {
            const data = buffer.toString("utf-8");
            const jsonData = JSON.parse(data);
            return jsonData;
        } else {
            return null;
        }
    } catch (error) {
        return null;
    }
};

const makeHash = async (keywords, elementKey, schema, id) => {

    const skipKeys = new Set(["permisions"]);
    if (skipKeys.has(elementKey)) return;

    try {
        if (!keywords) return;
        const words = keywords
            .toString()
            .toLowerCase()
            .split(" ")
            .filter((word) => word && word.trim() !== "");
        for (const word of words) {
            for (let i = 0; i < word.length; i++) {
                for (let j = i + 1; j <= word.length; j++) {
                    var substring = word.slice(i, j).replace(/[,.]/g, "");
                    if (!isNaN(parseFloat(word))) {
                        substring = word;
                        i = word.length + 1;
                    }
                    if (substring.length >= 2) {
                        const hashedText = CryptoJS.SHA256(substring).toString();
                        let data = await getHashData(hashedText);
                        if (data) {
                            if (!data[substring]) data[substring] = {};
                            if (!data[substring][schema]) data[substring][schema] = {};
                            if (!data[substring][schema][elementKey])
                                data[substring][schema][elementKey] = [];
                            if (!data[substring][schema][elementKey].includes(id)) {
                                data[substring][schema][elementKey].push(id);
                            }
                            await db.put("HashData:" + hashedText, JSON.stringify(data));
                        } else {
                            const newData = {
                                [substring]: { [schema]: { [elementKey]: [id] } },
                            };
                            await db.put("HashData:" + hashedText, JSON.stringify(newData));
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.log("Error in makeHash:", error);
    }
};

const addAttributes = async (attributes, parentSchema, parentId) => {
    let addedAttributes = [];
    for (let index = 0; index < attributes.length; index++) {
        const attribute = attributes[index];
        const attributeName = Object.keys(attribute)[0];
        const attributeValue = Object.values(attribute)[0];
        const attributeData = {
            parentSchema,
            parentId,
            name: attributeName,
            indexInForm: index,
            ...getTypes(attributeValue),
        };
        try {
            const id = await generateId("Attribute");
            attributeData.id = id;
            await db.put("Attribute:" + id, attributeData);
            addedAttributes.push(attributeData);
        } catch (error) {
            console.error("Error adding attribute:", error);
        }
    }
    return addedAttributes;
};

const getTypes = (val) => {
    const typeObj = { valueType: typeof val };
    switch (typeObj.valueType) {
        case "string":
            typeObj.typeString = val;
            break;
        case "number":
            if (Number.isInteger(val)) {
                typeObj.typeInt = val;
            } else {
                typeObj.valueType = "double";
                typeObj.typeDouble = val;
            }
            break;
        case "boolean":
            typeObj.typeBool = val;
            break;
        case "object":
            typeObj.typeObject = JSON.stringify(val);
            break;
        default:
            return null;
    }
    return typeObj;
};

const getAttributesList = async (schema, data) => {
    const schemaList = await db.get("Schema:" + schema).catch(() => ({}));
    const schemaKeys = Object.keys(schemaList);
    const dataKeys = Object.keys(data);
    const commonKeys = dataKeys.filter((key) => schemaKeys.includes(key));
    const attributes = [];
    const dataObj = {};
    for (const key of dataKeys) {
        if (commonKeys.includes(key)) {
            dataObj[key] = data[key];
        } else {
            attributes.push({ [key]: data[key] });
        }
    }
    // Unchanged portion of code
    if (attributes.length > 0) {
        await addAttributes(attributes, schema, data.id);
    }
    return dataObj;
};

const addData = async (schema, data, useHash = false) => {
    if (!data?.id) data.id = await generateId(schema);
    data.id = data.id.toString();
    data.created = data.last_updated = new Date().toISOString();
    try {
        await db.put(schema + ":" + data.id, JSON.stringify(data));
        const dataObject = await db.get(schema + ":" + data.id);
        if (useHash) {
            for (const key of Object.keys(data)) {
                await makeHash(data[key], key, schema, data.id);
            }
        }
        if (dataObject == null) {
            return null;
        }
        return JSON.parse(dataObject.toString("utf-8"));
    } catch (error) {
        console.log(error);
        throw error;
    }
};


const parseExcelFile = (filePath) => {
    const XLSX = require("xlsx");
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // Convert sheet to JSON with raw headers
    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (rawData.length === 0) return [];

    // Sanitize header row: replace spaces, dots, commas, and non-word characters with _
    const rawHeaders = rawData[0];
    const sanitizedHeaders = rawHeaders.map(header =>
        String(header)
            .trim()
            .toLowerCase()
            .replace(/[\s.,\/\\]+/g, "_")  // replace spaces, dots, commas, slashes with _
            .replace(/[^\w_]/g, "")        // remove anything not a-z, A-Z, 0-9 or _
    );

    // Extract data rows (excluding header)
    const dataRows = rawData.slice(1);

    // Map rows to objects with sanitized headers
    const jsonData = dataRows.map(row => {
        const obj = {};
        sanitizedHeaders.forEach((key, i) => {
            obj[key] = row[i];
        });
        return obj;
    });
    return jsonData;
};

const addBulkData = async (schema, dataArray, useHash = false) => {
    const tasks = dataArray.map(async (data) => {
        if (!data?.id) data.id = await generateId(schema);
        data.id = data.id.toString();
        data.created = data.last_updated = new Date().toISOString();

        await db.put(`${schema}:${data.id}`, JSON.stringify(data));
        const dataObject = await db.get(`${schema}:${data.id}`);

        if (useHash) {
            const hashTasks = Object.keys(data).map((key) =>
                makeHash(data[key], key, schema, data.id)
            );
            await Promise.all(hashTasks);
        }

        return JSON.parse(dataObject.toString("utf-8"));
    });

    return Promise.all(tasks);
};

const removeDuplicates = (items) => {
    if (!items?.length) return [];
    const uniqueItems = [];
    const itemsSet = new Set();
    items.forEach((i) => {
        if (!itemsSet.has(i.id)) {
            itemsSet.add(i.id);
            uniqueItems.push(i);
        }
    });
    return uniqueItems;
};

const calculateRelevanceScore = (result, keyword, schema, filterBy) => {
    let score = 0;
    const lowerKeyword = keyword.toLowerCase();

    // Field importance multipliers
    const fieldMultipliers = {
        name: 2,
        barcode: 2.1,
        id: 1.9,
        description: 1.5,
        permisions: 1, // Note: 'permisions' matches your existing spelling
        // Add other fields if needed
    };

    // Check each field
    for (const [field, value] of Object.entries(result)) {
        if (typeof value === 'string') {
            const lowerValue = value.toLowerCase();
            let fieldScore = 0;

            if (lowerValue === lowerKeyword) {
                fieldScore += 1000; // Exact match
            } else if (lowerValue.startsWith(lowerKeyword)) {
                fieldScore += 500; // Starts with
            } else if (lowerValue.includes(lowerKeyword)) {
                fieldScore += 100; // Contains
            }

            // Apply field importance multiplier
            const multiplier = fieldMultipliers[field] || 1;
            score += fieldScore * multiplier;

            // FilterBy bonus
            if (filterBy && field === filterBy && lowerValue.includes(lowerKeyword)) {
                score += 200;
            }
        }
    }

    // Timestamp bonus (favor newer records)
    const currentTime = new Date().getTime();
    const recordTime = new Date(result.last_updated || result.created).getTime();
    const timeBonus = (currentTime - recordTime) / 1000000; // Small bonus, adjustable
    score += timeBonus;

    return score;
};

const HashSearch = async (keyword, schema, filterBy, limit) => {
    if (!isNaN(keyword)) keyword = keyword.toString();
    keyword = keyword.toLowerCase();
    if (keyword.length < 1) return [];
    const textArray = keyword.split(" ");
    let results;
    if (textArray.length > 1) {
        results = await HashSearchUN(textArray[0].replace(/[,. ]/g, ""), schema, filterBy);
        results = results.filter((p) =>
            textArray
                .slice(1)
                .every((element) => JSON.stringify(p).toLowerCase().includes(element.toLowerCase()))
        );
    } else {
        results = await HashSearchUN(keyword.replace(/[,.]/g, ""), schema, filterBy);
    }

    // Sort results by relevance
    results.sort((a, b) => {
        const scoreA = calculateRelevanceScore(a, keyword, schema, filterBy);
        const scoreB = calculateRelevanceScore(b, keyword, schema, filterBy);
        if (scoreB !== scoreA) {
            return scoreB - scoreA; // Higher score first
        }
        // Tiebreaker: alphabetical by id
        return a.id.localeCompare(b.id);
    });

    // Deduplicate and apply limit
    const uniqueResults = removeDuplicates(results);
    return limit > 0 ? uniqueResults.slice(0, limit) : uniqueResults;
};

const HashSearchUN = async (keyword, schema, filterBy) => {
    keyword = keyword.toLowerCase();
    const hashText = CryptoJS.SHA256(keyword).toString();
    const hashData = await getHashData(hashText);
    if (!hashData || !hashData[keyword]) return [];
    const getOutDataWithSchema = async (schemaValue, schemaName) => {
        if (!schemaValue) return [];
        const getDataByIds = async (field) => {
            const o3 = [];
            if (schema) {
                try {
                    const d = await db.get(schema + ":" + keyword.toUpperCase());
                    if (d) o3.push(JSON.parse(d));
                } catch (error) { }
            }
            for (const item_id of field) {
                try {
                    const item = await db.get(schemaName + ":" + item_id);
                    if (item) o3.push(JSON.parse(item));
                } catch (error) { }
            }
            return o3;
        };
        if (filterBy) {
            if (!schemaValue[filterBy]) return [];
            return await getDataByIds(schemaValue[filterBy]);
        }
        let o5 = [];
        for (const field of Object.values(schemaValue)) {
            const items = await getDataByIds(field);
            o5.push(...items);
        }
        return o5;
    };
    if (!schema) {
        let o = [];
        for (const [schemaName, schemaValue] of Object.entries(hashData[keyword])) {
            const schemaResults = await getOutDataWithSchema(schemaValue, schemaName);
            o.push(...schemaResults);
        }
        return o;
    }
    return await getOutDataWithSchema(hashData[keyword][schema], schema);
};

const getData = async (schema, id) => {
    try {
        const data = await db.get(schema + ":" + id);
        if (data) {
            return JSON.parse(data.toString("utf-8"));
        }
        return null;
    } catch (error) {
        return null;
    }
};

const deleteData = async (schema, id) => {
    try {
        await db.del(schema + ":" + id);
        return true;
    } catch (error) {
        console.error("Error deleting data:", error);
        return false;
    }
};

module.exports = {
    generateId,
    makeHash,
    addAttributes,
    getTypes,
    getAttributesList,
    addData,
    parseExcelFile,
    addBulkData,
    removeDuplicates,
    HashSearch,
    HashSearchUN,
    getData,
    deleteData
};