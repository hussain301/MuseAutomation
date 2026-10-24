// popup.js — Extension Popup Logic
// Loads/saves config from chrome.storage, shows connection status

document.addEventListener('DOMContentLoaded', async () => {
  const serverUrlInput = document.getElementById('serverUrl');
  const agentNameInput = document.getElementById('agentName');
  const btnSave = document.getElementById('btnSave');
  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');

  // Load saved config
  const stored = await chrome.storage.local.get(['serverUrl', 'agentName', 'connectionStatus']);
  serverUrlInput.value = stored.serverUrl || 'ws://localhost:3000';
  agentNameInput.value = stored.agentName || `Agent-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  // Show connection status
  updateStatus(stored.connectionStatus || 'disconnected');

  // Listen for status updates from content script
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

    // Auto-prepend ws:// if user entered just IP:port
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'ws://' + url;
    }

    await chrome.storage.local.set({ serverUrl: url, agentName: name });

    // Notify all muse.ai tabs to reconnect
    const tabs = await chrome.tabs.query({ url: '*://*.muse.ai/*' });
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { type: 'config_updated' }).catch(() => {});
    });

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
