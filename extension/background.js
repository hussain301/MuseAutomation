// ============================================================
//  Muse Agent Orchestrator — Background Service Worker
//  Runs in extension context (bypasses HTTPS mixed-content blocks)
// ============================================================

let ws = null;
let agentId = null;
let config = {
  serverUrl: 'ws://137.23.50.81:3000',
  agentName: ''
};
let reconnectTimer = null;
let reconnectDelay = 2000;
const MAX_RECONNECT_DELAY = 20000;
let pingInterval = null;

// ── Initialize ──────────────────────────────────────────
async function init() {
  const stored = await chrome.storage.local.get(['agentId', 'serverUrl', 'agentName']);
  
  agentId = stored.agentId;
  if (!agentId) {
    agentId = 'agent-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    await chrome.storage.local.set({ agentId });
  }

  config.serverUrl = stored.serverUrl || 'ws://137.23.50.81:3000';
  config.agentName = stored.agentName || ('Agent-' + Math.random().toString(36).substring(2, 6).toUpperCase());
  
  await chrome.storage.local.set({
    serverUrl: config.serverUrl,
    agentName: config.agentName
  });

  connectToServer();
}

// ── WebSocket Connection ─────────────────────────────────
async function connectToServer() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try { ws.close(); } catch (e) {}
  }
  clearTimeout(reconnectTimer);
  clearInterval(pingInterval);

  if (!config.serverUrl) {
    console.log('[Background] No server URL configured.');
    setConnectionStatus('disconnected');
    return;
  }

  console.log('[Background] Connecting to:', config.serverUrl);

  try {
    ws = new WebSocket(config.serverUrl);
  } catch (err) {
    console.error('[Background] WebSocket init failed:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
    console.log('[Background] Connected to Orchestrator ✓');
    reconnectDelay = 2000;
    setConnectionStatus('connected');

    // Get current muse tab URL if available
    let currentUrl = 'https://muse.ai';
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.muse.ai/*' });
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

    // Start keepalive ping every 25 seconds
    pingInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {}
      }
    }, 25000);
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
    console.log('[Background] Disconnected code:', e.code, e.reason);
    setConnectionStatus('disconnected');
    clearInterval(pingInterval);
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[Background] WebSocket error:', e);
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[Background] Attempting reconnection...');
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
      console.error('[Background] Failed to send to server:', e);
    }
  }
  return false;
}

function setConnectionStatus(status) {
  chrome.storage.local.set({ connectionStatus: status }).catch(() => {});
}

// ── Handle Server Commands ───────────────────────────────
async function handleServerCommand(data) {
  console.log('[Background] Received command:', data);

  // Command 1: Close Tab(s)
  if (data.action === 'close_tab') {
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.muse.ai/*' });
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

  // Command 2: Send Message or Update Config -> Forward to Content Script
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.muse.ai/*' });
    if (tabs.length === 0) {
      console.warn('[Background] No muse.ai tabs open to receive command!');
      sendServerMessage({
        type: 'ack',
        success: false,
        message: 'No open muse.ai tab found in this browser profile.'
      });
      return;
    }

    // Forward to the first/active muse tab
    const targetTab = tabs.find(t => t.active) || tabs[0];
    chrome.tabs.sendMessage(targetTab.id, data).catch((err) => {
      console.error('[Background] Failed to send command to tab:', err);
    });
  } catch (err) {
    console.error('[Background] Error routing command:', err);
  }
}

// ── Message Routing: Content Scripts & Popup ─────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // Popup requested reconnect with new config
  if (msg.type === 'reconnect') {
    chrome.storage.local.get(['serverUrl', 'agentName']).then((stored) => {
      config.serverUrl = stored.serverUrl || config.serverUrl;
      config.agentName = stored.agentName || config.agentName;
      reconnectDelay = 1000;
      connectToServer();
      sendResponse({ status: 'reconnecting' });
    });
    return true; // async response
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

// ── Chrome Alarms for Service Worker Keepalive ──────────
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      connectToServer();
    }
  }
});

// Start service worker
init();
