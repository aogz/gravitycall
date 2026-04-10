const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// CORS for extension access
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/opentok', express.static(path.join(__dirname, 'opentok')));

// --- OpenTok session management ---
let opentok = null;
const opentokApiKey = process.env.OPENTOK_API_KEY;
const opentokApiSecret = process.env.OPENTOK_API_SECRET;

if (opentokApiKey && opentokApiSecret) {
    const OpenTok = require('opentok');
    opentok = new OpenTok(opentokApiKey, opentokApiSecret);
    console.log('OpenTok enabled');
} else {
    console.log('OpenTok disabled (set OPENTOK_API_KEY and OPENTOK_API_SECRET to enable)');
}

// Session cache: roomId -> sessionId
const sessionCache = {};

app.post('/session', (req, res) => {
    if (!opentok) {
        return res.status(503).json({ error: 'OpenTok not configured' });
    }

    const roomId = req.body.roomId || 'default';
    const color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');

    if (sessionCache[roomId]) {
        const token = opentok.generateToken(sessionCache[roomId], {
            role: 'publisher',
            expireTime: Math.round(Date.now() / 1000) + 86400,
            data: JSON.stringify({ color })
        });
        return res.json({
            apiKey: opentokApiKey,
            sessionId: sessionCache[roomId],
            token,
            color
        });
    }

    opentok.createSession({ mediaMode: 'relayed' }, (err, session) => {
        if (err) {
            console.error('Error creating OpenTok session:', err);
            return res.status(500).json({ error: err.message });
        }

        sessionCache[roomId] = session.sessionId;
        const token = opentok.generateToken(session.sessionId, {
            role: 'publisher',
            expireTime: Math.round(Date.now() / 1000) + 86400,
            data: JSON.stringify({ color })
        });

        console.log(`Created OpenTok session for room: ${roomId}`);
        res.json({
            apiKey: opentokApiKey,
            sessionId: session.sessionId,
            token,
            color
        });
    });
});

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
