"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.arkalisInteraction = void 0;
const bezier_js_1 = require("bezier-js");
const arkalisInteraction = (arkalis) => {
    let viewPortSizeMemo;
    const getViewportSize = async () => viewPortSizeMemo !== null && viewPortSizeMemo !== void 0 ? viewPortSizeMemo : (viewPortSizeMemo = await (async () => {
        const layoutMetrics = await arkalis.client.Page.getLayoutMetrics();
        return [layoutMetrics.layoutViewport.clientWidth, layoutMetrics.layoutViewport.clientHeight];
    })());
    let curMousePosMemo;
    const getCurMousePos = async () => curMousePosMemo !== null && curMousePosMemo !== void 0 ? curMousePosMemo : (curMousePosMemo = [Math.random() * (await getViewportSize())[0], 0]);
    async function getBoxForSelector(selector) {
        const doc = await arkalis.client.DOM.getDocument({ depth: -1 });
        const node = await arkalis.client.DOM.querySelector({ nodeId: doc.root.nodeId, selector });
        if (!node.nodeId)
            throw new Error("couldnt get button");
        return arkalis.client.DOM.getBoxModel({ nodeId: node.nodeId });
    }
    async function genPath(start, end) {
        const EXTRA_BEZIER_POINTS = Math.floor(Math.random() * 2) + 1;
        const TOTAL_POINTS = 80 + Math.floor(Math.random() * 20);
        const OVERSHOOT = 20 + (Math.random() * 10);
        const viewportSize = await getViewportSize();
        if (start[0] > viewportSize[0] || start[1] > viewportSize[1] ||
            end[0] > viewportSize[0] || end[1] > viewportSize[1])
            throw new Error("start or end point of area to click is outside of viewport");
        // Get the curve (using general method from https://github.com/Xetera/ghost-cursor)
        const bezier = new bezier_js_1.Bezier([
            { x: start[0], y: start[1] },
            ...Array(EXTRA_BEZIER_POINTS).fill(0).map(() => ({
                x: Math.random() * (end[0] - start[0]) + start[0],
                y: Math.random() * (end[1] - start[1]) + start[1]
            })),
            { x: end[0], y: end[1] }
        ]);
        // Apply the easing function as per https://incolumitas.com/2021/05/20/avoid-puppeteer-and-playwright-for-scraping/.
        // For more on the function, see https://easings.net/#easeOutElastic
        const c4 = (2 * Math.PI) / 3;
        return Array(TOTAL_POINTS).fill(0).map((_, i) => {
            const t = i / TOTAL_POINTS + (Math.random() * (1 / TOTAL_POINTS) * 0.5); // apply some jitter to which time we use
            const easedT = t === 0 || t === 1 ? t : Math.pow(2, -OVERSHOOT * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
            return bezier.get(easedT);
        });
    }
    async function plotPath(path) {
        const viewportSize = await getViewportSize();
        await arkalis.client.Runtime.evaluate({ expression: `(() => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "${viewportSize[0]}");
      svg.setAttribute("height", "${viewportSize[1]}");
      svg.setAttribute("style", "position: fixed; top: 0; left: 0; z-index: 10000; pointer-events: none;");
      svg.innerHTML = \`${path.map((point, i) => {
                const color = i === path.length - 1 ? "red" : "lightgreen";
                return `<circle cx="${point.x}" cy="${point.y}" r="3" fill="${color}" stroke="black"  />`;
            }).join("\n")}\`
      document.body.appendChild(svg);
    })()` });
    }
    async function moveMouseTo(pos) {
        const path = await genPath(await getCurMousePos(), pos);
        if (arkalis.debugOptions.drawMousePath)
            void plotPath(path);
        const lastTime = 0;
        for (const [i, point] of path.entries()) {
            await arkalis.wait(path[i].t - lastTime);
            await arkalis.client.Input.dispatchMouseEvent({ type: "mouseMoved", x: point.x, y: point.y });
        }
        curMousePosMemo = pos;
    }
    return {
        clickSelector: async (selector) => {
            await arkalis.wait(Math.random() * 100);
            const box = await getBoxForSelector(selector);
            const boxContent = box.model.content;
            const point = [(boxContent[2] - boxContent[0]) * Math.random() + boxContent[0],
                (boxContent[5] - boxContent[1]) * Math.random() + boxContent[1]];
            await moveMouseTo(point);
            await arkalis.wait(Math.random() * 100 + 50);
            await arkalis.client.Input.dispatchMouseEvent({ type: "mousePressed", x: point[0], y: point[1], button: "left", clickCount: 1 });
            await arkalis.wait(Math.random() * 100 + 50);
            await arkalis.client.Input.dispatchMouseEvent({ type: "mouseReleased", x: point[0], y: point[1], button: "left", clickCount: 1 });
        }
    };
};
exports.arkalisInteraction = arkalisInteraction;
