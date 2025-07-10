"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultDebugOptions = exports.defaultScraperMetadata = void 0;
exports.runArkalis = runArkalis;
const ansi_colors_1 = __importDefault(require("ansi-colors"));
const dayjs_1 = __importDefault(require("dayjs"));
const util_1 = __importDefault(require("util"));
const p_retry_1 = __importDefault(require("p-retry"));
const requests_js_1 = require("./requests.js");
const interceptor_js_1 = require("./interceptor.js");
const proxy_js_1 = require("./proxy.js");
const browser_js_1 = require("./browser.js");
const page_helpers_js_1 = require("./page-helpers.js");
const interaction_js_1 = require("./interaction.js");
const response_cache_js_1 = require("./response-cache.js");
exports.defaultScraperMetadata = {
    name: "default", defaultTimeoutMs: 30000, blockUrls: [], useGlobalBrowserCache: true, resultCacheTtlMs: null
};
exports.defaultDebugOptions = {
    maxAttempts: 3, pauseAfterError: false, pauseAfterRun: false, useProxy: true, browserDebug: false, winston: null,
    globalBrowserCacheDir: "./tmp/browser-cache", globalCachePath: null, drawMousePath: false,
    timezone: null, showRequests: true, useResultCache: false, defaultResultCacheTtl: 0,
    liveLog: (prettyLine) => { /* eslint-disable no-console */ console.log(prettyLine); /* eslint-enable no-console */ }
};
const DEFAULT_PLUGINS = {
    arkalisResponseCache: response_cache_js_1.arkalisResponseCache, // add ability to cache results
    arkalisProxy: // add ability to cache results
    proxy_js_1.arkalisProxy, // pick a proxy server (if one is required)
    arkalisBrowser: // pick a proxy server (if one is required)
    browser_js_1.arkalisBrowser, // launch chrome (w/ blocking, window, timezone, proxy)
    arkalisInteraction: // launch chrome (w/ blocking, window, timezone, proxy)
    interaction_js_1.arkalisInteraction, // human-y mouse and keyboard control
    arkalisRequests: // human-y mouse and keyboard control
    requests_js_1.arkalisRequests, // subscribe to request events and see stats like bytes used and cache hits
    arkalisInterceptor: // subscribe to request events and see stats like bytes used and cache hits
    interceptor_js_1.arkalisInterceptor, // adds ability to intercept requests, plus adds http auth proxy support
    arkalisPageHelpers: // adds ability to intercept requests, plus adds http auth proxy support
    page_helpers_js_1.arkalisPageHelpers, // page helpers
    // arkalisHar,              // EXPERIMENTAL: adds ability to generate HAR files
};
async function runArkalisAttempt(code, debugOpts, scraperMetadata, cacheKey) {
    const debugOptions = { ...exports.defaultDebugOptions, ...debugOpts };
    const scraperMeta = { ...exports.defaultScraperMetadata, ...scraperMetadata };
    const logLines = [];
    const identifier = `${Math.random().toString(36).substring(2, 6)}-${cacheKey}`;
    const startTime = Date.now();
    log(`Starting Arkalis run for scraper ${scraperMeta.name}`);
    const loadedPlugins = [];
    const arkalisCore = { client: undefined, log, warn, wait, scraperMeta, debugOptions, pause };
    // Loading plugins one at a time, populating the Arkalis object with their exports. Note that though we cast this
    // object as ArkalisCore, it can be recasted to Arkalis in the plugin, allowing access to previous plugins' exports.
    let arkalis = { ...arkalisCore };
    for (const pluginName of Object.keys(DEFAULT_PLUGINS)) {
        try {
            const loadedPlugin = await DEFAULT_PLUGINS[pluginName](arkalis);
            loadedPlugins.push(loadedPlugin);
            arkalis = { ...arkalis, ...loadedPlugin };
        }
        catch (err) {
            arkalis.log(`Error loading plugin ${pluginName}: ${err.message}\n${err.stack}`);
            await close();
            return { result: undefined, logLines };
        }
    }
    ////////////////////////////////////
    async function close() {
        for (const plugin of loadedPlugins.slice().reverse())
            plugin.close && await plugin.close();
    }
    function log(...args) {
        var _a;
        const prettyLine = args.map((item) => typeof item === "string" ? item : util_1.default.inspect(item, { showHidden: false, depth: null, colors: true })).join(" ");
        logLines.push(`[${(0, dayjs_1.default)().format("YYYY-MM-DD HH:mm:ss.SSS")}] ${prettyLine}`);
        (_a = debugOptions.liveLog) === null || _a === void 0 ? void 0 : _a.call(debugOptions, prettyLine, identifier);
    }
    function warn(...args) {
        const prettyLine = args.map((item) => typeof item === "string" ? item : util_1.default.inspect(item, { showHidden: false, depth: null, colors: true })).join(" ");
        log(ansi_colors_1.default.yellowBright("WARN"), ansi_colors_1.default.yellowBright(prettyLine));
        return [];
    }
    async function wait(ms) {
        // eslint-disable-next-line no-restricted-globals
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    async function pause() {
        log(ansi_colors_1.default.bold(ansi_colors_1.default.redBright("*** paused (open browser to http://127.0.0.1:8282/vnc.html) ***")));
        return wait(10000000);
    }
    function logAttemptResult(failed) {
        var _a;
        (_a = debugOptions.winston) === null || _a === void 0 ? void 0 : _a.log(failed ? "error" : "info", logLines.join("\n"), {
            labels: {
                type: "scraper-run",
                scraper_name: scraperMeta.name,
                start_unix: startTime,
                id: identifier,
                duration_ms: Date.now() - startTime,
                status: failed ? "failure" : "success",
            },
            noConsole: true,
        });
    }
    function prettifyArgs(args) {
        if (typeof args === "string")
            return args;
        return args.map((item) => typeof item === "string"
            ? item
            : util_1.default.inspect(item, { showHidden: false, depth: null, colors: true })).join(" ");
    }
    async function run() {
        const result = await arkalis.runAndCache(`result-${cacheKey}`, async () => code(arkalis));
        return { result, logLines };
    }
    ///////////////
    let success = false;
    return run().then((result) => { success = true; return result; }).catch(async (error) => {
        const fullError = prettifyArgs([ansi_colors_1.default.red("Ending scraper attempt due to:"), error]);
        const timestampedError = fullError.split("\n").map(errLine => `[${(0, dayjs_1.default)().format("YYYY-MM-DD HH:mm:ss.SSS")}] ${errLine}`).join("\n");
        log(timestampedError);
        if (debugOptions.pauseAfterError)
            await pause();
        Object.assign(error, { logLines, arkalis });
        throw error;
    }).finally(async () => {
        if (success && debugOptions.pauseAfterRun)
            await pause();
        const successText = success ? ansi_colors_1.default.greenBright("SUCCESSFULLY") : ansi_colors_1.default.redBright("UNSUCCESSFULLY");
        log(`Completed attempt ${successText} in ${(Date.now() - startTime).toLocaleString("en-US")}ms (${arkalis.stats().summary})`);
        logAttemptResult(!success);
        await close();
    });
}
async function runArkalis(code, debugOpts, scraperMetadata, cacheKey) {
    var _a;
    const allLogLines = [];
    return (0, p_retry_1.default)(async () => {
        const attemptResult = await runArkalisAttempt(code, debugOpts, scraperMetadata, cacheKey);
        allLogLines.push(...attemptResult.logLines);
        return { result: attemptResult.result, logLines: allLogLines };
    }, { minTimeout: 0, maxTimeout: 0, retries: ((_a = debugOpts.maxAttempts) !== null && _a !== void 0 ? _a : exports.defaultDebugOptions.maxAttempts) - 1, onFailedAttempt: (error) => {
            const arkalisError = error;
            arkalisError.arkalis.warn(`Failed to run scraper (attempt ${error.attemptNumber} of ${error.retriesLeft + error.attemptNumber}): ${error.message.split("\n")[0]}`);
            allLogLines.push(...arkalisError.logLines);
        } }).catch(e => {
        return { result: undefined, logLines: allLogLines };
    });
}
