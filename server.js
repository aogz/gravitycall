const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// Store connected clients: { socket, id, room, color }
let clients = [];

wss.on('connection', (ws) => {
    const id = Math.random().toString(36).substring(2, 15);
    const color = '#' + Math.floor(Math.random() * 16777215).toString(16);
    console.log(`Client connected: ${id}`);

    // Wait for join message to assign room
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join') {
                const room = data.room || 'default';
                const client = { ws, id, color, room };
                clients.push(client);
                console.log(`Client ${id} joined room: ${room}`);

                // Send welcome message with ID
                ws.send(JSON.stringify({ type: 'welcome', id, color }));

                // Broadcast new peer to others in same room
                broadcast({ type: 'peer-join', id, color }, id, room);

                // Send existing peers from same room to new client
                const existingPeers = clients
                    .filter(c => c.id !== id && c.room === room)
                    .map(c => ({ id: c.id, color: c.color }));

                if (existingPeers.length > 0) {
                    ws.send(JSON.stringify({ type: 'existing-peers', peers: existingPeers }));
                }
            }

            // Direct signaling messages
            if (['offer', 'answer', 'ice-candidate'].includes(data.type)) {
                const targetClient = clients.find(c => c.id === data.target);
                if (targetClient) {
                    data.source = id; // Add source ID so receiver knows who sent it
                    targetClient.ws.send(JSON.stringify(data));
                }
            }
        } catch (e) {
            console.error('Error parsing message:', e);
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${id}`);
        const client = clients.find(c => c.id === id);
        if (client) {
            const room = client.room;
            clients = clients.filter(c => c.id !== id);
            if (room) {
                broadcast({ type: 'peer-leave', id }, id, room);
            }
        }
    });
});

function broadcast(data, excludeId, room) {
    clients.forEach(client => {
        if (client.id !== excludeId && client.room === room && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify(data));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
