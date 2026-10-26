// popup.js — Extension Popup Logic
// Loads/saves config from chrome.storage, shows live connection status

document.addEventListener('DOMContentLoaded', async () => {
  const serverUrlInput = document.getElementById('serverUrl');
  const agentNameInput = document.getElementById('agentName');
  const btnSave = document.getElementById('btnSave');
  const statusBar = document.getElementById('statusBar');
  const statusText = document.getElementById('statusText');

  // Load saved config with default remote IP
  const stored = await chrome.storage.local.get(['serverUrl', 'agentName', 'connectionStatus']);
  const defaultUrl = 'ws://137.23.50.81:3000';
  const effectiveUrl = (stored.serverUrl && stored.serverUrl !== 'ws://localhost:3000') ? stored.serverUrl : defaultUrl;
  serverUrlInput.value = effectiveUrl;
  agentNameInput.value = stored.agentName || `Agent-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  if (stored.serverUrl !== effectiveUrl) {
    chrome.storage.local.set({ serverUrl: effectiveUrl }).catch(() => {});
  }

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

  // Preset chips for redirect
  document.querySelectorAll('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const url = chip.getAttribute('data-url');
      if (url) document.getElementById('targetUrlInput').value = url;
    });
  });

  // Redirect this browser tab
  const btnRedirect = document.getElementById('btnRedirect');
  const targetUrlInput = document.getElementById('targetUrlInput');

  if (btnRedirect && targetUrlInput) {
    btnRedirect.addEventListener('click', async () => {
      let url = targetUrlInput.value.trim();
      if (!url) { alert('Destination URL is required!'); return; }

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
        targetUrlInput.value = url;
      }

      btnRedirect.textContent = '⏳ Redirecting...';

      chrome.runtime.sendMessage({
        type: 'local_redirect',
        url: url
      }, async (resp) => {
        if (!resp || !resp.success) {
          try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs.length > 0) {
              await chrome.tabs.update(tabs[0].id, { url: url });
            } else {
              await chrome.tabs.create({ url: url });
            }
          } catch (e) {}
        }
        btnRedirect.textContent = '✓ Redirected!';
        setTimeout(() => { btnRedirect.textContent = '🌐 Redirect This Browser'; }, 1500);
      });
    });
  }

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
