const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
    server,
    perMessageDeflate: false
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Dados compartilhados
let sharedData = {
    clientes: [],
    vendas: [],
    gastos: []
};

// Clientes conectados por sala
const rooms = new Map();

// Quando um cliente se conecta
wss.on('connection', (ws) => {
    console.log('Novo cliente conectado');
    ws.clientId = Math.random().toString(36).substr(2, 9);
    ws.room = null;

    // Quando recebe uma mensagem
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join-room') {
                const room = data.room || 'default';
                ws.room = room;

                // Criar sala se não existir
                if (!rooms.has(room)) {
                    rooms.set(room, {
                        clients: new Set(),
                        data: {
                            clientes: [],
                            vendas: [],
                            gastos: []
                        }
                    });
                }

                const roomData = rooms.get(room);
                roomData.clients.add(ws);

                // Enviar dados atuais para o novo cliente
                ws.send(JSON.stringify({
                    type: 'sync',
                    data: roomData.data,
                    clients: roomData.clients.size
                }));

                // Notificar outros clientes na sala
                roomData.clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'user-joined',
                            clients: roomData.clients.size
                        }));
                    }
                });

                console.log(`Cliente ${ws.clientId} entrou na sala ${room}`);
            }

            if (data.type === 'update' && ws.room) {
                const roomData = rooms.get(ws.room);
                if (roomData) {
                    roomData.data = data.data;

                    // Enviar para todos os clientes na sala
                    roomData.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'sync',
                                data: roomData.data
                            }));
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
        }
    });

    // Quando o cliente se desconecta
    ws.on('close', () => {
        console.log('Cliente desconectado:', ws.clientId);
        
        if (ws.room) {
            const roomData = rooms.get(ws.room);
            if (roomData) {
                roomData.clients.delete(ws);
                
                // Notificar outros clientes
                roomData.clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'user-left',
                            clients: roomData.clients.size
                        }));
                    }
                });

                // Deletar sala se vazia
                if (roomData.clients.size === 0) {
                    rooms.delete(ws.room);
                }
            }
        }
    });

    // Tratamento de erros
    ws.on('error', (error) => {
        console.error('Erro WebSocket:', error);
    });
});

// Rota para obter dados via HTTP
app.get('/api/dados', (req, res) => {
    res.json(sharedData);
});

// Rota de saúde
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        rooms: rooms.size,
        clients: Array.from(rooms.values()).reduce((sum, r) => sum + r.clients.size, 0)
    });
});

// Servir página principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🍞 Servidor rodando na porta ${PORT}`);
    console.log(`WebSocket disponível em ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM recebido, encerrando...');
    server.close(() => {
        console.log('Servidor encerrado');
        process.exit(0);
    });
});
