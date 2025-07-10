"use strict";
// TODO: net log gets cut off if the browser isn't closed properly
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.arkalisHar = void 0;
const promises_1 = require("fs/promises");
const ansi_colors_1 = __importDefault(require("ansi-colors"));
const PHASE_NONE = 0;
const PHASE_BEGIN = 1;
const PHASE_END = 2;
const arkalisHar = (arkalis) => {
    return {
        async saveHar() {
            var _a, _b, _c, _d, _e, _f;
            const netlog = await (0, promises_1.readFile)("./tmp/netlog-aa-cached.json");
            const nl = JSON.parse(netlog.toString());
            const eventsBySid = nl.events.reduce((acc, event) => {
                if (acc[event.source.id] === undefined)
                    acc[event.source.id] = [];
                acc[event.source.id].push(event);
                return acc;
            }, {});
            const timePlus = (offset) => (new Date(nl.constants.timeTickOffset + (typeof offset === "number" ? offset : parseInt(offset)))).toISOString();
            const getEvents = (events, type, phase) => {
                return events.filter(e => e.type === nl.constants.logEventTypes[type] && (phase ? e.phase === phase : true));
            };
            const constLookup = (constType, value) => Object.keys(constType).find(k => constType[k] === value);
            const entries = [];
            for (const [_sid, events] of Object.entries(eventsBySid)) {
                try {
                    const urlRequestEvs = getEvents(events, "URL_REQUEST_START_JOB");
                    if (urlRequestEvs.length === 0)
                        continue;
                    const urlRequestBeginEv = urlRequestEvs.find(e => e.phase === PHASE_BEGIN);
                    if (!urlRequestBeginEv) {
                        arkalis.warn("  missing URL_REQUEST_START_JOB PHASE_BEGIN, skipping");
                        continue;
                    }
                    const url = urlRequestBeginEv.params.url;
                    const sid = urlRequestBeginEv.source.id;
                    arkalis.log("processing source", sid, url);
                    const urlRequestEndEv = urlRequestEvs.find(e => e.phase === PHASE_END);
                    if (!urlRequestEndEv) {
                        arkalis.warn("  TODO: incomplete request");
                        continue;
                    }
                    if ((_a = urlRequestEndEv.params) === null || _a === void 0 ? void 0 : _a.net_error) {
                        arkalis.warn("  TODO: this is a failed request", constLookup(nl.constants.netError, urlRequestEndEv.params.net_error));
                        continue;
                    }
                    const responseBytesReadEv = getEvents(events, "URL_REQUEST_JOB_FILTERED_BYTES_READ"); // Applies to cached responses too
                    const responseStr = responseBytesReadEv.reduce((acc, ev) => acc + Buffer.from(ev.params.bytes, "base64").toString(), "");
                    const cacheEv = getEvents(events, "HTTP_CACHE_READ_DATA");
                    const isCached = cacheEv.length > 0;
                    let responseHeadersLines;
                    let requestHeadersLines;
                    let requestHttpLine = undefined;
                    let isHttp2 = false;
                    let postData = "";
                    if (isCached) {
                        arkalis.log("  this is a cached response. no headers will be available.");
                        const urlParts = url.split("/");
                        requestHttpLine = `GET /${urlParts[urlParts.length - 1]} HTTP/1.1`; // TODO: this
                        requestHeadersLines = ["User-Agent: CACHE"]; // TODO: this
                        responseHeadersLines = ["HTTP/1.1 200 OK", "Server: CACHE", "Content-Type: "]; // TODO: this
                    }
                    else {
                        // *** Request ***
                        const requestHeadersEv = getEvents(events, "HTTP_TRANSACTION_SEND_REQUEST_HEADERS", PHASE_NONE);
                        if (requestHeadersEv.length > 0) {
                            requestHeadersLines = requestHeadersEv[0].params.headers;
                            requestHttpLine = requestHeadersEv[0].params.line;
                            // TODO: post data for HTTP1
                        }
                        else {
                            // Try HTTP2 request headers
                            const requestHeadersHttp2Ev = getEvents(events, "HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS", PHASE_NONE);
                            if (requestHeadersHttp2Ev.length > 0) {
                                isHttp2 = true;
                                requestHeadersLines = requestHeadersHttp2Ev[0].params.headers;
                                const postDataEv = getEvents(events, "HTTP2_STREAM_UPDATE_SEND_WINDOW", PHASE_NONE);
                                if (postDataEv.length > 0) {
                                    if (postDataEv[0].params.delta < 0) {
                                        arkalis.log("  http2 post data of", -postDataEv[0].params.delta, "bytes incoming");
                                        const sslDataEv = getEvents(nl.events, "SSL_SOCKET_BYTES_SENT", PHASE_NONE);
                                        const sslData = sslDataEv.find(e => { var _a; return e.time === postDataEv[0].time && ((_a = e.params) === null || _a === void 0 ? void 0 : _a.byte_count) === -postDataEv[0].params.delta + 9; }); // 9 bytes of header
                                        if (sslData) {
                                            const postDataWithHeader = Buffer.from(sslData.params.bytes, "base64").toString();
                                            postData = postDataWithHeader.substring(9);
                                        }
                                        else {
                                            arkalis.warn("  WARN: couldnt find request post data SSL_SOCKET_BYTES_SENT event, assuming no post data");
                                        }
                                    }
                                }
                            }
                            else {
                                arkalis.warn("  TODO: missing request headers");
                                continue;
                            }
                        }
                        // *** Response ***
                        const responseHeadersEv = getEvents(events, "HTTP_TRANSACTION_READ_RESPONSE_HEADERS", PHASE_NONE);
                        if (responseHeadersEv.length === 0) {
                            arkalis.warn("  TODO: missing response headers");
                            continue;
                        }
                        responseHeadersLines = responseHeadersEv[0].params.headers;
                    }
                    const requestHeaders = requestHeadersLines.map(h => {
                        const groups = /^(?<name>.*?): (?<value>.*)$/u.exec(h).groups;
                        return { name: groups["name"], value: groups["value"] };
                    });
                    const postContentType = (_b = requestHeaders.find(h => h.name.toUpperCase() === "CONTENT-TYPE")) === null || _b === void 0 ? void 0 : _b.value;
                    // http1: "HTTP/1.1 200 OK", http2: "HTTP/1.1 200"
                    const responseStatus = /^(?<httpVersion>\S+) (?<status>\S+)(?: (?<statusText>.+)$|$)/u.exec(responseHeadersLines[0]).groups;
                    const responseHeaders = responseHeadersLines.slice(1).map(h => {
                        const groups = /^(?<name>.*?): (?<value>.*)$/u.exec(h).groups;
                        return { name: groups["name"], value: groups["value"] };
                    });
                    // really naive implementation for if to cache or not
                    const willCache = isCached || (responseHeaders.find(h => h.name.toUpperCase() === "CACHE-CONTROL" && !h.value.toUpperCase().includes("MAX-AGE=0") && !h.value.toUpperCase().includes("NO-CACHE") && !h.value.toUpperCase().includes("NO-STORE")));
                    const entry = {
                        pageref: undefined, // unnecessary
                        startedDateTime: timePlus(urlRequestBeginEv.time),
                        time: parseInt(urlRequestEndEv.time) - parseInt(urlRequestBeginEv.time),
                        request: {
                            method: urlRequestBeginEv.params.method,
                            url: urlRequestBeginEv.params.url,
                            httpVersion: isHttp2 ? "HTTP/2.0" : requestHttpLine.split(" ")[2].replace("\r\n", ""),
                            cookies: undefined, // TODO
                            headers: requestHeaders,
                            queryString: url.split("?").length > 1 ? url.split("?")[1].split("&").map(p => {
                                const [name, value] = p.split("=");
                                return { name: name !== null && name !== void 0 ? name : "", value: value !== null && value !== void 0 ? value : "" };
                            }) : undefined,
                            headersSize: (isHttp2 ? 0 : requestHttpLine.length + 2) + requestHeadersLines.join("\r\n").length + 2 + 2, // 2 for each \r\n, 2 for the final \r\n
                            bodySize: postData.length,
                            postData: postData && postContentType ? {
                                mimeType: postContentType,
                                params: postContentType === "application/x-www-form-urlencoded" ? postData.split("&").map(p => {
                                    const [name, value] = p.split("=");
                                    return { name: name !== null && name !== void 0 ? name : "", value: value !== null && value !== void 0 ? value : "" };
                                }) : undefined,
                                text: postContentType !== "application/x-www-form-urlencoded" ? postData : undefined
                            } : undefined
                        },
                        response: {
                            status: parseInt(responseStatus.status),
                            statusText: isHttp2 ? "" : responseStatus.statusText,
                            httpVersion: responseStatus.httpVersion,
                            cookies: undefined, // TODO
                            headers: responseHeaders,
                            content: {
                                size: responseStr.length,
                                compression: undefined, // TODO
                                mimeType: (_d = (_c = responseHeaders.find(h => h.name.toUpperCase() === "CONTENT-TYPE")) === null || _c === void 0 ? void 0 : _c.value) !== null && _d !== void 0 ? _d : undefined,
                                text: responseStr,
                                encoding: undefined // plaintext
                            },
                            redirectURL: (_f = (_e = responseHeaders.find(h => h.name.toUpperCase() === "LOCATION")) === null || _e === void 0 ? void 0 : _e.value) !== null && _f !== void 0 ? _f : "",
                            headersSize: responseHeadersLines.join("\r\n").length + 2 + 2, // 2 for each \r\n, 2 for the final \r\n
                            bodySize: isCached ? 0 : responseStr.length,
                        },
                        cache: {
                            beforeRequest: isCached ? {
                                lastAccess: timePlus(urlRequestBeginEv.time), // just use the date now
                                eTag: "", // unnecessary
                                hitCount: 0, // unnecessary
                                comment: "request was in cache"
                            } : undefined,
                            afterRequest: willCache ? {
                                lastAccess: timePlus(urlRequestBeginEv.time), // just use the date now
                                eTag: "", // unnecessary
                                hitCount: 0, // unnecessary
                                comment: "browser will likely cache"
                            } : undefined,
                        },
                        timings: {
                            blocked: undefined, // TODO
                            dns: undefined, // TODO
                            connect: undefined, // TODO
                            send: undefined, // TODO
                            wait: undefined, // TODO
                            receive: undefined, // TODO
                            ssl: undefined // TODO
                        },
                        serverIPAddress: undefined, // unnecessary
                        connection: undefined, // TODO
                    };
                    entries.push(entry);
                    arkalis.log(`  ${ansi_colors_1.default.greenBright("done")}`);
                }
                catch (err) {
                    arkalis.log("  error processing source", err);
                    continue;
                }
            }
            const har = {
                log: {
                    version: "0.1",
                    creator: { name: "Arkalis", version: "0.1" },
                    browser: { name: nl.constants.clientInfo.name, version: nl.constants.clientInfo.version, comment: nl.constants.clientInfo.os_type },
                    pages: undefined, // TODO
                    entries: entries
                }
            };
            await (0, promises_1.writeFile)("./tmp/last-arkalis-run.har", JSON.stringify(har, null, 2));
        }
    };
};
exports.arkalisHar = arkalisHar;
