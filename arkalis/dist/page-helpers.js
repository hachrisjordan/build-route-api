"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.arkalisPageHelpers = void 0;
const glob_to_regexp_1 = __importDefault(require("glob-to-regexp"));
const arkalisPageHelpers = (arkalis) => {
    const getLastResponseTime = arkalis.getLastResponseTime;
    return {
        /** Navigates to the specified URL and returns immediately
         * @param gotoUrl - the url to navigate to */
        goto: (gotoUrl) => {
            arkalis.log(`navigating to ${gotoUrl}`);
            void arkalis.client.Page.navigate({ url: gotoUrl });
        },
        getSelectorContent: async (selector) => {
            const result = await arkalis.client.Runtime.evaluate({ expression: `document.querySelector("${selector}")?.textContent`, returnByValue: true });
            return result.result.value;
        },
        evaluate: async (expression) => {
            const result = await arkalis.client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
            return result.result.value;
        },
        /** Waits for a url to be loaded or specific html to be present
         * @param items - a map of name to url/html to wait for. when waiting for a url, optionally passing a `statusCode`
         * will wait only trigger on that http status code, unless the expected code is 200 in which case the request will be
         * validated */
        waitFor: async (items) => {
            const subscriptions = [];
            const pollingTimers = [];
            let timeout;
            try {
                const promises = Object.entries(items).map(async ([name, params]) => {
                    switch (params.type) {
                        case "url":
                            return new Promise((resolve, reject) => {
                                // eslint-disable-next-line @typescript-eslint/require-await
                                subscriptions.push(arkalis.subscribeToUrl(params.url, async (completedRequest) => {
                                    const responseObj = { ...completedRequest.response, body: completedRequest.body };
                                    if (params.onlyStatusCode && responseObj.status !== params.onlyStatusCode) {
                                        if (params.othersThrow)
                                            reject(new Error(`Expected status code ${params.onlyStatusCode} but got ${responseObj.status} for ${params.url.toString()}`));
                                        return;
                                    }
                                    resolve({ name, response: responseObj });
                                }));
                            });
                        case "html":
                            return new Promise((resolve, reject) => {
                                const htmlRegexp = typeof params.html === "string" ? (0, glob_to_regexp_1.default)(params.html, { extended: true, flags: "ugm" }) : params.html;
                                // eslint-disable-next-line no-restricted-globals
                                pollingTimers.push(setInterval(async () => {
                                    const evalResult = await arkalis.client.Runtime.evaluate({ expression: "document.documentElement.outerHTML", returnByValue: true }).catch((e) => { reject(e); return undefined; });
                                    if (!evalResult)
                                        return;
                                    const text = evalResult.result.value;
                                    if (htmlRegexp.test(text))
                                        resolve({ name });
                                }, 1000));
                            });
                        case "selector":
                            return new Promise((resolve, reject) => {
                                // eslint-disable-next-line no-restricted-globals
                                pollingTimers.push(setInterval(async () => {
                                    const doc = await arkalis.client.DOM.getDocument({ depth: -1 });
                                    const node = await arkalis.client.DOM.querySelector({ nodeId: doc.root.nodeId, selector: params.selector });
                                    if (node.nodeId)
                                        resolve({ name });
                                }, 1000));
                            });
                    }
                });
                promises.push(new Promise((resolve) => {
                    /* eslint-disable no-restricted-globals */
                    // We use a timeout since the last response received (not since the timer started) as a way of detecting if
                    // the socket is no longer functional
                    const timeoutHandler = () => {
                        if (Date.now() - getLastResponseTime() >= arkalis.scraperMeta.defaultTimeoutMs) {
                            resolve({ name: "timeout" });
                        }
                        else {
                            timeout = setTimeout(() => timeoutHandler(), arkalis.scraperMeta.defaultTimeoutMs - (Date.now() - getLastResponseTime()));
                        }
                    };
                    timeout = setTimeout(() => timeoutHandler(), arkalis.scraperMeta.defaultTimeoutMs);
                    /* eslint-enable no-restricted-globals */
                }));
                const result = await Promise.race(promises);
                if (result.name === "timeout")
                    throw new Error(`Timeout waiting for items (${arkalis.scraperMeta.defaultTimeoutMs} ms})`);
                return result;
            }
            finally {
                for (const unsub of subscriptions)
                    unsub();
                for (const timer of pollingTimers)
                    clearInterval(timer);
                if (timeout)
                    clearTimeout(timeout);
            }
        }
    };
};
exports.arkalisPageHelpers = arkalisPageHelpers;
