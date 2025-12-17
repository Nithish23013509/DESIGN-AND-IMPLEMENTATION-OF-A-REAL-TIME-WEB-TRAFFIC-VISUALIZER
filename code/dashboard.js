document.addEventListener("DOMContentLoaded", () => {

    // Attach Stat Click Events
    document.getElementById("fp-count").addEventListener("click", () => {
        showDomainListModal(false);
    });

    document.getElementById("tp-count").addEventListener("click", () => {
        showDomainListModal(true);
    });

    document.getElementById("active-count").addEventListener("click", () => {
        showActiveRequestsModal();
    });

});
// ------------------------------------------------------
// KEEP SERVICE WORKER ALIVE (MV3 required)
document.addEventListener("DOMContentLoaded", () => {

    // First-party click → show modal listing FP domains
    document.getElementById("fp-count").parentElement.addEventListener("click", () => {
        showAllDomainsModal(false); // false = first-party
    });

    // Third-party click → show modal listing TP domains
    document.getElementById("tp-count").parentElement.addEventListener("click", () => {
        showAllDomainsModal(true); // true = third-party
    });
});

const keepAlivePort = chrome.runtime.connect({ name: "keepAlive" });
setInterval(() => {
    try { keepAlivePort.postMessage({ ping: true }); }
    catch (e) {}
}, 20000);

// ------------------------------------------------------
// D3 DONUT SETUP
const svg = d3.select("svg");
const width = +svg.attr("width") || 420;
const height = +svg.attr("height") || 420;
const radius = Math.min(width, height) / 2;

const g = svg.append("g")
    .attr("transform", `translate(${width / 2},${height / 2})`);

const color = d3.scaleOrdinal([
    "#66c2a5", "#fc8d62", "#8da0cb",
    "#e78ac3", "#ffd92f", "#a6d854", "#b3b3ff"
]);

const pie = d3.pie().sort(null).value(d => d.value.size);
const pathArc = d3.arc().outerRadius(radius - 10).innerRadius(radius / 2.2);
const labelArc = d3.arc().outerRadius(radius - 60).innerRadius(radius - 60);

// ------------------------------------------------------
// DOM Elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');

const liveStreamEl = document.getElementById('live-stream');
const activeCountEl = document.getElementById('active-count');
const fpCountEl = document.getElementById('fp-count');
const tpCountEl = document.getElementById('tp-count');

const recentRequestsEl = document.getElementById('recent-requests');
const topDomainsEl = document.getElementById('top-domains');

const latencyStatsEl = document.getElementById('latency-stats');
const bandwidthStatsEl = document.getElementById('bandwidth-stats');

const legendEl = document.getElementById('legend');

// ------------------------------------------------------
// STATE
let categoryData = {};         // { category: Map(domain -> [requests]) }
let domainStats = new Map();   // domain → stats object
let recentRequests = [];
const MAX_RECENT = 150;

let firstPartyCount = 0;
let thirdPartyCount = 0;

// ------------------------------------------------------
// Categorization Logic
const TRACKER_RE = /(analytics|pixel|track|collect|doubleclick|ads|adservice|googlesyndication|googletagmanager|facebook|google-analytics)/i;

function categorizeDomain(domain) {
    if (!domain) return "Other";

    if (TRACKER_RE.test(domain)) {
        if (/analytics|googletagmanager/i.test(domain)) return "Analytics";
        return "Advertising";
    }

    if (/\.googlevideo\.com$/.test(domain)) return "Video Content";
    if (/\.ytimg\.com$|\.ggpht\.com$/.test(domain)) return "Image Content";
    if (/\.gstatic\.com$|\.cloudfront\.net$|\.akamaized\.net$/.test(domain)) return "CDN";
    if (/\.googleapis\.com$/.test(domain)) return "Google API";
    if (domain.includes("google")) return "Google Service";

    return "Other";
}

// ------------------------------------------------------
// Live Stream UI
function addToLiveStream(d) {
    if (!liveStreamEl) return;

    const line = document.createElement("div");
    line.className = "stream-line";

    const statusClass =
        typeof d.status === "number"
            ? d.status >= 500 ? "err" : d.status >= 400 ? "warn" : "ok"
            : "warn";

    const sizeKB = d.bytes ? `${Math.round(d.bytes / 1024)}KB` : "—";
    const dur = d.durationMs ? `${d.durationMs}ms` : "";

    line.innerHTML = `
        <span class="stream-domain">${escapeHtml(d.domain || "unknown")}</span>
        <span class="stream-method">${escapeHtml(d.method || "")}</span>
        <span class="stream-status ${statusClass}">${escapeHtml(d.status || "—")}</span>
        <small class="stream-meta">${escapeHtml(d.type || "")} ${sizeKB} ${dur}</small>
    `;

    liveStreamEl.appendChild(line);

    while (liveStreamEl.children.length > 400)
        liveStreamEl.removeChild(liveStreamEl.firstChild);

    liveStreamEl.scrollTop = liveStreamEl.scrollHeight;
}

// ------------------------------------------------------
// Recent Requests Panel
function addRecentRequest(d) {
    recentRequests.unshift(d);
    if (recentRequests.length > MAX_RECENT) recentRequests.pop();
    renderRecentRequests();
}

function renderRecentRequests() {
    recentRequestsEl.innerHTML = "";
    for (let r of recentRequests.slice(0, MAX_RECENT)) {
        const div = document.createElement("div");
        div.className = "stream-line";

        div.innerHTML = `
            <strong>${escapeHtml(r.domain)}</strong>
            <small>${escapeHtml(r.method)} ${escapeHtml(r.status)}</small>
            <div class="stream-meta">${escapeHtml(r.fullUrl || "")}</div>
        `;

        recentRequestsEl.appendChild(div);
    }
}

// ------------------------------------------------------
// TOP DOMAINS
function updateTopDomains() {
    const arr = Array.from(domainStats.entries()).map(([domain, s]) => ({
        domain,
        count: s.count,
        avgLatency: Math.round(s.totalDurationMs / Math.max(1, s.count)),
        totalBytes: s.totalBytes
    }));

    arr.sort((a, b) => b.count - a.count);

    topDomainsEl.innerHTML = "";

    arr.slice(0, 12).forEach(item => {
        const row = document.createElement("div");
        row.className = "domain-row";

        row.innerHTML = `
            <div>
                <strong>${item.domain}</strong>
                <div class="sub">
                    avg ${item.avgLatency}ms • ${Math.round(item.totalBytes / 1024)}KB
                </div>
            </div>
            <div class="count">${item.count}</div>
        `;

        topDomainsEl.appendChild(row);
    });

    const avgLatency = arr.length ?
        Math.round(arr.reduce((s, i) => s + i.avgLatency, 0) / arr.length) : 0;

    const totalBytes = arr.reduce((s, i) => s + i.totalBytes, 0);

    latencyStatsEl.textContent = avgLatency ? `${avgLatency} ms` : "—";
    bandwidthStatsEl.textContent = totalBytes ? `${Math.round(totalBytes / 1024)} KB` : "—";
}

// ------------------------------------------------------
// Donut Chart Update
function updateChart() {
    const data_ready = Object.entries(categoryData).map(([key, map]) => ({
        key,
        value: { size: map.size }
    }));

    if (data_ready.length === 0) {
        g.selectAll(".arc").remove();
        return;
    }

    const arc = g.selectAll(".arc").data(pie(data_ready), d => d.data.key);

    arc.exit().remove();

    const arcEnter = arc.enter()
        .append("g")
        .attr("class", "arc");

    arcEnter.append("path")
        .on("click", d => showCategoryDetails(d.data.key));

    arcEnter.append("text")
        .attr("class", "slice-label")
        .attr("dy", "0.35em");

    const merged = arcEnter.merge(arc);

    merged.select("path")
        .attr("fill", d => color(d.data.key))
        .style("stroke", "#31f0ff")
        .style("stroke-width", "2px")
        .transition()
        .duration(700)
        .attrTween("d", function (d) {
            const i = d3.interpolate(this._current || { startAngle: 0, endAngle: 0 }, d);
            this._current = i(1);
            return t => pathArc(i(t));
        });

    merged.select("text")
        .text(d => d.data.value.size ? d.data.key : "")
        .transition()
        .duration(700)
        .attr("transform", d => `translate(${labelArc.centroid(d)})`);

    if (legendEl) {
        legendEl.innerHTML = "";
        data_ready
            .sort((a, b) => b.value.size - a.value.size)
            .forEach(item => {
                const li = document.createElement("div");
                li.className = "legend-item";

                li.innerHTML = `
                    <div class="legend-color" style="background:${color(item.key)}"></div>
                    <div class="legend-label">${item.key}</div>
                    <div class="legend-count">${item.value.size}</div>
                `;

                legendEl.appendChild(li);
            });
    }
}

// ------------------------------------------------------
// STEP 3A — CATEGORY MODAL
function showCategoryDetails(category) {
    const map = categoryData[category];
    if (!map) return;

    const modal = document.getElementById("category-modal");
    const title = document.getElementById("category-title");
    const domainList = document.getElementById("category-domain-list");
    const closeBtn = document.getElementById("category-close");

    title.textContent = `Domains in "${category}"`;
    domainList.innerHTML = "";

    const domains = Array.from(map.keys()).sort();

    domains.forEach(domain => {
        const count = map.get(domain).length;

        const div = document.createElement("div");
        div.innerHTML = `
            <strong>${domain}</strong>
            <small>(${count} requests)</small>
        `;

        div.addEventListener("click", () => {
            showDomainRequests(domain, map.get(domain));
        });

        domainList.appendChild(div);
    });

    modal.style.display = "block";
    closeBtn.onclick = () => modal.style.display = "none";
    modal.onclick = e => { if (e.target === modal) modal.style.display = "none"; };
}

// ------------------------------------------------------
// STEP 3B — DOMAIN REQUEST DETAIL MODAL
function showDomainRequests(domain, requests) {
    const modal = document.getElementById("request-modal");
    const title = document.getElementById("request-domain-title");
    const trackerStatus = document.getElementById("tracker-status");
    const detailsContainer = document.getElementById("request-details");
    const closeBtn = document.getElementById("request-close");

    title.textContent = domain;
    detailsContainer.innerHTML = "";

    const isTracker = TRACKER_RE.test(domain);

    trackerStatus.innerHTML = `
        <strong>Tracker Status:</strong>
        <span class="${isTracker ? "tracker-bad" : "tracker-good"}">
            ${isTracker ? "Known Tracker / Advertiser" : "Not a known tracker"}
        </span>
    `;

    requests.forEach(req => {
        const div = document.createElement("div");

        div.innerHTML = `
            <p><strong>URL:</strong> ${escapeHtml(req.fullUrl)}</p>
            <p><strong>Method:</strong> ${req.method}</p>
            <p><strong>Status:</strong>
                <span style="color:${req.status >= 400 ? "#ff5f6d" : "#7CFF7C"}">
                    ${req.status}
                </span>
            </p>
            <p><strong>Type:</strong> ${escapeHtml(req.type || "N/A")}</p>
            <p><strong>Bytes:</strong> ${req.bytes || 0}</p>
            <p><strong>Latency:</strong> ${req.durationMs || 0} ms</p>
            <hr class="cp-divider">
        `;

        detailsContainer.appendChild(div);
    });

    modal.style.display = "block";
    closeBtn.onclick = () => modal.style.display = "none";
    modal.onclick = e => { if (e.target === modal) modal.style.display = "none"; };
}

// ------------------------------------------------------
// STEP 2 — CLICK FIRST-PARTY / THIRD-PARTY / ACTIVE
fpCountEl.style.cursor = "pointer";
tpCountEl.style.cursor = "pointer";
activeCountEl.style.cursor = "pointer";

fpCountEl.addEventListener("click", () => showDomainListModal(false));
tpCountEl.addEventListener("click", () => showDomainListModal(true));
activeCountEl.addEventListener("click", () => showActiveRequestsModal());

// ------------------------------------------------------
// STEP 2A — LIST FP/TP DOMAINS
function showDomainListModal(showThird) {
    const modal = document.getElementById("category-modal");
    const title = document.getElementById("category-title");
    const domainList = document.getElementById("category-domain-list");
    const closeBtn = document.getElementById("category-close");

    domainList.innerHTML = "";
    title.textContent = showThird ? "Third-Party Domains" : "First-Party Domains";

    const host = new URL(statusEl.textContent.replace("Status: Active (Monitoring:", "").replace(")", "").trim()).hostname;

    const list = [];

    for (const [domain, stats] of domainStats.entries()) {
        const isThird = !domain.includes(host);
        if (isThird === showThird) {
            list.push({ domain, count: stats.count });
        }
    }

    list.sort((a, b) => b.count - a.count);

    list.forEach(item => {
        const div = document.createElement("div");
        div.innerHTML = `
            <strong>${item.domain}</strong>
            <small>(${item.count} requests)</small>
        `;

        div.addEventListener("click", () => {
            for (const catMap of Object.values(categoryData)) {
                if (catMap.has(item.domain)) {
                    showDomainRequests(item.domain, catMap.get(item.domain));
                    break;
                }
            }
        });

        domainList.appendChild(div);
    });

    modal.style.display = "block";
    closeBtn.onclick = () => modal.style.display = "none";
    modal.onclick = e => { if (e.target === modal) modal.style.display = "none"; };
}

// ------------------------------------------------------
// STEP 2B — ACTIVE REQUEST MODAL
function showActiveRequestsModal() {
    const modal = document.getElementById("category-modal");
    const title = document.getElementById("category-title");
    const domainList = document.getElementById("category-domain-list");
    const closeBtn = document.getElementById("category-close");

    title.textContent = "Active Requests";
    domainList.innerHTML = "";

    const active = recentRequests.filter(r => r.status === "pending");

    if (active.length === 0) {
        domainList.innerHTML = "<p>No active requests.</p>";
    }

    active.forEach(req => {
        const div = document.createElement("div");
        div.innerHTML = `
            <strong>${req.domain}</strong><br>
            <small>${escapeHtml(req.fullUrl)}</small>
        `;
        domainList.appendChild(div);
    });

    modal.style.display = "block";
    closeBtn.onclick = () => modal.style.display = "none";
    modal.onclick = e => { if (e.target === modal) modal.style.display = "none"; };
}
function showAllDomainsModal(isThirdParty) {
    const modal = document.getElementById("category-modal");
    const title = document.getElementById("category-title");
    const list = document.getElementById("category-domain-list");
    const closeBtn = document.getElementById("category-close");

    list.innerHTML = "";

    const result = [];

    // Build list of all FP / TP domains
    for (const [category, map] of Object.entries(categoryData)) {
        for (const [domain, reqs] of map.entries()) {

            const anyReq = reqs[0];
            const isFP = anyReq?.firstParty;

            if (isThirdParty && !isFP) result.push({ domain, count: reqs.length });
            if (!isThirdParty && isFP) result.push({ domain, count: reqs.length });
        }
    }

    // Title
    title.textContent = isThirdParty ? "All Third-Party Domains" : "All First-Party Domains";

    // Populate modal
    result.sort((a, b) => b.count - a.count).forEach(item => {
        const div = document.createElement("div");
        div.className = "modal-item";
        div.innerHTML = `<strong>${item.domain}</strong> <small>(${item.count})</small>`;

        div.addEventListener("click", () => {
            const requests = [];

            // Gather all requests from all categories
            for (const [, map] of Object.entries(categoryData)) {
                if (map.has(item.domain)) {
                    requests.push(...map.get(item.domain));
                }
            }

            showDomainRequests(item.domain, requests);
        });

        list.appendChild(div);
    });

    // Show modal
    modal.style.display = "block";
    closeBtn.onclick = () => modal.style.display = "none";
    modal.onclick = e => { if (e.target === modal) modal.style.display = "none"; };
}

// ------------------------------------------------------
// Message Handler
chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;

    if (message.type === "CLEAR") {
        categoryData = {};
        domainStats.clear();
        recentRequests = [];

        liveStreamEl.innerHTML = "";

        updateChart();
        updateTopDomains();
        renderRecentRequests();

        fpCountEl.textContent = "0";
        tpCountEl.textContent = "0";

        firstPartyCount = 0;
        thirdPartyCount = 0;
        return;
    }

    if (message.type === "ACTIVE_COUNT") {
        activeCountEl.textContent = message.data?.activeRequestCount || 0;
        return;
    }

    if (message.type === "FAILED") {
        const d = message.data || {};

        addToLiveStream({
            domain: d.domain,
            method: d.method,
            status: `ERR: ${d.errorText}`,
            type: "failed",
            bytes: 0,
            durationMs: 0
        });

        addRecentRequest(d);

        if (d.firstParty) firstPartyCount++;
        else thirdPartyCount++;

        fpCountEl.textContent = firstPartyCount;
        tpCountEl.textContent = thirdPartyCount;
        return;
    }

    // --- DATA EVENT ---
    if (message.type === "DATA") {
        const d = message.data;
        if (!d) return;

        addToLiveStream(d);
        addRecentRequest(d);

        const domain = d.domain || "unknown";

        // Update per-domain stats
        const stats = domainStats.get(domain) || {
            count: 0,
            totalBytes: 0,
            totalDurationMs: 0,
        };

        stats.count++;
        stats.totalBytes += (d.bytes || 0);
        stats.totalDurationMs += (d.durationMs || 0);
        domainStats.set(domain, stats);

        // category bucket
        const category = categorizeDomain(domain);

        if (!categoryData[category]) categoryData[category] = new Map();
        if (!categoryData[category].has(domain)) categoryData[category].set(domain, []);
        categoryData[category].get(domain).push(d);

        // first-party vs third-party count
        if (d.firstParty) firstPartyCount++;
        else thirdPartyCount++;

        fpCountEl.textContent = firstPartyCount;
        tpCountEl.textContent = thirdPartyCount;

        updateChart();
        updateTopDomains();
    }
});

// ------------------------------------------------------
// Start / Stop Buttons
startBtn.addEventListener("click", () => {
    chrome.tabs.query({ currentWindow: true }, (tabs) => {
        const dashUrl = chrome.runtime.getURL("dashboard.html");
        let targetTab = null;

        for (let t of tabs.reverse()) {
            if (t.url && t.url !== dashUrl && t.url.startsWith("http")) {
                targetTab = t;
                break;
            }
        }

        if (!targetTab) {
            alert("Open any website in another tab to monitor.");
            return;
        }

        chrome.runtime.sendMessage({
            command: "start",
            targetTabId: targetTab.id,
            tabTitle: targetTab.title
        });

        statusEl.textContent = `Status: Active (Monitoring: ${targetTab.title})`;
    });
});

stopBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ command: "stop" });
    statusEl.textContent = "Status: Inactive";
});

// ------------------------------------------------------
// Utility
function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    s = String(s);
    return s.replace(/[&<>"'`]/g, (m) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
        "`": "&#96;"
    }[m]));
}

// ------------------------------------------------------
updateChart();
updateTopDomains();
renderRecentRequests();
