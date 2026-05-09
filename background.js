"use strict";

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanelOnActionClick();
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelOnActionClick();
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await openSidePanel(tab);
  } catch (error) {
    console.error("Failed to open ASL Agent side panel:", error);
  }
});

function enableSidePanelOnActionClick() {
  if (!chrome.sidePanel || !chrome.sidePanel.setPanelBehavior) {
    return;
  }

  chrome.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true
  }).catch((error) => {
    console.error("Failed to enable side panel action behavior:", error);
  });
}

async function openSidePanel(tab) {
  if (!chrome.sidePanel || !chrome.sidePanel.open) {
    throw new Error("chrome.sidePanel.open is not available.");
  }

  if (tab && Number.isInteger(tab.windowId)) {
    await chrome.sidePanel.open({
      windowId: tab.windowId
    });
    return;
  }

  const window = await chrome.windows.getCurrent();

  await chrome.sidePanel.open({
    windowId: window.id
  });
}