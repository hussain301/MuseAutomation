// ============================================================
//  Muse Agent Orchestrator — Content Script v2
//  Injected into muse.ai pages.
//
//  Features:
//   - XPath-based DOM targeting
//   - New Chat button click (optional)
//   - Auto-type + Enter key to send
//   - Response capture via MutationObserver
//   - React/Vue/Angular compatible input handling
// ============================================================

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────
  let ws = null;
  let agentNumber = 0;
  let config = {
    serverUrl: '',
    agentName: '',
    // Default XPaths (provided by user)
    inputXPath: '/html/body/div[2]/div/div/div/div/div[1]/div/div[3]/div/div/div[3]/div/div/div[1]/div/textarea',
    newChatButtonXPath: '/html/body/div[2]/div/div/div/div/div[1]/div/div[1]/div/div/div[4]/div/div/nav/div/div[2]/div/div/div/div[1]/section/div[1]/span/button',
    responseXPath: ''
  };
  let agentId = null;
  let reconnectTimer = null;
  let reconnectDelay = 3000;
  const MAX_RECONNECT_DELAY = 30000;

  // ── Initialize ─────────────────────────────────────────
  async function init() {
    const stored = await chrome.storage.local.get([
      'agentId', 'serverUrl', 'agentName',
      'inputXPath', 'newChatButtonXPath', 'responseXPath'
    ]);

    agentId = stored.agentId;
    if (!agentId) {
      agentId = 'agent-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
      await chrome.storage.local.set({ agentId });
    }

    config.serverUrl = stored.serverUrl || 'ws://localhost:3000';
    config.agentName = stored.agentName || ('Profile-' + (location.pathname.split('/')[1] || Math.random().toString(36).substring(2, 6)));
    
    // Override XPaths only if explicitly saved
    if (stored.inputXPath) config.inputXPath = stored.inputXPath;
    if (stored.newChatButtonXPath) config.newChatButtonXPath = stored.newChatButtonXPath;
    if (stored.responseXPath) config.responseXPath = stored.responseXPath;

    if (config.serverUrl) {
      connectToServer();
    } else {
      console.log('[Muse Orchestrator] No server URL configured. Open the extension popup to set it.');
    }
  }

  // ── WebSocket Connection ───────────────────────────────
  function connectToServer() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
    clearTimeout(reconnectTimer);

    try {
      ws = new WebSocket(config.serverUrl);
    } catch (e) {
      console.error('[Muse Orchestrator] Invalid WebSocket URL:', config.serverUrl);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      console.log('[Muse Orchestrator] Connected to server ✓');
      reconnectDelay = 3000;

      ws.send(JSON.stringify({
        type: 'register',
        role: 'agent',
        agentId: agentId,
        name: config.agentName,
        url: window.location.href
      }));

      setConnectionStatus('connected');
      
      // Rescan and send all existing chat messages to server
      setTimeout(scanForChatMessages, 1000);
    };

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch (e) { return; }

      if (data.type === 'command') {
        handleCommand(data);
      }
      
      // Server tells us our assigned number
      if (data.type === 'assigned') {
        agentNumber = data.number;
        console.log(`[Muse Orchestrator] Assigned agent number: #${agentNumber}`);
      }
    };

    ws.onclose = () => {
      console.log('[Muse Orchestrator] Disconnected from server');
      setConnectionStatus('disconnected');
      scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      console.log(`[Muse Orchestrator] Reconnecting...`);
      connectToServer();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
  }

  function setConnectionStatus(status) {
    chrome.storage.local.set({ connectionStatus: status }).catch(() => {});
  }

  // ── Handle Commands ────────────────────────────────────
  function handleCommand(data) {
    if (data.action === 'send_message') {
      const newChat = data.newChat || false;
      const responseTimeout = (data.responseTimeout || 60) * 1000;
      typeAndSendMessage(data.message, newChat, responseTimeout);
    }

    if (data.action === 'close_tab') {
      console.log('[Muse Orchestrator] Received close_tab command. Closing...');
      try {
        window.close();
      } catch (e) {}
      // Fallback: navigate to about:blank to effectively kill the tab
      setTimeout(() => { window.location.href = 'about:blank'; }, 500);
    }

    if (data.action === 'update_config') {
      const c = data.config || {};
      if (c.inputXPath) config.inputXPath = c.inputXPath;
      if (c.newChatButtonXPath) config.newChatButtonXPath = c.newChatButtonXPath;
      if (c.responseXPath !== undefined) config.responseXPath = c.responseXPath;
      // Persist
      chrome.storage.local.set({
        inputXPath: config.inputXPath,
        newChatButtonXPath: config.newChatButtonXPath,
        responseXPath: config.responseXPath
      }).catch(() => {});
      console.log('[Muse Orchestrator] Config updated:', config);
    }
  }

  // ── Main: Type and Send Message ────────────────────────
  async function typeAndSendMessage(message, openNewChat, responseTimeout) {
    try {
      sendStatus('typing');

      // Step 1: Open new chat if requested
      if (openNewChat) {
        console.log('[Muse Orchestrator] Opening new chat...');
        const newChatBtn = findElementByXPath(config.newChatButtonXPath);
        if (!newChatBtn) {
          throw new Error(`New Chat button not found! XPath: "${config.newChatButtonXPath}"`);
        }
        newChatBtn.click();
        await sleep(2000); // Wait for new chat to load
      }

      // Step 2: Find the textarea
      // Retry a few times in case the DOM is still loading
      let inputEl = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        inputEl = findElementByXPath(config.inputXPath);
        if (inputEl) break;
        await sleep(1000);
      }

      if (!inputEl) {
        throw new Error(`Input textarea not found after retries! XPath: "${config.inputXPath}"`);
      }

      // Step 3: Count existing messages (for response detection)
      const messagesBefore = countChatMessages();

      // Step 4: Type the message into the textarea
      await setInputValue(inputEl, message);
      await sleep(300);

      // Step 5: Press Enter to send
      pressEnter(inputEl);
      await sleep(500);

      // Verify the input was cleared (indicates message was sent)
      const inputAfter = findElementByXPath(config.inputXPath);
      const wasSent = !inputAfter || inputAfter.value === '' || inputAfter.value !== message;
      
      if (wasSent) {
        sendAck(true, 'Message typed & Enter pressed ✓');
      } else {
        // Try pressing Enter again
        pressEnter(inputAfter || inputEl);
        await sleep(300);
        sendAck(true, 'Message sent (double Enter) ✓');
      }

      sendStatus('online');

      // Step 6: Wait for response from Muse agent
      watchForResponse(messagesBefore, responseTimeout);

    } catch (err) {
      console.error('[Muse Orchestrator] Error:', err);
      sendAck(false, err.message);
      sendStatus('error');
    }
  }

  // ── Response Detection ─────────────────────────────────
  /**
   * Count current chat messages (generic approach)
   * Looks for common chat message patterns in the DOM
   */
  function countChatMessages() {
    // Try response XPath first
    if (config.responseXPath) {
      const container = findElementByXPath(config.responseXPath);
      if (container) return container.children.length;
    }
    // Generic: count elements that look like chat messages
    // Muse likely has message divs — we'll watch for child count changes
    // in the main chat area
    return document.querySelectorAll('[class*="message"], [class*="Message"], [data-message]').length;
  }

  /**
   * Watch for a new message to appear in the chat (the agent's response)
   * Uses polling approach (more reliable than MutationObserver for dynamic apps)
   */
  function watchForResponse(messageCountBefore, timeout) {
    const startTime = Date.now();
    const pollInterval = 3000;  // Check every 3 seconds
    let lastContent = '';

    const checker = setInterval(() => {
      // Timeout reached
      if (Date.now() - startTime > timeout) {
        clearInterval(checker);
        sendResponseTimeout();
        return;
      }

      // Try to detect new response
      const response = detectNewResponse(messageCountBefore);
      if (response && response !== lastContent) {
        // Check if the response seems complete (no "typing" indicator)
        // Wait a bit more to ensure the full response is captured
        lastContent = response;
        
        // Wait 5 more seconds and check again for complete response
        setTimeout(() => {
          const finalResponse = detectNewResponse(messageCountBefore);
          clearInterval(checker);
          
          if (finalResponse) {
            sendResponse(finalResponse);
          } else {
            sendResponse(lastContent);
          }
        }, 5000);
        
        clearInterval(checker); // Stop polling, the setTimeout above will handle it
      }
    }, pollInterval);
  }

  /**
   * Try to detect and extract the latest bot/agent response from the chat DOM
   */
  function detectNewResponse(messageCountBefore) {
    try {
      // Strategy 1: Use responseXPath if configured
      if (config.responseXPath) {
        const container = findElementByXPath(config.responseXPath);
        if (container && container.children.length > messageCountBefore) {
          const lastMsg = container.lastElementChild;
          return lastMsg ? lastMsg.textContent.trim() : null;
        }
      }

      // Strategy 2: Look for common chat message patterns
      // Get all text-like elements in the chat area
      const allMessages = document.querySelectorAll(
        '[class*="message"], [class*="Message"], [data-message], [class*="response"], [class*="Response"], [class*="chat-bubble"], [class*="assistant"]'
      );
      
      if (allMessages.length > messageCountBefore) {
        const lastMsg = allMessages[allMessages.length - 1];
        const text = lastMsg.textContent.trim();
        if (text.length > 0) return text;
      }

      // Strategy 3: Generic — look at the main content area for new text
      // This is a fallback and may not always work
      const chatAreas = document.querySelectorAll('[class*="chat"], [class*="conversation"], main, [role="main"]');
      for (const area of chatAreas) {
        const children = area.querySelectorAll('div > div, div > p, article');
        if (children.length > messageCountBefore) {
          const lastChild = children[children.length - 1];
          const text = lastChild.textContent.trim();
          if (text.length > 10) return text;
        }
      }

      return null;
    } catch (e) {
      console.error('[Muse Orchestrator] Error detecting response:', e);
      return null;
    }
  }

  // ── DOM Helpers ────────────────────────────────────────

  function findElementByXPath(xpath) {
    if (!xpath) return null;
    try {
      const result = document.evaluate(
        xpath, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      return result.singleNodeValue;
    } catch (e) {
      console.error('[Muse Orchestrator] Invalid XPath:', xpath, e);
      return null;
    }
  }

  /**
   * Set value on input/textarea — React/Vue/Angular compatible
   */
  async function setInputValue(element, value) {
    element.focus();
    element.click();
    await sleep(100);

    // For contentEditable elements
    if (element.isContentEditable) {
      element.textContent = '';
      element.focus();
      document.execCommand('insertText', false, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // For regular textarea/input — use native setter for React compatibility
    const nativeSetter =
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

    if (nativeSetter) {
      nativeSetter.call(element, value);
    } else {
      element.value = value;
    }

    // Dispatch events in the order React expects
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Also dispatch React-specific synthetic event
    const nativeInputEvent = new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: value
    });
    element.dispatchEvent(nativeInputEvent);
  }

  /**
   * Simulate pressing Enter key
   */
  function pressEnter(element) {
    // keydown
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    }));
    // keypress
    element.dispatchEvent(new KeyboardEvent('keypress', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    }));
    // keyup
    element.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    }));
  }

  // ── Server Communication ───────────────────────────────
  function sendStatus(status) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'status', status, url: window.location.href }));
    }
  }

  function sendAck(success, message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ack', success, message }));
    }
  }

  function sendResponse(responseText) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'response', response: responseText }));
    }
    console.log('[Muse Orchestrator] Response captured:', responseText.substring(0, 100));
  }

  function sendResponseTimeout() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'response_timeout' }));
    }
    console.log('[Muse Orchestrator] Response timeout — no new message detected');
  }

  // ── Real-time Chat Monitor ─────────────────────────────
  const seenMessageIds = new Set();

  function startChatMonitor() {
    // Initial scan
    setTimeout(scanForChatMessages, 2000);

    // MutationObserver to capture messages the instant they appear in DOM
    const observer = new MutationObserver(() => {
      scanForChatMessages();
    });

    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    } catch (e) {}

    // Fallback interval polling every 2 seconds
    setInterval(scanForChatMessages, 2000);
  }

  function scanForChatMessages() {
    // Muse chat items have [data-message-item="true"]
    const messageEls = document.querySelectorAll('[data-message-item="true"]');
    if (!messageEls || messageEls.length === 0) return;

    messageEls.forEach(el => {
      const msgId = el.getAttribute('data-message-id') || el.getAttribute('data-message-turn-id');
      if (!msgId || seenMessageIds.has(msgId)) return;

      const role = el.getAttribute('data-message-role') || 'unknown'; // 'assistant' or 'user'
      let text = '';

      // Strategy 1: accessibility surrogate (contains full clean text!)
      const surrogate = el.querySelector('[data-message-accessibility-surrogate="true"]');
      if (surrogate && surrogate.textContent) {
        text = surrogate.textContent.trim();
        // Remove "Assistant message: " or "User message: " prefix
        text = text.replace(/^(Assistant|User)\s+message:\s*/i, '').trim();
      }

      // Strategy 2: prose / bubble text fallback
      if (!text) {
        const bodyEl = el.querySelector('[data-hatch-assistant-message-body="true"]') ||
                       el.querySelector('.hatch-chat-groupable-bubble') ||
                       el.querySelector('.prose');
        if (bodyEl && bodyEl.textContent) {
          text = bodyEl.textContent.trim();
        }
      }

      if (!text) return; // Still rendering

      // Mark as seen
      seenMessageIds.add(msgId);

      // Stream to server
      const chatPayload = {
        id: msgId,
        role: role,
        text: text,
        timestamp: new Date().toLocaleTimeString()
      };

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'chat_stream',
          message: chatPayload
        }));
      }

      // If it's assistant reply, update status to online
      if (role === 'assistant') {
        sendStatus('online');
      }
    });
  }

  // ── Utilities ──────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Listen for Config Updates from Popup ───────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'config_updated') {
      chrome.storage.local.get(['serverUrl', 'agentName']).then((stored) => {
        config.serverUrl = stored.serverUrl || '';
        config.agentName = stored.agentName || 'Unnamed Agent';
        if (config.serverUrl) {
          console.log('[Muse Orchestrator] Config updated, reconnecting...');
          connectToServer();
        }
      });
    }
  });

  // ── Start ──────────────────────────────────────────────
  init();
  startChatMonitor();

})();
