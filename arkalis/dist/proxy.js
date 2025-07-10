"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.arkalisProxy = void 0;
const ansi_colors_1 = __importDefault(require("ansi-colors"));
const node_url_1 = __importDefault(require("node:url"));
const arkalisProxy = (arkalis) => {
    var _a, _b, _c, _d;
    var _e;
    // load proxies from env variables
    const proxies = Object.keys(process.env).reduce((acc, k) => {
        var _a;
        if (!k.startsWith("PROXY_ADDRESS_"))
            return acc;
        const groupName = k.replace("PROXY_ADDRESS_", "").toLowerCase();
        acc[groupName] = ((_a = process.env[k]) !== null && _a !== void 0 ? _a : "").split(",");
        return acc;
    }, {});
    const proxiesForScraper = (_a = proxies[arkalis.scraperMeta.name]) !== null && _a !== void 0 ? _a : proxies["default"];
    if (!arkalis.debugOptions.useProxy || !proxiesForScraper || proxiesForScraper.length === 0) {
        arkalis.warn("Not using proxy server!");
        return { proxy: undefined, onAuthRequired: undefined };
    }
    let proxyUrl = proxiesForScraper[Math.floor(Math.random() * proxiesForScraper.length)];
    // if the format is `http://user:pass_country-UnitedStates_session-AAABBBCC@proxy.abcdef.io:31112`, roll the
    // proxy session id to get a new ip address
    // eslint-disable-next-line regexp/no-unused-capturing-group
    const dynamicProxy = /http.*:\/\/.+:(?<start>\S{16}_country-\S+_session-)(?<sess>\S{8})@/u.exec(proxyUrl);
    if (dynamicProxy)
        proxyUrl = proxyUrl.replace(dynamicProxy.groups["sess"], Math.random().toString(36).slice(2).substring(0, 8));
    (_b = (_e = arkalis.debugOptions).timezone) !== null && _b !== void 0 ? _b : (_e.timezone = (_d = (_c = process.env[`PROXY_TZ_${arkalis.scraperMeta.name.toUpperCase()}`]) !== null && _c !== void 0 ? _c : process.env["PROXY_TZ_DEFAULT"]) !== null && _d !== void 0 ? _d : null);
    arkalis.log(ansi_colors_1.default.magentaBright(`Using proxy server: ${node_url_1.default.parse(proxyUrl).host} ${arkalis.debugOptions.timezone !== null ? `(${arkalis.debugOptions.timezone})` : ""}`));
    const onAuthRequiredFunc = (client, authReq) => {
        if (authReq.authChallenge.source !== "Proxy")
            return;
        if (!proxyUrl)
            return;
        const auth = node_url_1.default.parse(proxyUrl).auth;
        void client.Fetch.continueWithAuth({
            requestId: authReq.requestId,
            authChallengeResponse: {
                response: "ProvideCredentials",
                username: auth.split(":")[0],
                password: auth.split(":")[1]
            }
        });
    };
    return { proxy: proxyUrl, onAuthRequired: onAuthRequiredFunc };
};
exports.arkalisProxy = arkalisProxy;
