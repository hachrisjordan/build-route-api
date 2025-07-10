"use strict";
// This file is run directly. Example:
//   docker run -it --rm awardwiz:scrapers node dist/arkalis/test-anti-botting.js
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
/* eslint-disable no-console */
const arkalis_js_1 = require("./arkalis.js");
const node_os_1 = __importDefault(require("node:os"));
const pako_1 = __importDefault(require("pako"));
const cross_fetch_1 = __importDefault(require("cross-fetch"));
const dotenv = __importStar(require("dotenv"));
const dayjs_1 = __importDefault(require("dayjs"));
const utc_js_1 = __importDefault(require("dayjs/plugin/utc.js"));
const timezone_js_1 = __importDefault(require("dayjs/plugin/timezone.js"));
dayjs_1.default.extend(utc_js_1.default);
dayjs_1.default.extend(timezone_js_1.default);
dotenv.config();
const debugOptions = {
    maxAttempts: 5,
    pauseAfterRun: false,
    pauseAfterError: true,
    useProxy: false,
    timezone: "America/Los_Angeles",
    showRequests: false,
};
//////////////////////////
const ULIXEE_URL_BY_OS_AND_BROWSER = {
    "Windows NT": "windows-11--chrome-110-0",
    "Linux": "windows-11--chrome-110-0",
    "Darwin": "mac-os-13--chrome-110-0",
};
const getDomDefaults = async (osType) => {
    var _a, _b;
    const osAndBrowser = ULIXEE_URL_BY_OS_AND_BROWSER[osType];
    const url = `https://github.com/ulixee/browser-profile-data/raw/main/profiles/${osAndBrowser}/browser-dom-environment--https.json.gz`;
    const gzippedResponse = await (0, cross_fetch_1.default)(url);
    const buffer = await gzippedResponse.arrayBuffer();
    const text = new TextDecoder("utf-8").decode(pako_1.default.inflate(buffer));
    const raw = JSON.parse(text);
    const navigatorProperties = [
        ...Object.keys((_b = (_a = raw.data.window.Navigator) === null || _a === void 0 ? void 0 : _a.prototype) !== null && _b !== void 0 ? _b : {}).filter(check => !["_$protos", "Symbol(Symbol.toStringTag)", "_$type", "_$flags"].includes(check)),
        "constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
        "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "__proto__", "constructor"
    ];
    return { navigatorProperties, raw };
};
console.log(`downloading dom defaults for ${node_os_1.default.type()}`);
const domDefaults = await getDomDefaults(node_os_1.default.type());
const runIncolumnitas = async () => {
    const problems = await (0, arkalis_js_1.runArkalis)(async (arkalis) => {
        var _a, _b, _c, _d, _e;
        arkalis.goto("https://bot.incolumitas.com/");
        arkalis.log("waiting for tests to finish");
        await arkalis.waitFor({ "fingerprint": { type: "html", html: /"fpscanner": \{\n/gu } });
        const newTests = JSON.parse((_a = await arkalis.getSelectorContent("#new-tests")) !== null && _a !== void 0 ? _a : "{}");
        const oldTestsIntoli = JSON.parse((_b = await arkalis.getSelectorContent("#detection-tests")) !== null && _b !== void 0 ? _b : "{}").intoli;
        const oldTestsFpscanner = JSON.parse((_c = await arkalis.getSelectorContent("#detection-tests")) !== null && _c !== void 0 ? _c : "{}").fpscanner;
        const datacenter = JSON.parse((_d = await arkalis.getSelectorContent("#datacenter-ip-api-data").catch(() => undefined)) !== null && _d !== void 0 ? _d : "{}");
        const datacenterOffset = -(0, dayjs_1.default)().utcOffset(datacenter.location.timezone).utcOffset(); // ex 480
        //const tcpipFingerprint = JSON.parse(await arkalis.getSelectorContent("#p0f").catch(() => undefined) ?? "{}") as TcpIpFingerprint
        const fp = JSON.parse((_e = await arkalis.getSelectorContent("#fp").catch(() => undefined)) !== null && _e !== void 0 ? _e : "{}");
        /* eslint-disable @typescript-eslint/restrict-template-expressions */
        const problems = [
            ...Object.entries(newTests).filter(([k, v]) => v === "FAIL").map(([k, v]) => `new-tests.${k} = ${v}`),
            ...Object.entries(oldTestsIntoli).filter(([k, v]) => v === "FAIL").map(([k, v]) => `intoli.${k} = ${v}`),
            ...Object.entries(oldTestsFpscanner).filter(([k, v]) => v === "FAIL").map(([k, v]) => `fpscanner.${k} = ${v}`),
            ...["is_bogon", "is_datacenter", "is_tor", "is_proxy", "is_vpn", "is_abuser"].map(k => datacenter[k] === false ? undefined : `datacenter.${k} = ${datacenter[k]}`),
            datacenter.asn.type !== "isp" ? `datacenter.asn.type = ${datacenter.asn.type} (not "isp")` : undefined,
            //tcpipFingerprint.os_mismatch ? `tcpip-fingerprint.os_mismatch = ${tcpipFingerprint.os_mismatch}` : undefined,
            fp.webDriver ? undefined : `fp.webDriver = ${fp.webDriver} (was expecting true)`,
            fp.webDriverValue ? `fp.webDriverValue = ${fp.webDriverValue} (was expecting false/undefined)` : undefined,
            fp.selenium.some((item) => item) ? `fp.selenium = ${fp.selenium}` : undefined,
            fp.phantomJS.some((item) => item) ? `fp.phantomJS = ${fp.phantomJS}` : undefined,
            fp.nightmareJS ? `fp.nightmareJS = ${fp.nightmareJS}` : undefined,
            fp.domAutomation ? `fp.domAutomation = ${fp.domAutomation}` : undefined,
            fp.debugTool ? `fp.debugTool = ${fp.debugTool}` : undefined,
            fp.getTimezoneOffset !== datacenterOffset ? `fp.getTimezoneOffset = ${fp.getTimezoneOffset} (was expecting ${datacenterOffset} as per ip from fp)` : undefined,
            fp.navigatorProperties.join(",") === domDefaults.navigatorProperties.join(",") ? undefined : `fp.navigatorProperties = MISMATCH (vs the expected items in ${ULIXEE_URL_BY_OS_AND_BROWSER[node_os_1.default.type()]})`,
        ];
        /* eslint-enable @typescript-eslint/restrict-template-expressions */
        // These tests are being done innacurately on incolumitas
        problems[problems.indexOf("fpscanner.WEBDRIVER = FAIL")] = undefined; // fails on real Chrome too
        // arkalis.log(problems.filter(p => p !== undefined))
        // await arkalis.pause()
        return problems.filter(p => p !== undefined);
    }, debugOptions, { name: "incolumitas", defaultTimeoutMs: 60000, useGlobalBrowserCache: false }, "incolumitas");
    return problems;
};
const runSannysoft = async () => {
    const problems = await (0, arkalis_js_1.runArkalis)(async (arkalis) => {
        arkalis.goto("https://bot.sannysoft.com/");
        arkalis.log("waiting for tests to finish");
        await arkalis.waitFor({ "completed": { type: "html", html: /PHANTOM_WINDOW_HEIGHT/gu } });
        arkalis.log("checking results");
        const problems = [
            /* eslint-disable quotes */
            ...await arkalis.evaluate(`failed = []; document.querySelectorAll("td[id][class='failed']").forEach((el) => failed.push(el.id)); failed`),
            ...await arkalis.evaluate(`failed = []; document.querySelectorAll("td[class='failed']:not([id])").forEach((el) => failed.push(el.previousSibling.innerText)); failed`),
            ...await arkalis.evaluate(`failed = []; document.querySelectorAll("td[class='warn']:not([id])").forEach((el) => failed.push(el.previousSibling.innerText)); failed`)
            /* eslint-enable quotes */
        ].filter(problem => problem !== "null").map(item => `sannysoft.${item} = FAIL`);
        // These tests are being done innacurately on sannysoft
        problems[problems.indexOf("sannysoft.WEBDRIVER = FAIL")] = undefined; // fails on real Chrome too
        // arkalis.log(problems.filter(p => p !== undefined))
        // await arkalis.pause()
        return problems.filter(p => p !== undefined);
    }, debugOptions, { name: "sannysoft", defaultTimeoutMs: 60000, useGlobalBrowserCache: false }, "sannysoft");
    return problems;
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const runCreepJSWIP = async () => {
    const problems = await (0, arkalis_js_1.runArkalis)(async (arkalis) => {
        arkalis.goto("https://abrahamjuliot.github.io/creepjs/");
        arkalis.log("waiting for tests to finish");
        await arkalis.waitFor({ "completed": { type: "html", html: /performance benchmark/gu } });
        arkalis.log("checking results");
        await arkalis.pause();
        return [];
    }, debugOptions, { name: "creepjs", defaultTimeoutMs: 60000, useGlobalBrowserCache: false }, "creepjs");
    return problems;
};
//////////////////////////
console.log("running Incolumnitas (https://bot.incolumitas.com/)...");
console.log((await runIncolumnitas()).result);
console.log("running Sannysoft (https://bot.sannysoft.com/)...");
console.log((await runSannysoft()).result);
// console.log("running CreepJS (https://abrahamjuliot.github.io/creepjs/)...")
// console.log((await runCreepJSWIP()).result)
console.log("done");
