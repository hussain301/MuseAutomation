# 🎛️ Muse Agent Orchestrator

**Azure VMs par chalte multiple Muse AI agents ko ek central admin panel se control karo.**

## Architecture

```
┌──────────────┐          WebSocket         ┌──────────────────┐
│  Admin Panel  │◄────────────────────────►  │  Node.js Server  │
│  (Your PC)    │                            │  (Central Hub)   │
└──────────────┘                            └──────┬───────────┘
                                                   │ WebSocket
                          ┌────────────────────────┼────────────────────────┐
                          │                        │                        │
                   ┌──────▼──────┐          ┌──────▼──────┐          ┌──────▼──────┐
                   │  Extension  │          │  Extension  │          │  Extension  │
                   │  Azure VM 1 │          │  Azure VM 2 │          │  Azure VM 3 │
                   │  (muse.ai)  │          │  (muse.ai)  │          │  (muse.ai)  │
                   └─────────────┘          └─────────────┘          └─────────────┘
```

## 📦 Project Structure

```
muse-agent-orchestrator/
├── server/
│   ├── package.json
│   ├── server.js              ← Central WebSocket + HTTP server
│   └── public/
│       └── index.html         ← Admin Dashboard (auto-served)
├── extension/
│   ├── manifest.json          ← Chrome Extension (Manifest V3)
│   ├── content.js             ← Injected in muse.ai — handles typing
│   ├── popup.html             ← Extension popup UI
│   ├── popup.js               ← Popup logic
│   └── icons/
│       ├── icon48.png
│       └── icon128.png
└── README.md
```

## 🚀 Setup

### Step 1: Server Start Karo

```bash
cd server
npm install
npm start
```

Server `http://0.0.0.0:3000` par start hoga. Admin panel bhi isi URL par accessible hoga.

> **Note:** Agar server Azure VM par chal raha hai, tou Azure Portal me NSG (Network Security Group) me port 3000 allow karo.

### Step 2: Chrome Extension Install Karo (Har Azure VM par)

1. Chrome kholein Azure VM par
2. `chrome://extensions` par jaao
3. **Developer mode** ON karo (top-right toggle)
4. **"Load unpacked"** click karo
5. `extension/` folder select karo
6. Extension install ho jayegi

### Step 3: Extension Configure Karo

1. Extension icon (top-right) par click karo
2. **Server URL** daalo: `ws://YOUR_SERVER_IP:3000`
3. **Agent Name** daalo: e.g. `Azure-VM-1`
4. **Save & Reconnect** click karo
5. Make sure muse.ai ka tab khula ho

### Step 4: Admin Panel me XPath Set Karo

1. Apne PC par browser me kholein: `http://YOUR_SERVER_IP:3000`
2. **XPath Configuration** section me:
   - **Chat Input Textarea XPath** daalo (Muse ka input box)
   - **Send Button XPath** daalo (Muse ka send button)
3. **"Push Config to All Agents"** click karo

### Step 5: Message Broadcast Karo! 🎉

1. Admin Panel me message likhein
2. **"Send to All"** ya specific agents select karke **"Send to Selected"** click karo
3. Message automatically sabhi connected Muse agent chats me type aur send ho jayega

## ⌨️ Shortcuts

- **Ctrl + Enter** — Quickly send message from admin panel

## 🔧 XPath Kaise Find Karo (Muse.ai ke liye)

1. Muse.ai kholein browser me
2. Chat input box par **right-click** → **Inspect**
3. DevTools me highlighted element par **right-click** → **Copy** → **Copy XPath**
4. Send button ke liye bhi same karo
5. Admin Panel me paste karo

## ⚡ Features

- ✅ Real-time agent monitoring (live/typing/error status)
- ✅ Broadcast messages to all or selected agents
- ✅ XPath-based element targeting (works with any web app)
- ✅ React/Vue/Angular compatible input handling
- ✅ Auto-reconnect with exponential backoff
- ✅ Live logs feed
- ✅ Dark mode admin dashboard
- ✅ Ctrl+Enter shortcut
- ✅ No authentication required (private use)
