// ============================================================
//  Muse Agent Orchestrator — Content Script v4
//  Injected into muse.ai pages.
//
//  Features:
//   - Keepalive port to prevent Service Worker sleep
//   - Resilient DOM targeting (XPath + automatic fallbacks)
//   - React/Vue/Angular compatible input handling
//   - Dual dispatch: Enter key + Send Button click
//   - Real-time chat response capture & streaming
// ============================================================

(function () {
  'use strict';

  // Prevent double injection
  if (window.__museOrchestratorLoaded) {
    console.log('[Muse Orchestrator] Already active on this page.');
    return;
  }
  window.__museOrchestratorLoaded = true;

  // ── State ──────────────────────────────────────────────
  let config = {
    inputXPath: '/html/body/div[2]/div/div/div/div/div[1]/div/div[3]/div/div/div[3]/div/div/div[1]/div/textarea',
    newChatButtonXPath: '/html/body/div[2]/div/div/div/div/div[1]/div/div[1]/div/div/div[4]/div/div/nav/div/div[2]/div/div/div/div[1]/section/div[1]/span/button',
    responseXPath: ''
  };

  // ── Service Worker Keepalive Port ──────────────────────
  let keepAlivePort = null;
  function maintainKeepAlivePort() {
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'keepAlive' });
      keepAlivePort.onDisconnect.addListener(() => {
        setTimeout(maintainKeepAlivePort, 2000);
      });
    } catch (e) {
      setTimeout(maintainKeepAlivePort, 5000);
    }
  }
  maintainKeepAlivePort();

  // ── Initialize ─────────────────────────────────────────
  async function init() {
    console.log('[Muse Orchestrator] Content script initialized on', window.location.href);

    const stored = await chrome.storage.local.get([
      'inputXPath', 'newChatButtonXPath', 'responseXPath'
    ]);

    if (stored.inputXPath) config.inputXPath = stored.inputXPath;
    if (stored.newChatButtonXPath) config.newChatButtonXPath = stored.newChatButtonXPath;
    if (stored.responseXPath) config.responseXPath = stored.responseXPath;

    sendStatus('online');
  }

  // ── Listen for Commands from Background Script ─────────
  chrome.runtime.onMessage.addListener((data, sender, sendResponse) => {
    if (!data) return;

    if (data.type === 'command') {
      handleCommand(data);
    }

    if (data.type === 'config_updated') {
      chrome.storage.local.get(['inputXPath', 'newChatButtonXPath', 'responseXPath']).then((stored) => {
        if (stored.inputXPath) config.inputXPath = stored.inputXPath;
        if (stored.newChatButtonXPath) config.newChatButtonXPath = stored.newChatButtonXPath;
        if (stored.responseXPath !== undefined) config.responseXPath = stored.responseXPath;
      });
    }
  });

  // ── Handle Commands ────────────────────────────────────
  function handleCommand(data) {
    if (data.action === 'send_message') {
      const newChat = data.newChat || false;
      const responseTimeout = (data.responseTimeout || 60) * 1000;
      typeAndSendMessage(data.message, newChat, responseTimeout);
    }

    if (data.action === 'redirect_url' && data.url) {
      console.log('[Muse Orchestrator] Redirecting to:', data.url);
      window.location.href = data.url;
    }

    if (data.action === 'close_browser' || data.action === 'close_tab') {
      console.log('[Muse Orchestrator] Received close command.');
      try { window.close(); } catch (e) {}
      setTimeout(() => { window.location.href = 'about:blank'; }, 300);
    }

    if (data.action === 'update_config') {
      const c = data.config || {};
      if (c.inputXPath) config.inputXPath = c.inputXPath;
      if (c.newChatButtonXPath) config.newChatButtonXPath = c.newChatButtonXPath;
      if (c.responseXPath !== undefined) config.responseXPath = c.responseXPath;

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
        console.log('[Muse Orchestrator] Attempting to open new chat...');
        const newChatBtn = findNewChatButton();
        if (newChatBtn) {
          newChatBtn.click();
          await sleep(2000);
        } else {
          console.warn('[Muse Orchestrator] New Chat button not found; continuing in current chat.');
        }
      }

      // Step 2: Find the input element (try XPath, then smart DOM scan)
      let inputEl = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        inputEl = findInputElement();
        if (inputEl) break;
        await sleep(500);
      }

      if (!inputEl) {
        throw new Error('Input textarea / chatbox not found on this page!');
      }

      // Step 3: Type the message into the textarea
      await setInputValue(inputEl, message);
      await sleep(300);

      // Step 4: Dispatch Enter key
      pressEnter(inputEl);
      await sleep(300);

      // Step 5: Also click Send Button if one exists
      clickSendButton(inputEl);
      await sleep(500);

      // Step 6: Verify send
      const inputAfter = findInputElement();
      const wasSent = !inputAfter || inputAfter.value === '' || inputAfter.value !== message;
      
      if (wasSent) {
        sendAck(true, 'Message typed & sent ✓');
      } else {
        // Retry Enter & button click once more
        pressEnter(inputAfter || inputEl);
        clickSendButton(inputAfter || inputEl);
        await sleep(300);
        sendAck(true, 'Message sent (retry) ✓');
      }

      sendStatus('online');
    } catch (err) {
      console.error('[Muse Orchestrator] Error during typeAndSendMessage:', err);
      sendAck(false, err.message);
      sendStatus('error');
    }
  }

  // ── DOM Helpers with Resilient Fallbacks ────────────────
  function findElementByXPath(xpath) {
    if (!xpath) return null;
    try {
      const result = document.evaluate(
        xpath, document, null,
        XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      return result.singleNodeValue;
    } catch (e) {
      return null;
    }
  }

  function findInputElement() {
    // 1. Try configured XPath
    if (config.inputXPath) {
      const el = findElementByXPath(config.inputXPath);
      if (el) return el;
    }

    // 2. Try textareas (prefer visible ones)
    const textareas = Array.from(document.querySelectorAll('textarea'));
    const visibleTextarea = textareas.find(t => t.offsetParent !== null || t.offsetWidth > 0 || t.offsetHeight > 0);
    if (visibleTextarea) return visibleTextarea;
    if (textareas.length > 0) return textareas[0];

    // 3. Try contenteditable div
    const editable = document.querySelector('div[contenteditable="true"]');
    if (editable) return editable;

    // 4. Try input fields
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    const visibleInput = inputs.find(i => i.offsetParent !== null || i.offsetWidth > 0);
    if (visibleInput) return visibleInput;

    return null;
  }

  function findNewChatButton() {
    if (config.newChatButtonXPath) {
      const el = findElementByXPath(config.newChatButtonXPath);
      if (el) return el;
    }

    // Fallback: look for button or link with "new chat"
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return buttons.find(b => {
      const text = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').toLowerCase();
      return text.includes('new chat') || text.includes('new conversation') || text.includes('start chat');
    }) || null;
  }

  function clickSendButton(inputEl) {
    try {
      const formOrContainer = inputEl ? inputEl.closest('form, [class*="input"], [class*="chat"], div') : document;
      if (formOrContainer) {
        const btn = formOrContainer.querySelector('button[type="submit"], button[aria-label*="send" i], button[aria-label*="submit" i]');
        if (btn) {
          btn.click();
          return;
        }
      }
    } catch (e) {}
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
    
    // Also dispatch React synthetic input event
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
    const eventInit = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    element.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    element.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    element.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  }

  // ── Relay Communication to Background Worker ───────────
  function sendStatus(status) {
    chrome.runtime.sendMessage({
      type: 'status',
      status: status,
      url: window.location.href
    }).catch(() => {});
  }

  function sendAck(success, message) {
    chrome.runtime.sendMessage({
      type: 'ack',
      success: success,
      message: message
    }).catch(() => {});
  }

  // ── Real-time Chat Monitor (Full Message & Streaming) ──
  const initialOldMessageIds = new Set();
  const trackedMessages = new Map(); // msgId => { lastSentText, debounceTimer }
  let isInitialScanDone = false;

  function markExistingMessagesAsSeen() {
    const messageEls = document.querySelectorAll('[data-message-item="true"]');
    messageEls.forEach(el => {
      const msgId = el.getAttribute('data-message-id') || el.getAttribute('data-message-turn-id');
      if (msgId) {
        initialOldMessageIds.add(msgId);
      }
    });
  }

  function startChatMonitor() {
    markExistingMessagesAsSeen();

    setTimeout(() => {
      markExistingMessagesAsSeen();
      isInitialScanDone = true;
      console.log(`[Muse Orchestrator] Ignored ${initialOldMessageIds.size} old messages. Listening for NEW messages only.`);
    }, 2500);

    const observer = new MutationObserver(() => {
      if (isInitialScanDone) {
        scanForChatMessages();
      } else {
        markExistingMessagesAsSeen();
      }
    });

    try {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (e) {}

    setInterval(() => {
      if (isInitialScanDone) {
        scanForChatMessages();
      }
    }, 1000);
  }

  function scanForChatMessages() {
    const messageEls = document.querySelectorAll('[data-message-item="true"]');
    if (!messageEls || messageEls.length === 0) return;

    messageEls.forEach(el => {
      const msgId = el.getAttribute('data-message-id') || el.getAttribute('data-message-turn-id');
      if (!msgId || initialOldMessageIds.has(msgId)) return;

      const role = el.getAttribute('data-message-role') || 'unknown';
      let text = '';

      let surrogateText = '';
      const surrogate = el.querySelector('[data-message-accessibility-surrogate="true"]');
      if (surrogate && surrogate.textContent) {
        surrogateText = surrogate.textContent.trim().replace(/^(Assistant|User)\s+message:\s*/i, '').trim();
      }

      let proseText = '';
      const bodyEl = el.querySelector('[data-hatch-assistant-message-body="true"]') ||
                     el.querySelector('.prose') ||
                     el.querySelector('.hatch-chat-groupable-bubble');
      if (bodyEl) {
        proseText = (bodyEl.innerText || bodyEl.textContent || '').trim();
        proseText = proseText.replace(/^(You|Assistant):\s*/i, '').trim();
      }

      if (proseText && surrogateText) {
        text = proseText.length >= surrogateText.length ? proseText : surrogateText;
      } else {
        text = proseText || surrogateText || '';
      }

      if (!text) return;

      const isStreaming = el.querySelector('[data-hatch-markdown-streaming="true"]') !== null ||
                          el.getAttribute('aria-busy') === 'true' ||
                          el.querySelector('[aria-busy="true"]') !== null;

      let entry = trackedMessages.get(msgId);
      if (!entry) {
        entry = { lastSentText: '', debounceTimer: null };
        trackedMessages.set(msgId, entry);
      }

      if (text === entry.lastSentText) return;

      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        entry.lastSentText = text;
        sendChatMessage(msgId, role, text);
      }, isStreaming ? 1000 : 400);
    });
  }

  function sendChatMessage(msgId, role, text) {
    chrome.runtime.sendMessage({
      type: 'chat_stream',
      message: {
        id: msgId,
        role: role,
        text: text,
        timestamp: new Date().toLocaleTimeString()
      }
    }).catch(() => {});

    if (role === 'assistant') {
      sendStatus('online');
    }
  }

  // ── Utilities ──────────────────────────────────────────
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Start ──────────────────────────────────────────────
  init();
  startChatMonitor();

})();
