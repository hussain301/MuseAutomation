// ============================================================
//  Muse Agent Orchestrator — Central Server v2
//  Features: Agent numbering, variable substitution,
//            response tracking, resend support
// ============================================================

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const path = require('path');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// ── Serve Admin Dashboard ──────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket Server ───────────────────────────────────────
const wss = new WebSocketServer({ server });

// ── State ──────────────────────────────────────────────────
const agents = new Map();       // ws => agentInfo
const admins = new Set();       // ws set
let nextAgentNumber = 1;        // Sequential numbering for {x}
let lastBroadcast = null;       // Store last broadcast for resend

// ── Helpers ────────────────────────────────────────────────
function broadcast(targets, data) {
  const msg = JSON.stringify(data);
  targets.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function broadcastToAdmins(data) {
  broadcast(admins, data);
}

function getAgentList() {
  const list = [];
  agents.forEach((info) => list.push(info));
  return list;
}

function sendAgentListToAdmins() {
  broadcastToAdmins({ type: 'agents_update', agents: getAgentList() });
}

function sendLog(logType, text) {
  broadcastToAdmins({
    type: 'log',
    logType,
    text,
    timestamp: new Date().toLocaleTimeString()
  });
}

/**
 * Substitute variables in message for a specific agent.
 * Supported: {x} = agent number, {name} = agent name,
 *            {id} = agent ID, {total} = total agents
 */
function substituteVariables(template, agentInfo) {
  return template
    .replace(/\{x\}/gi, agentInfo.number)
    .replace(/\{name\}/gi, agentInfo.name)
    .replace(/\{id\}/gi, agentInfo.agentId || agentInfo.id)
    .replace(/\{total\}/gi, agents.size);
}

// ── Handle Connections ─────────────────────────────────────
wss.on('connection', (ws) => {
  let clientType = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return;
    }

    // ─── Registration ─────────────────────────────────
    if (data.type === 'register') {
      clientType = data.role;

      if (clientType === 'admin') {
        admins.add(ws);
        console.log('[★] Admin connected');
        ws.send(JSON.stringify({ type: 'agents_update', agents: getAgentList() }));
        if (lastBroadcast) {
          ws.send(JSON.stringify({ type: 'last_broadcast', data: lastBroadcast }));
        }
        sendLog('info', 'Admin panel connected.');
      }

      if (clientType === 'agent') {
        const agentNumber = nextAgentNumber++;
        const agentInfo = {
          id: data.agentId || `agent-${Date.now()}`,
          agentId: data.agentId || '',
          name: data.name || `Agent-${agentNumber}`,
          number: agentNumber,
          url: data.url || '',
          status: 'online',
          connectedAt: new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          lastMessageSentAt: null,
          lastResponse: null,
          responseStatus: null   // null | 'waiting' | 'received' | 'timeout' | 'error'
        };
        agents.set(ws, agentInfo);
        console.log(`[+] Agent #${agentNumber} connected: ${agentInfo.name} (${agentInfo.id})`);
        
        // Tell the agent its number
        ws.send(JSON.stringify({ type: 'assigned', number: agentNumber }));
        
        sendAgentListToAdmins();
        sendLog('connect', `Agent #${agentNumber} "${agentInfo.name}" connected`);
      }
      return;
    }

    // ─── Agent messages ───────────────────────────────
    if (clientType === 'agent') {
      const info = agents.get(ws);
      if (!info) return;

      if (data.type === 'status') {
        if (data.status) info.status = data.status;
        if (data.url) info.url = data.url;
        info.lastSeen = new Date().toISOString();
        sendAgentListToAdmins();
      }

      if (data.type === 'ack') {
        info.status = data.success ? 'online' : 'error';
        info.lastSeen = new Date().toISOString();
        if (data.success) {
          info.responseStatus = 'waiting';
        } else {
          info.responseStatus = 'error';
        }
        sendAgentListToAdmins();
        sendLog(
          data.success ? 'success' : 'error',
          `[#${info.number} ${info.name}] ${data.message || (data.success ? 'Message typed & sent ✓' : 'Failed to send ✗')}`
        );
      }

      // Agent captured a response from Muse chat
      if (data.type === 'response') {
        info.lastResponse = data.response || '';
        info.responseStatus = 'received';
        info.lastSeen = new Date().toISOString();
        info.status = 'online';
        sendAgentListToAdmins();
        
        const preview = info.lastResponse.length > 100
          ? info.lastResponse.substring(0, 100) + '...'
          : info.lastResponse;
        sendLog('response', `[#${info.number} ${info.name}] Response: "${preview}"`);
        
        // Also send dedicated response event for admin
        broadcastToAdmins({
          type: 'agent_response',
          agentId: info.id,
          agentNumber: info.number,
          agentName: info.name,
          response: info.lastResponse,
          timestamp: new Date().toLocaleTimeString()
        });
      }

      // Agent reports no response after timeout
      if (data.type === 'response_timeout') {
        info.responseStatus = 'timeout';
        info.lastSeen = new Date().toISOString();
        info.status = 'online';
        sendAgentListToAdmins();
        sendLog('warning', `[#${info.number} ${info.name}] No response received (timeout)`);
      }
    }

    // ─── Admin messages ───────────────────────────────
    if (clientType === 'admin') {

      // Broadcast message to all or selected agents
      if (data.type === 'send_message') {
        const { message, targetIds, newChat, responseTimeout } = data;
        if (!message || !message.trim()) return;

        const preview = message.length > 50 ? message.substring(0, 50) + '...' : message;
        sendLog('info', `📡 Broadcasting: "${preview}" | New Chat: ${newChat ? 'YES' : 'NO'}`);

        // Store for resend
        lastBroadcast = { message, newChat, responseTimeout, timestamp: new Date().toISOString() };

        const sendToAgent = (agentWs, info) => {
          if (agentWs.readyState !== 1) return;
          
          // Substitute variables for this specific agent
          const personalizedMessage = substituteVariables(message, info);
          
          info.status = 'typing';
          info.responseStatus = 'waiting';
          info.lastResponse = null;
          info.lastMessageSentAt = new Date().toISOString();
          
          agentWs.send(JSON.stringify({
            type: 'command',
            action: 'send_message',
            message: personalizedMessage,
            newChat: !!newChat,
            responseTimeout: responseTimeout || 60
          }));
        };

        if (!targetIds || targetIds === 'ALL') {
          agents.forEach((info, agentWs) => sendToAgent(agentWs, info));
        } else if (Array.isArray(targetIds)) {
          agents.forEach((info, agentWs) => {
            if (targetIds.includes(info.id)) sendToAgent(agentWs, info);
          });
        }
        sendAgentListToAdmins();
      }

      // Resend to specific agent(s)
      if (data.type === 'resend') {
        const { targetIds, message, newChat } = data;
        if (!targetIds || !Array.isArray(targetIds)) return;
        
        const msgToSend = message || (lastBroadcast ? lastBroadcast.message : '');
        if (!msgToSend) return;

        sendLog('info', `🔄 Resending to ${targetIds.length} agent(s)...`);

        agents.forEach((info, agentWs) => {
          if (targetIds.includes(info.id) && agentWs.readyState === 1) {
            const personalizedMessage = substituteVariables(msgToSend, info);
            info.status = 'typing';
            info.responseStatus = 'waiting';
            info.lastResponse = null;
            info.lastMessageSentAt = new Date().toISOString();
            
            agentWs.send(JSON.stringify({
              type: 'command',
              action: 'send_message',
              message: personalizedMessage,
              newChat: !!newChat,
              responseTimeout: 60
            }));
          }
        });
        sendAgentListToAdmins();
      }

      // Update XPath config on agents
      if (data.type === 'update_config') {
        const configMsg = JSON.stringify({
          type: 'command',
          action: 'update_config',
          config: data.config
        });
        agents.forEach((info, agentWs) => {
          if (agentWs.readyState === 1) agentWs.send(configMsg);
        });
        sendLog('info', `⚙️ XPath config pushed to ${agents.size} agent(s).`);
      }

      // Close all Chrome browsers on this machine (taskkill)
      if (data.type === 'close_all_browsers') {
        const agentCount = agents.size;
        sendLog('warning', `🔴 Closing ALL Chrome browsers on server machine... (${agentCount} agents will disconnect)`);
        
        exec('taskkill /F /IM chrome.exe', (err, stdout, stderr) => {
          if (err) {
            sendLog('error', `Failed to close browsers: ${err.message}`);
          } else {
            sendLog('success', `All Chrome browsers closed successfully.`);
          }
        });
      }

      // Close specific agent tabs (via extension command)
      if (data.type === 'close_agents') {
        const { targetIds } = data;
        if (!targetIds || !Array.isArray(targetIds)) return;

        sendLog('warning', `🔴 Closing ${targetIds.length} agent tab(s)...`);

        agents.forEach((info, agentWs) => {
          if (targetIds.includes(info.id) && agentWs.readyState === 1) {
            agentWs.send(JSON.stringify({
              type: 'command',
              action: 'close_tab'
            }));
          }
        });
      }
    }
  });

  // ─── Disconnect ───────────────────────────────────────
  ws.on('close', () => {
    if (admins.has(ws)) {
      admins.delete(ws);
      console.log('[★] Admin disconnected');
    }
    if (agents.has(ws)) {
      const info = agents.get(ws);
      console.log(`[-] Agent #${info.number} disconnected: ${info.name}`);
      sendLog('disconnect', `Agent #${info.number} "${info.name}" disconnected.`);
      agents.delete(ws);
      sendAgentListToAdmins();
    }
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
  });
});

// ── Heartbeat ──────────────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ── Start ──────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log(`🚀 Muse Orchestrator v2 running on http://0.0.0.0:${PORT}`);
  console.log(`💻 Admin Panel: http://localhost:${PORT}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
});
