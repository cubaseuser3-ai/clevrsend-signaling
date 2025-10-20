/**
 * ClevrSend Signaling Server
 * Compatible with LocalSend protocol
 *
 * Deploy to: Deno Deploy, Cloudflare Workers, or any Deno runtime
 * URL: wss://signal.clevrsend.app
 */

interface ClientInfo {
  alias: string;
  version: string;
  deviceModel?: string;
  deviceType?: string;
  token: string;
}

interface Client {
  id: string;
  socket: WebSocket;
  info: ClientInfo | null;
  lastPing: number;
}

// Store all connected clients
const clients = new Map<string, Client>();

// Cleanup interval (remove dead connections)
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes

  for (const [id, client] of clients.entries()) {
    if (now - client.lastPing > timeout) {
      console.log(`Removing inactive client: ${id}`);
      client.socket.close();
      clients.delete(id);
      broadcast({
        type: "LEFT",
        peerId: id,
      });
    }
  }
}, 60 * 1000); // Check every minute

Deno.serve({ port: 8080 }, (req) => {
  const url = new URL(req.url);

  // Health check endpoint
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      clients: clients.size,
      uptime: performance.now(),
    }), {
      headers: { "content-type": "application/json" },
    });
  }

  // WebSocket upgrade
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Expected WebSocket connection", { status: 426 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const clientId = crypto.randomUUID();

  // Parse initial client info from query parameter (Base64 encoded)
  const encodedInfo = url.searchParams.get("d");
  let initialInfo: ClientInfo | null = null;

  if (encodedInfo) {
    try {
      const decoded = atob(encodedInfo);
      initialInfo = JSON.parse(decoded);
      console.log(`New client connecting: ${initialInfo.alias} (${clientId})`);
    } catch (e) {
      console.error("Failed to parse client info:", e);
    }
  }

  socket.addEventListener("open", () => {
    const client: Client = {
      id: clientId,
      socket,
      info: initialInfo,
      lastPing: Date.now(),
    };

    clients.set(clientId, client);

    // Send HELLO message with current client ID and list of all other peers
    const peers = Array.from(clients.values())
      .filter(c => c.id !== clientId && c.info)
      .map(c => ({ ...c.info!, id: c.id }));

    const helloMessage = {
      type: "HELLO",
      client: { ...initialInfo, id: clientId },
      peers,
    };

    socket.send(JSON.stringify(helloMessage));
    console.log(`Client ${clientId} connected. Total clients: ${clients.size}`);

    // Notify all other clients about the new peer
    if (initialInfo) {
      broadcast({
        type: "JOIN",
        peer: { ...initialInfo, id: clientId },
      }, clientId);
    }
  });

  socket.addEventListener("message", (event) => {
    const client = clients.get(clientId);
    if (!client) return;

    // Update last ping time
    client.lastPing = Date.now();

    // Handle ping (empty message)
    if (!event.data || event.data === "") {
      return;
    }

    try {
      const message = JSON.parse(event.data.toString());
      handleMessage(clientId, message, client);
    } catch (e) {
      console.error(`Failed to parse message from ${clientId}:`, e);
    }
  });

  socket.addEventListener("close", () => {
    const client = clients.get(clientId);
    if (client) {
      console.log(`Client ${clientId} disconnected. Total clients: ${clients.size - 1}`);
      clients.delete(clientId);

      // Notify all other clients about the peer leaving
      broadcast({
        type: "LEFT",
        peerId: clientId,
      });
    }
  });

  socket.addEventListener("error", (error) => {
    console.error(`WebSocket error for client ${clientId}:`, error);
  });

  return response;
});

function handleMessage(senderId: string, message: any, sender: Client) {
  switch (message.type) {
    case "UPDATE":
      // Update client info
      sender.info = message.info;
      console.log(`Client ${senderId} updated info:`, message.info.alias);

      // Broadcast update to all other clients
      broadcast({
        type: "UPDATE",
        peer: { ...message.info, id: senderId },
      }, senderId);
      break;

    case "OFFER":
      // Forward OFFER to target peer
      const offerTarget = clients.get(message.target);
      if (offerTarget && offerTarget.socket.readyState === WebSocket.OPEN) {
        offerTarget.socket.send(JSON.stringify({
          type: "OFFER",
          peer: { ...sender.info, id: senderId },
          sessionId: message.sessionId,
          sdp: message.sdp,
        }));
        console.log(`Forwarded OFFER from ${senderId} to ${message.target}`);
      } else {
        console.warn(`Target ${message.target} not found or not ready`);
      }
      break;

    case "ANSWER":
      // Forward ANSWER to target peer
      const answerTarget = clients.get(message.target);
      if (answerTarget && answerTarget.socket.readyState === WebSocket.OPEN) {
        answerTarget.socket.send(JSON.stringify({
          type: "ANSWER",
          peer: { ...sender.info, id: senderId },
          sessionId: message.sessionId,
          sdp: message.sdp,
        }));
        console.log(`Forwarded ANSWER from ${senderId} to ${message.target}`);
      } else {
        console.warn(`Target ${message.target} not found or not ready`);
      }
      break;

    case "QR_ANSWER":
      // Forward QR_ANSWER to target peer (for QR-Connect one-way handshake)
      const qrTarget = clients.get(message.targetId);
      if (qrTarget && qrTarget.socket.readyState === WebSocket.OPEN) {
        qrTarget.socket.send(JSON.stringify({
          type: "QR_ANSWER",
          answer: message.answer,
          senderId: senderId,
        }));
        console.log(`Forwarded QR_ANSWER from ${senderId} to ${message.targetId}`);
      } else {
        console.warn(`QR_ANSWER target ${message.targetId} not found or not ready`);
      }
      break;

    default:
      console.warn(`Unknown message type: ${message.type}`);
  }
}

function broadcast(message: any, excludeId?: string) {
  const data = JSON.stringify(message);
  let sent = 0;

  for (const [id, client] of clients) {
    if (id !== excludeId && client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(data);
      sent++;
    }
  }

  console.log(`Broadcasted ${message.type} to ${sent} clients`);
}

console.log("ClevrSend Signaling Server started on port 8080");
console.log("WebSocket endpoint: ws://localhost:8080");
console.log("Health check: http://localhost:8080/health");
