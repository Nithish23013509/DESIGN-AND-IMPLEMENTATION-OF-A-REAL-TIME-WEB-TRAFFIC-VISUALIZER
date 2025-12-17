document.getElementById("openDashboardBtn").addEventListener("click", () => {
    const dashboardUrl = chrome.runtime.getURL("dashboard.html");
    chrome.tabs.create({ url: dashboardUrl });
});


