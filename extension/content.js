// ============================================================
//  Muse Agent Orchestrator — Content Script v3
//  Injected into muse.ai pages.
//
//  Features:
//   - Relays through background service worker (No Mixed Content block)
//   - XPath-based DOM targeting
//   - New Chat button click (optional)
//   - Auto-type + Enter key to send
//   - Real-time response streaming capture via MutationObserver
//   - React/Vue/Angular compatible input handling
// ============================================================

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────
  let config = {
    inputXPath: '/html/body/div[2]/div/div/div/div/div[1]/div/div[3]/div/div/div[3]/div/div/div[1]/div/textarea',
    newChatButtonXPath: '/html/body/div[2]/div/div/div/div/div[1]/div/div[1]/div/div/div[4]/div/div/nav/div/div[2]/div/div/div/div[1]/section/div[1]/span/button',
    responseXPath: ''
  };

  // ── Initialize ─────────────────────────────────────────
  async function init() {
    console.log('[Muse Orchestrator] Content script loaded on', window.location.href);

    const stored = await chrome.storage.local.get([
      'inputXPath', 'newChatButtonXPath', 'responseXPath'
    ]);

    if (stored.inputXPath) config.inputXPath = stored.inputXPath;
    if (stored.newChatButtonXPath) config.newChatButtonXPath = stored.newChatButtonXPath;
    if (stored.responseXPath) config.responseXPath = stored.responseXPath;

    // Notify background script that this tab is active and online
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

    if (data.action === 'close_tab') {
      console.log('[Muse Orchestrator] Received close_tab command.');
      try {
        window.close();
      } catch (e) {}
      setTimeout(() => { window.location.href = 'about:blank'; }, 500);
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
        console.log('[Muse Orchestrator] Opening new chat...');
        const newChatBtn = findElementByXPath(config.newChatButtonXPath);
        if (!newChatBtn) {
          throw new Error(`New Chat button not found! XPath: "${config.newChatButtonXPath}"`);
        }
        newChatBtn.click();
        await sleep(2000); // Wait for new chat to load
      }

      // Step 2: Find the textarea
      let inputEl = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        inputEl = findElementByXPath(config.inputXPath);
        if (inputEl) break;
        await sleep(1000);
      }

      if (!inputEl) {
        throw new Error(`Input textarea not found after retries! XPath: "${config.inputXPath}"`);
      }

      // Step 3: Type the message into the textarea
      await setInputValue(inputEl, message);
      await sleep(300);

      // Step 4: Press Enter to send
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
    } catch (err) {
      console.error('[Muse Orchestrator] Error:', err);
      sendAck(false, err.message);
      sendStatus('error');
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
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    }));
    element.dispatchEvent(new KeyboardEvent('keypress', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    }));
    element.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true
    }));
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
    // Immediately mark whatever is already in DOM as old
    markExistingMessagesAsSeen();

    // Allow 2.5s for initial thread hydration to finish, then seal old messages
    setTimeout(() => {
      markExistingMessagesAsSeen();
      isInitialScanDone = true;
      console.log(`[Muse Orchestrator] Ignored ${initialOldMessageIds.size} old messages. Listening for NEW messages only.`);
    }, 2500);

    // MutationObserver to capture new messages as they stream in
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

    // Fallback interval polling every 1 second
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

      const role = el.getAttribute('data-message-role') || 'unknown'; // 'assistant' or 'user'
      let text = '';

      // Strategy 1: Check accessibility surrogate
      let surrogateText = '';
      const surrogate = el.querySelector('[data-message-accessibility-surrogate="true"]');
      if (surrogate && surrogate.textContent) {
        surrogateText = surrogate.textContent.trim().replace(/^(Assistant|User)\s+message:\s*/i, '').trim();
      }

      // Strategy 2: Check prose / bubble innerText (contains full multi-paragraph text)
      let proseText = '';
      const bodyEl = el.querySelector('[data-hatch-assistant-message-body="true"]') ||
                     el.querySelector('.prose') ||
                     el.querySelector('.hatch-chat-groupable-bubble');
      if (bodyEl) {
        proseText = (bodyEl.innerText || bodyEl.textContent || '').trim();
        proseText = proseText.replace(/^(You|Assistant):\s*/i, '').trim();
      }

      // Pick whichever text is longer / more complete
      if (proseText && surrogateText) {
        text = proseText.length >= surrogateText.length ? proseText : surrogateText;
      } else {
        text = proseText || surrogateText || '';
      }

      if (!text) return; // Still empty or rendering

      // Check if Muse is currently still streaming words
      const isStreaming = el.querySelector('[data-hatch-markdown-streaming="true"]') !== null ||
                          el.getAttribute('aria-busy') === 'true' ||
                          el.querySelector('[aria-busy="true"]') !== null;

      let entry = trackedMessages.get(msgId);
      if (!entry) {
        entry = { lastSentText: '', debounceTimer: null };
        trackedMessages.set(msgId, entry);
      }

      // If text hasn't changed, skip
      if (text === entry.lastSentText) return;

      // When text changes, debounce to allow full sentence/response to complete!
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        entry.lastSentText = text;
        sendChatMessage(msgId, role, text);
      }, isStreaming ? 1000 : 400);
    });
  }

  function sendChatMessage(msgId, role, text) {
    console.log('[Muse Orchestrator] Relaying chat message to background:', role, text.substring(0, 60));

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
