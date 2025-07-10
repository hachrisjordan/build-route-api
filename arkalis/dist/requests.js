"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.arkalisRequests = void 0;
const ansi_colors_1 = __importDefault(require("ansi-colors"));
const glob_to_regexp_1 = __importDefault(require("glob-to-regexp"));
const arkalisRequests = (arkalis) => {
    const subscriptions = [];
    const requests = {};
    let lastResponseTime = Date.now();
    const initRequest = (requestId) => {
        if (!requests[requestId])
            requests[requestId] = { requestId: requestId, downloadedBytes: 0, success: false };
    };
    const responseEvent = (response) => {
        lastResponseTime = Date.now();
        initRequest(response.requestId);
        if (response.timestamp)
            requests[response.requestId].endTime = response.timestamp;
    };
    arkalis.client.Network.requestWillBeSent((request) => {
        initRequest(request.requestId);
        requests[request.requestId] = { ...requests[request.requestId], request: request.request, startTime: request.timestamp };
    });
    arkalis.client.Network.responseReceived((response) => {
        responseEvent(response);
        requests[response.requestId].response = response.response;
        if (!response.response.fromDiskCache)
            requests[response.requestId].downloadedBytes += response.response.encodedDataLength;
        requests[response.requestId].responseType = response.type;
    });
    arkalis.client.Network.dataReceived((response) => {
        responseEvent(response);
        requests[response.requestId].downloadedBytes += response.encodedDataLength;
    });
    arkalis.client.Network.loadingFinished((response) => {
        responseEvent(response);
        requests[response.requestId].success = true;
        void completedLoading(response.requestId);
    });
    arkalis.client.Network.loadingFailed((response) => {
        responseEvent(response);
        void completedLoading(response.requestId, response);
    });
    async function completedLoading(requestId, failedResponse) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
        const item = requests[requestId];
        if (!((_b = (_a = requests[requestId]) === null || _a === void 0 ? void 0 : _a.request) === null || _b === void 0 ? void 0 : _b.method))
            return;
        let status = ansi_colors_1.default.red("???");
        if ((_c = item.response) === null || _c === void 0 ? void 0 : _c.status) {
            status = ansi_colors_1.default[item.response.status >= 400 ? "red" : item.response.status >= 300 ? "yellow" : "green"](item.response.status.toString());
        }
        else if (failedResponse) {
            status = ansi_colors_1.default.red(failedResponse.blockedReason === "inspector" ? "BLK" : "ERR");
            if (failedResponse.blockedReason !== "inspector" && failedResponse.errorText !== "net::ERR_ABORTED")
                arkalis.log(ansi_colors_1.default.red(`Request failed with ${failedResponse.errorText}: ${(_e = (_d = item.request) === null || _d === void 0 ? void 0 : _d.url) !== null && _e !== void 0 ? _e : "(unknown url)"}`));
        }
        const urlToShow = item.request.url.startsWith("data:") ? `${item.request.url.slice(0, 80)}...` : item.request.url;
        const line = `${status} ` +
            `${((_f = item.response) === null || _f === void 0 ? void 0 : _f.fromDiskCache) ? ansi_colors_1.default.yellowBright("CACHE") : (Math.ceil(item.downloadedBytes / 1024).toString() + "kB").padStart(5, " ")} ` +
            `${(_h = (_g = item.request) === null || _g === void 0 ? void 0 : _g.method.padEnd(4, " ").slice(0, 4)) !== null && _h !== void 0 ? _h : "????"} ` +
            `${ansi_colors_1.default.white(urlToShow)} ` +
            `${ansi_colors_1.default.yellowBright((_m = (_k = (_j = item.response) === null || _j === void 0 ? void 0 : _j.headers["cache-control"]) !== null && _k !== void 0 ? _k : (_l = item.response) === null || _l === void 0 ? void 0 : _l.headers["Cache-Control"]) !== null && _m !== void 0 ? _m : "")}`;
        arkalis.debugOptions.showRequests && arkalis.log(line);
        // Skip loading a body since it's apparently an agressive call
        const skipBodyLoading = subscriptions.length === 0 ||
            ["Preflight", "Beacon", "Ping", "CSPViolationReport", "PluginResource", "Manifest"].includes((_o = item.responseType) !== null && _o !== void 0 ? _o : "") ||
            (Object.entries((_q = (_p = item.response) === null || _p === void 0 ? void 0 : _p.headers) !== null && _q !== void 0 ? _q : {}).some(([key, value]) => key.toLowerCase() === "content-length" && parseInt(value) === 0)) ||
            [101, 204, 205, 304].includes((_s = (_r = item.response) === null || _r === void 0 ? void 0 : _r.status) !== null && _s !== void 0 ? _s : 0) ||
            ["OPTIONS", "HEAD"].includes((_u = (_t = item.request) === null || _t === void 0 ? void 0 : _t.method) !== null && _u !== void 0 ? _u : "");
        item.body = skipBodyLoading ? undefined : (_v = (await arkalis.client.Network.getResponseBody({ requestId: requestId }).catch(() => undefined))) === null || _v === void 0 ? void 0 : _v.body;
        for (const subscription of subscriptions)
            await subscription(item);
    }
    return {
        stats: () => {
            const totRequests = Object.values(requests).length;
            const cacheHits = Object.values(requests).filter((request) => { var _a; return (_a = request.response) === null || _a === void 0 ? void 0 : _a.fromDiskCache; }).length;
            const cacheMisses = totRequests - cacheHits;
            const bytes = Object.values(requests).reduce((bytes, request) => (bytes += request.downloadedBytes), 0);
            const summary = `${totRequests.toLocaleString()} reqs, ${cacheHits.toLocaleString()} hits, ${cacheMisses.toLocaleString()} misses, ${bytes.toLocaleString()} bytes`;
            return { totRequests, cacheHits, cacheMisses, bytes, summary };
        },
        getLastResponseTime: () => lastResponseTime,
        subscribeToUrl: (url, onCompleted) => {
            const urlRegexp = typeof url === "string" ? (0, glob_to_regexp_1.default)(url, { extended: true }) : url;
            const removeSubscription = () => subscriptions.splice(subscriptions.indexOf(checkUrl), 1);
            const checkUrl = async (request) => {
                var _a;
                if (((_a = request.request) === null || _a === void 0 ? void 0 : _a.url) && urlRegexp.test(request.request.url) && request.body) { // we expect some data in the body
                    removeSubscription();
                    await onCompleted(request);
                }
            };
            subscriptions.push(checkUrl);
            return removeSubscription; // call to unsubscribe
        }
    };
};
exports.arkalisRequests = arkalisRequests;
