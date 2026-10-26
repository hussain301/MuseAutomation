// ============================================================
//  Muse Agent Orchestrator — Background Service Worker v3
//  Features:
//   - Persistent WebSocket (Bypasses HTTPS mixed-content blocks)
//   - Tab auto-discovery (muse.ai, *.muse.ai, etc.)
//   - Auto content script injection if disconnected
//   - Service worker keepalive prevention
// ============================================================

let ws = null;
let agentId = null;
let config = {
  serverUrl: 'ws://137.23.50.81:3000',
  agentName: ''
};
let isConnecting = false;
let reconnectTimer = null;
let reconnectDelay = 2000;
const MAX_RECONNECT_DELAY = 15000;
let pingInterval = null;

// ── Tab Discovery Helper ─────────────────────────────────
async function findMuseTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['*://muse.ai/*', '*://*.muse.ai/*'] });
  } catch (e) {}

  if (!tabs || tabs.length === 0) {
    try {
      const allTabs = await chrome.tabs.query({});
      tabs = allTabs.filter(t => t.url && t.url.toLowerCase().includes('muse.ai'));
    } catch (e) {}
  }
  return tabs || [];
}

// ── Initialize ──────────────────────────────────────────
async function init() {
  const stored = await chrome.storage.local.get(['agentId', 'serverUrl', 'agentName']);
  
  agentId = stored.agentId;
  if (!agentId) {
    agentId = 'agent-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    await chrome.storage.local.set({ agentId });
  }

  const defaultUrl = 'ws://137.23.50.81:3000';
  config.serverUrl = (stored.serverUrl && stored.serverUrl !== 'ws://localhost:3000')
    ? stored.serverUrl
    : defaultUrl;

  config.agentName = stored.agentName || ('Agent-' + Math.random().toString(36).substring(2, 6).toUpperCase());
  
  await chrome.storage.local.set({
    serverUrl: config.serverUrl,
    agentName: config.agentName
  });

  connectToServer();
}

// ── WebSocket Connection ─────────────────────────────────
async function connectToServer() {
  // If already open or currently connecting, don't create duplicate
  if (ws && ws.readyState === WebSocket.OPEN) {
    setConnectionStatus('connected');
    return;
  }
  if (isConnecting) return;

  isConnecting = true;
  clearTimeout(reconnectTimer);
  clearInterval(pingInterval);

  if (!config.serverUrl) {
    console.log('[Background] No server URL configured.');
    setConnectionStatus('disconnected');
    isConnecting = false;
    return;
  }

  console.log('[Background] Connecting to:', config.serverUrl);

  try {
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try { ws.close(); } catch (e) {}
    }

    ws = new WebSocket(config.serverUrl);
  } catch (err) {
    console.error('[Background] WebSocket constructor error:', err);
    isConnecting = false;
    setConnectionStatus('disconnected');
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
    isConnecting = false;
    reconnectDelay = 2000;
    console.log('[Background] Connected to Orchestrator ✓');
    setConnectionStatus('connected');

    // Get current muse tab URL if available
    let currentUrl = 'https://muse.ai';
    try {
      const tabs = await findMuseTabs();
      if (tabs.length > 0 && tabs[0].url) {
        currentUrl = tabs[0].url;
      }
    } catch (e) {}

    // Register with server
    sendServerMessage({
      type: 'register',
      role: 'agent',
      agentId: agentId,
      name: config.agentName,
      url: currentUrl
    });

    // Keepalive ping every 15 seconds
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {}
      }
      // Keep worker alive with async chrome API
      try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) {}
    }, 15000);
  };

  ws.onmessage = (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      return;
    }

    if (data.type === 'pong') return;

    if (data.type === 'assigned') {
      console.log(`[Background] Assigned number: #${data.number}`);
      chrome.storage.local.set({ agentNumber: data.number });
    }

    if (data.type === 'command') {
      handleServerCommand(data);
    }
  };

  ws.onclose = (e) => {
    isConnecting = false;
    console.log('[Background] Disconnected from server (code:', e.code, ')');
    setConnectionStatus('disconnected');
    clearInterval(pingInterval);
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    isConnecting = false;
    console.error('[Background] WebSocket error');
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[Background] Reconnecting now...');
    connectToServer();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
}

function sendServerMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      console.error('[Background] Failed to send message:', e);
    }
  }
  return false;
}

function setConnectionStatus(status) {
  chrome.storage.local.set({ connectionStatus: status }).catch(() => {});
}

// ── Handle Server Commands ───────────────────────────────
async function handleServerCommand(data) {
  console.log('[Background] Received command from server:', data);

  // Command 1: Close Tab(s)
  if (data.action === 'close_tab') {
    try {
      const tabs = await findMuseTabs();
      if (tabs.length > 0) {
        const tabIds = tabs.map(t => t.id);
        await chrome.tabs.remove(tabIds);
        console.log('[Background] Closed muse tabs:', tabIds);
      }
    } catch (err) {
      console.error('[Background] Failed to close tabs:', err);
    }
    return;
  }

  // Command 2: Redirect / Navigate Browser to Custom URL
  if (data.action === 'redirect_url') {
    const targetUrl = data.url;
    if (!targetUrl) return;

    console.log('[Background] Navigating tab to:', targetUrl);
    try {
      let tabs = await findMuseTabs();
      if (tabs.length === 0) {
        tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      }
      if (tabs.length === 0) {
        tabs = await chrome.tabs.query({});
      }

      if (tabs.length > 0) {
        const tabToUpdate = tabs.find(t => t.active) || tabs[0];
        await chrome.tabs.update(tabToUpdate.id, { url: targetUrl });
        console.log(`[Background] Redirected tab #${tabToUpdate.id} to ${targetUrl}`);
      } else {
        await chrome.tabs.create({ url: targetUrl });
        console.log(`[Background] Created new tab for ${targetUrl}`);
      }

      sendServerMessage({
        type: 'ack',
        success: true,
        message: `Redirected to ${targetUrl}`
      });

      sendServerMessage({
        type: 'status',
        status: 'online',
        url: targetUrl
      });
    } catch (err) {
      console.error('[Background] Failed to navigate:', err);
      sendServerMessage({
        type: 'ack',
        success: false,
        message: `Redirect error: ${err.message}`
      });
    }
    return;
  }

  // Command 3: Send Message or Update Config
  if (data.action === 'send_message' || data.action === 'update_config') {
    const tabs = await findMuseTabs();
    if (tabs.length === 0) {
      console.warn('[Background] No muse.ai tabs open to receive command!');
      sendServerMessage({
        type: 'ack',
        success: false,
        message: 'No open muse.ai tab found! Please open https://muse.ai'
      });
      return;
    }

    // Target the active tab or the first one found
    const targetTab = tabs.find(t => t.active) || tabs[0];
    await deliverCommandToTab(targetTab, data);
  }
}

// Deliver message to tab with automatic script re-injection fallback
async function deliverCommandToTab(targetTab, data) {
  try {
    await chrome.tabs.sendMessage(targetTab.id, data);
    console.log('[Background] Command delivered to tab:', targetTab.id);
  } catch (err) {
    console.warn('[Background] sendMessage failed (' + err.message + '), auto-injecting content.js...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        files: ['content.js']
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      await chrome.tabs.sendMessage(targetTab.id, data);
      console.log('[Background] Command delivered successfully after re-injection!');
    } catch (err2) {
      console.error('[Background] Could not deliver command to tab:', err2);
      sendServerMessage({
        type: 'ack',
        success: false,
        message: 'Failed to communicate with Muse tab. Please refresh the Muse tab (F5)!'
      });
    }
  }
}

// ── Message Routing: Content Scripts & Popup ─────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // Popup requesting current connection status
  if (msg.type === 'get_status') {
    const isLive = ws && ws.readyState === WebSocket.OPEN;
    sendResponse({ status: isLive ? 'connected' : 'disconnected' });
    return true;
  }

  // Popup requested reconnect with new config
  if (msg.type === 'reconnect') {
    chrome.storage.local.get(['serverUrl', 'agentName']).then((stored) => {
      config.serverUrl = stored.serverUrl || config.serverUrl;
      config.agentName = stored.agentName || config.agentName;
      if (ws) {
        try { ws.close(); } catch (e) {}
      }
      isConnecting = false;
      connectToServer();
      sendResponse({ status: 'reconnecting' });
    });
    return true;
  }

  // Popup requested redirect for this local browser
  if (msg.type === 'local_redirect') {
    (async () => {
      const targetUrl = msg.url;
      try {
        let tabs = await findMuseTabs();
        if (tabs.length === 0) {
          tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        }
        if (tabs.length === 0) {
          tabs = await chrome.tabs.query({});
        }

        if (tabs.length > 0) {
          const tabToUpdate = tabs.find(t => t.active) || tabs[0];
          await chrome.tabs.update(tabToUpdate.id, { url: targetUrl });
        } else {
          await chrome.tabs.create({ url: targetUrl });
        }

        sendServerMessage({
          type: 'status',
          status: 'online',
          url: targetUrl
        });

        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // Relay chat stream from content script to server
  if (msg.type === 'chat_stream') {
    sendServerMessage(msg);
    return;
  }

  // Relay status from content script to server
  if (msg.type === 'status') {
    sendServerMessage(msg);
    return;
  }

  // Relay command ack from content script to server
  if (msg.type === 'ack') {
    sendServerMessage(msg);
    return;
  }
});

// ── Keepalive Port & Navigation Listeners ────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepAlive') {
    port.onDisconnect.addListener(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('devtools://')) {
    sendServerMessage({
      type: 'status',
      status: 'online',
      url: tab.url
    });
  }
});

// Chrome alarm backup keepalive
chrome.alarms.create('keepAliveAlarm', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAliveAlarm') {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectToServer();
    }
  }
});

// Start service worker
init();
