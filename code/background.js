// ---------------------------------------------------------
//   CYBERPUNK NETWORK VISUALIZER - BACKGROUND (Manifest V3)
//   Fully Patched For chrome.debugger + MV3 Keep-Alive
// ---------------------------------------------------------

// ---------------------------
//  KEEP SERVICE WORKER ALIVE
// ---------------------------
chrome.runtime.onConnect.addListener(port => {
    if (port.name === "keepAlive") {
        port.onMessage.addListener(() => {
            // Prevent worker shutdown
        });
    }
});

// Extra MV3 keep-alive workaround
self.onmessage = () => {};


// ---------------------------
//      GLOBAL STATE
// ---------------------------

let debuggee = null;
let monitoredOrigin = "";        // domain being monitored
let activeRequestCount = 0;
const reqStore = {};             // requestId → metadata storage



// ---------------------------
//   LISTEN FOR START/STOP
// ---------------------------
chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.command === "start") {
        startMonitoring(msg.targetTabId, msg.tabTitle);
    }
    if (msg.command === "stop") {
        stopMonitoring();
    }
});



// ---------------------------------------------------------
//                    START MONITORING
// ---------------------------------------------------------
function startMonitoring(tabId, tabTitle) {
    console.log("%c[DEBUG] START RECEIVED → attaching debugger", "color:#0ff");

    // If already attached → detach first
    if (debuggee) {
        chrome.debugger.detach(debuggee, () => startMonitoring(tabId, tabTitle));
        return;
    }

    chrome.tabs.get(tabId, (tab) => {
        // Capture origin domain
        try {
            monitoredOrigin = new URL(tab.url).hostname.replace(/^www\./, "");
        } catch {
            monitoredOrigin = "";
        }

        debuggee = { tabId };

        // Attach debugger
        chrome.debugger.attach(debuggee, "1.3", () => {
            if (chrome.runtime.lastError) {
                console.error("Attach failed:", chrome.runtime.lastError.message);
                stopMonitoring();
                return;
            }

            console.log("%c[DEBUG] Debugger attached", "color:#0f0");

            // Enable Network domain
            chrome.debugger.sendCommand(debuggee, "Network.enable", {}, () => {
                if (chrome.runtime.lastError) {
                    console.error("Network.enable failed:", chrome.runtime.lastError.message);
                    stopMonitoring();
                    return;
                }

                console.log("%c[DEBUG] Network enabled", "color:#0f0");

                chrome.storage.local.set({
                    isMonitoring: true,
                    monitoringTabTitle: tabTitle,
                    monitoringOrigin: monitoredOrigin
                });

                // Tell dashboard to clear old data
                sendToDashboard({ type: "CLEAR" });
            });
        });
    });
}



// ---------------------------------------------------------
//                      STOP MONITORING
// ---------------------------------------------------------
function stopMonitoring() {
    console.log("%c[DEBUG] STOP", "color:#f00");

    if (!debuggee) return;

    chrome.debugger.detach(debuggee, () => {
        debuggee = null;
        activeRequestCount = 0;

        chrome.storage.local.set({
            isMonitoring: false,
            monitoringTabTitle: "",
            monitoringOrigin: ""
        });
    });
}



// ---------------------------------------------------------
//                NETWORK EVENT LISTENERS
// ---------------------------------------------------------
chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!debuggee || source.tabId !== debuggee.tabId) return;

    switch (method) {
        case "Network.requestWillBeSent":
            onRequestStart(params);
            break;

        case "Network.responseReceived":
            onResponseMeta(params);
            break;

        case "Network.loadingFinished":
            onRequestFinished(params);
            break;

        case "Network.loadingFailed":
            onRequestFailed(params);
            break;
    }
});



// ---------------------------------------------------------
//                HANDLER: REQUEST START
// ---------------------------------------------------------
function onRequestStart(p) {
    activeRequestCount++;
    sendToDashboard({
        type: "ACTIVE_COUNT",
        data: { activeRequestCount }
    });

    reqStore[p.requestId] = {
        url: p.request.url,
        method: p.request.method,
        startTime: p.timestamp,
        redirectChain: []
    };

    // Log redirect
    if (p.redirectResponse) {
        reqStore[p.requestId].redirectChain.push({
            url: p.redirectResponse.url,
            status: p.redirectResponse.status
        });
    }
}



// ---------------------------------------------------------
//            HANDLER: RESPONSE METADATA
// ---------------------------------------------------------
function onResponseMeta(p) {
    if (!reqStore[p.requestId]) return;

    reqStore[p.requestId].response = {
        status: p.response.status,
        mimeType: p.response.mimeType,
        protocol: p.response.protocol,
        fromDiskCache: p.response.fromDiskCache,
        fromServiceWorker: p.response.fromServiceWorker
    };
}



// ---------------------------------------------------------
//              HANDLER: REQUEST FINISHED
// ---------------------------------------------------------
function onRequestFinished(p) {
    const info = reqStore[p.requestId];
    if (!info) return;

    const finishTime = p.timestamp;
    const durationMs = Math.round((finishTime - info.startTime) * 1000);

    const domain = getDomain(info.url);
    const firstParty = domain === monitoredOrigin;

    const data = {
        domain,
        fullUrl: info.url,
        method: info.method,
        status: info.response?.status || 0,
        type: info.response?.mimeType || "unknown",
        protocol: info.response?.protocol || "unknown",
        durationMs,
        bytes: p.encodedDataLength || 0,
        redirectChain: info.redirectChain,
        firstParty,
        activeRequestCount
    };

    sendToDashboard({ type: "DATA", data });

    delete reqStore[p.requestId];
    activeRequestCount--;
}



// ---------------------------------------------------------
//               HANDLER: REQUEST FAILED
// ---------------------------------------------------------
function onRequestFailed(p) {
    const info = reqStore[p.requestId] || {};
    const domain = getDomain(info.url || "");

    sendToDashboard({
        type: "FAILED",
        data: {
            domain,
            fullUrl: info.url || "",
            method: info.method || "GET",
            errorText: p.errorText || "Failed",
            firstParty: domain === monitoredOrigin
        }
    });

    delete reqStore[p.requestId];
    activeRequestCount--;
}



// ---------------------------------------------------------
//                     UTILITY FUNCTIONS
// ---------------------------------------------------------
function getDomain(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}


// ---------------------------------------------------------
//               SEND MESSAGE TO DASHBOARD
// ---------------------------------------------------------
async function sendToDashboard(obj) {
    try {
        const dashboardUrl = chrome.runtime.getURL("dashboard.html");
        const tabs = await chrome.tabs.query({ url: dashboardUrl });

        if (tabs.length === 0) return;

        chrome.tabs.sendMessage(tabs[0].id, obj, () => {
            if (chrome.runtime.lastError) {
                console.warn("Dashboard not available:", chrome.runtime.lastError.message);
            }
        });
    } catch (e) {
        console.warn("sendToDashboard error:", e);
    }
}

