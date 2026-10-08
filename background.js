// Background script: opens the automation panel from the toolbar button, in whatever form the
// browser supports. All automation runs in the panel page itself, so nothing else lives here.
//   - Chrome, Edge, Brave, Vivaldi…: the Side Panel (chrome.sidePanel)
//   - Firefox: the sidebar (sidebar_action)
//   - Opera, Arc and anything else: a small standalone window
// Right-clicking the toolbar button always offers "Open in a separate window".
// Runs as a service worker in Chromium and as an event page in Firefox.

const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
const PANEL_PATH = 'sidepanel/index.html';
const MENU_ID = 'cga-open-window';
const menus = api.contextMenus || api.menus;

function hasSidePanel() {
  return !!api.sidePanel?.setPanelBehavior;
}

function setup() {
  if (hasSidePanel()) api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (menus?.create) {
    Promise.resolve(menus.removeAll?.())
      .catch(() => {})
      .then(() => {
        try {
          menus.create({ id: MENU_ID, title: api.i18n.getMessage('openInWindow') || 'Open in a separate window', contexts: ['action'] });
        } catch { /* menus unsupported for the toolbar button */ }
      });
  }
}

/** Focus the panel window if one is open, otherwise open one. */
async function openPanelWindow() {
  const url = api.runtime.getURL(PANEL_PATH);
  const tabs = await api.tabs.query({ url: `${url}*` }).catch(() => []);
  const existing = tabs.find((t) => t.url?.startsWith(url));
  if (existing) {
    await api.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return;
  }
  await api.windows.create({ url: `${url}?window=1`, type: 'popup', width: 440, height: 880 });
}

api.runtime.onInstalled.addListener(setup);
api.runtime.onStartup?.addListener(setup);

// Only fires when the click doesn't already open the side panel.
api.action.onClicked.addListener(() => {
  if (api.sidebarAction?.toggle) {
    api.sidebarAction.toggle(); // must run synchronously inside the click handler (Firefox)
    return;
  }
  openPanelWindow();
});

menus?.onClicked?.addListener((info) => {
  if (info.menuItemId === MENU_ID) openPanelWindow();
});
