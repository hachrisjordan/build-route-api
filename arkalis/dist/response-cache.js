"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.arkalisResponseCache = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const arkalisResponseCache = (arkalis) => {
    var _a;
    const cache = arkalis.debugOptions.globalCachePath !== null && fileSystemCache(arkalis.debugOptions.globalCachePath);
    const resultCacheTtlMs = (_a = arkalis.scraperMeta.resultCacheTtlMs) !== null && _a !== void 0 ? _a : arkalis.debugOptions.defaultResultCacheTtl;
    return {
        async runAndCache(key, func) {
            // Use a previously cached response if available
            if (cache && arkalis.debugOptions.useResultCache && resultCacheTtlMs > 0) {
                const existingCache = await cache.get(key);
                if (existingCache) {
                    arkalis.log(`Found and using cached result for ${key}`);
                    return existingCache;
                }
            }
            const result = await func();
            // Store the successful result into cache
            if (cache && arkalis.debugOptions.useResultCache && resultCacheTtlMs > 0)
                await cache.set(key, result, resultCacheTtlMs);
            return result;
        }
    };
};
exports.arkalisResponseCache = arkalisResponseCache;
const KEY_REGEX = /^[\w-]+$/u;
const fileSystemCache = (basePath) => {
    if (!fs_1.default.existsSync(basePath))
        fs_1.default.mkdirSync(basePath, { recursive: true });
    const cleanUpExpiredKeys = async () => {
        const files = await promises_1.default.readdir(basePath);
        await Promise.all(files.map(async (file) => {
            const filePath = path_1.default.join(basePath, file);
            const content = await promises_1.default.readFile(filePath, "utf-8");
            const { expiration } = JSON.parse(content);
            if (expiration < Date.now())
                await promises_1.default.unlink(filePath);
        }));
    };
    const set = async (key, value, ttlMs) => {
        if (!KEY_REGEX.test(key))
            throw new Error(`Invalid key: ${key}`);
        const expiration = Date.now() + ttlMs;
        const content = JSON.stringify({ value, expiration });
        const filePath = path_1.default.join(basePath, key);
        await promises_1.default.writeFile(filePath, content);
    };
    const get = async (key) => {
        if (!KEY_REGEX.test(key))
            throw new Error(`Invalid key: ${key}`);
        const filePath = path_1.default.join(basePath, key);
        try {
            const content = await promises_1.default.readFile(filePath, "utf-8");
            const { value, expiration } = JSON.parse(content);
            if (expiration >= Date.now())
                return value;
            await promises_1.default.unlink(filePath);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        return undefined;
    };
    return { get, set, cleanUpExpiredKeys };
};
