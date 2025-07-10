"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.arkalisBrowser = void 0;
const util_1 = require("util");
const node_child_process_1 = require("node:child_process");
const node_url_1 = __importDefault(require("node:url"));
const ChromeLauncher = __importStar(require("chrome-launcher"));
const chrome_remote_interface_1 = __importDefault(require("chrome-remote-interface"));
const exec = (0, util_1.promisify)(node_child_process_1.exec);
const arkalisBrowser = async (arkalis) => {
    async function genWindowCoords() {
        var _a, _b;
        // Cross-platform screen resolution detection
        let screenResolution;
        try {
            if (process.platform === 'win32') {
                // Windows: use PowerShell to get screen resolution
                const { stdout } = await exec('powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds"');
                const match = stdout.match(/Width:\s*(\d+)\s*Height:\s*(\d+)/);
                if (match) {
                    screenResolution = `${match[1]}x${match[2]}`;
                }
                else {
                    // Fallback to default resolution
                    screenResolution = "1920x1080";
                }
            }
            else {
                // Linux/Unix: use xdpyinfo
                const { stdout } = await exec("xdpyinfo | grep dimensions");
                const match = / (?<res>\d+x\d+) /u.exec(stdout);
                screenResolution = ((_b = (_a = match === null || match === void 0 ? void 0 : match.groups) === null || _a === void 0 ? void 0 : _a["res"]) === null || _b === void 0 ? void 0 : _b.trim()) || "1920x1080";
            }
        }
        catch (error) {
            // Fallback to default resolution if detection fails
            arkalis.log(`Warning: Could not detect screen resolution, using default: ${error}`);
            screenResolution = "1920x1080";
        }
        const rawRes = screenResolution.split("x");
        if (!rawRes || rawRes.length !== 2)
            throw new Error("Unable to get screen resolution");
        const res = rawRes.map(num => parseInt(num));
        const size = [Math.ceil(res[0] * (Math.random() * 0.2 + 0.8)), Math.ceil(res[1] * (Math.random() * 0.2 + 0.8))];
        return {
            size,
            pos: [Math.ceil((res[0] - size[0]) * Math.random()), Math.ceil((res[1] - size[1]) * Math.random())]
        };
    }
    // generate a random window size
    const window = await genWindowCoords();
    // these domains are used by the browser when creating a new profile
    const blockDomains = [
        "accounts.google.com", "clients2.google.com", "optimizationguide-pa.googleapis.com",
        "content-autofill.googleapis.com"
    ];
    const switches = [
        // these should all be undetectable, but speed things up
        "disable-sync", "disable-backgrounding-occluded-windows", "disable-breakpad",
        "disable-domain-reliability", "disable-background-networking", "disable-features=AutofillServerCommunication",
        "disable-features=CertificateTransparencyComponentUpdater", "enable-crash-reporter-for-testing", "no-service-autorun",
        "no-first-run", "no-default-browser-check", "disable-prompt-on-repost", "disable-client-side-phishing-detection",
        "disable-features=InterestFeedContentSuggestions", "disable-features=Translate", "disable-hang-monitor",
        "autoplay-policy=no-user-gesture-required", "use-mock-keychain", "disable-omnibox-autocomplete-off-method",
        "disable-gaia-services", "disable-crash-reporter", "noerrdialogs", "disable-component-update",
        "disable-features=MediaRouter", "metrics-recording-only", "disable-features=OptimizationHints",
        "disable-component-update", "disable-features=CalculateNativeWinOcclusion", "enable-precise-memory-info",
        "no-sandbox", "disable-dev-shm-usage", // for linux docker
        // "disable-blink-features=AutomationControlled", // not working
        // "auto-open-devtools-for-tabs",
        // "log-net-log=tmp/out.json", "net-log-capture-mode=Everything",     // note, does not log requests
        // TODO: pass this in dyanmically from a hook in the har scraper
        "log-net-log=./tmp/netlog.json", "net-log-capture-mode=Everything",
        arkalis.debugOptions.browserDebug === "verbose" ? "enable-logging=stderr" : "",
        arkalis.debugOptions.browserDebug === "verbose" ? "v=2" : "",
        arkalis.scraperMeta.useGlobalBrowserCache ? `disk-cache-dir=${arkalis.debugOptions.globalBrowserCacheDir}` : "",
        `window-position=${window.pos[0]},${window.pos[1]}`,
        `window-size=${window.size[0]},${window.size[1]}`,
        `host-rules=${blockDomains.map(blockDomain => `MAP ${blockDomain} 0.0.0.0`).join(", ")}`, // NOTE: detectable!
    ];
    // apply proxy
    const proxy = arkalis.proxy;
    if (proxy) {
        const parsedProxy = node_url_1.default.parse(proxy);
        if (!parsedProxy.hostname || !parsedProxy.protocol || !parsedProxy.host)
            throw new Error(`Invalid proxy: ${proxy}`);
        switches.push(`proxy-server=${parsedProxy.protocol}//${parsedProxy.host}`);
        switches.push(`host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${parsedProxy.hostname}`);
    }
    // launch chrome
    const instance = await ChromeLauncher.launch({
        chromeFlags: switches.map(s => s.length > 0 ? `--${s}` : ""),
        ignoreDefaultFlags: true,
        logLevel: arkalis.debugOptions.browserDebug ? "verbose" : "silent",
    });
    // connect to cdp client
    arkalis.debugOptions.browserDebug && arkalis.log("connecting to cdp client");
    arkalis.client = await (0, chrome_remote_interface_1.default)({ port: instance.port });
    await arkalis.client.Network.enable();
    await arkalis.client.Page.enable();
    await arkalis.client.Runtime.enable();
    await arkalis.client.DOM.enable();
    // timezone (set either by the caller or the proxy)
    if (arkalis.debugOptions.timezone)
        await arkalis.client.Emulation.setTimezoneOverride({ timezoneId: arkalis.debugOptions.timezone });
    // block requested URLs
    if (arkalis.scraperMeta.blockUrls.length > 0)
        await arkalis.client.Network.setBlockedURLs({ urls: arkalis.scraperMeta.blockUrls });
    return {
        close: async () => {
            arkalis.debugOptions.browserDebug && arkalis.log("closing cdp client and browser");
            await arkalis.client.Network.disable().catch(() => { });
            await arkalis.client.Page.disable().catch(() => { });
            await arkalis.client.Runtime.disable().catch(() => { });
            await arkalis.client.DOM.disable().catch(() => { });
            await arkalis.client.Browser.close().catch(() => { });
            await arkalis.client.close().catch(() => { });
            instance.kill();
        }
    };
};
exports.arkalisBrowser = arkalisBrowser;
