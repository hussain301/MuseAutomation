// popup.js — Extension Popup Logic
// Loads/saves config from chrome.storage, shows live connection status

document.addEventListener('DOMContentLoaded', async () => {
  const serverUrlInput = document.getElementById('serverUrl');
  const agentNameInput = document.getElementById('agentName');
  const btnSave = document.getElementById('btnSave');
  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');

  // Load saved config
  const stored = await chrome.storage.local.get(['serverUrl', 'agentName', 'connectionStatus']);
  serverUrlInput.value = stored.serverUrl || 'ws://137.23.50.81:3000';
  agentNameInput.value = stored.agentName || `Agent-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  // Default display from storage
  updateStatus(stored.connectionStatus || 'disconnected');

  // Query live status directly from background service worker
  try {
    chrome.runtime.sendMessage({ type: 'get_status' }, (resp) => {
      if (resp && resp.status) {
        updateStatus(resp.status);
      }
    });
  } catch (e) {}

  // Listen for status changes
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.connectionStatus) {
      updateStatus(changes.connectionStatus.newValue);
    }
  });

  // Save & reconnect
  btnSave.addEventListener('click', async () => {
    let url = serverUrlInput.value.trim();
    const name = agentNameInput.value.trim();

    if (!url) { alert('Server URL is required!'); return; }

    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'ws://' + url;
    }

    await chrome.storage.local.set({ serverUrl: url, agentName: name });

    // Tell background worker to reconnect immediately
    try {
      chrome.runtime.sendMessage({ type: 'reconnect' });
    } catch (e) {}

    // Notify muse.ai tabs
    try {
      const tabs = await chrome.tabs.query({});
      tabs.forEach(tab => {
        if (tab.url && tab.url.toLowerCase().includes('muse.ai')) {
          chrome.tabs.sendMessage(tab.id, { type: 'config_updated' }).catch(() => {});
        }
      });
    } catch (e) {}

    btnSave.textContent = '✓ Saved!';
    setTimeout(() => { btnSave.textContent = '💾 Save & Reconnect'; }, 1500);
  });

  function updateStatus(status) {
    if (status === 'connected') {
      statusBar.className = 'status-bar connected';
      statusText.textContent = 'Connected to Server';
    } else {
      statusBar.className = 'status-bar disconnected';
      statusText.textContent = 'Disconnected';
    }
  }
});
