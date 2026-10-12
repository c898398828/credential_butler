"use strict";

/**
 * Background Service Worker for Chrome Side Panel integration
 * Enables toggling the native Chrome Side Panel when the toolbar action icon is clicked.
 */

// Enable openPanelOnActionClick so clicking the extension icon toggles the side panel
chrome.sidePanel
  ?.setPanelBehavior?.({ openPanelOnActionClick: true })
  ?.catch((error) => {
    console.warn("sidePanel.setPanelBehavior not supported or failed:", error);
  });

chrome.runtime?.onInstalled?.addListener(() => {
  chrome.sidePanel
    ?.setPanelBehavior?.({ openPanelOnActionClick: true })
    ?.catch(() => {});
});

// Fallback action click handler for environments where openPanelOnActionClick is not active
chrome.action?.onClicked?.addListener(async (tab) => {
  try {
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } else if (tab?.id) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (error) {
    console.warn("Failed to open side panel:", error);
  }
});
