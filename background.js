// Service worker: makes the toolbar icon open the side panel.
// All automation runs in the side panel page (it stays alive while open), so nothing else lives here.

function enablePanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(enablePanelOnClick);
chrome.runtime.onStartup.addListener(enablePanelOnClick);
