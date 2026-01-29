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

// Health check endpoint (para Railway e load balancers)
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        rooms: rooms.size
    });
});

// Dados compartilhados por sala (persistência em memória)
const rooms = new Map();

// Configuração de sincronização
const SYNC_INTERVAL = 500; // ms - enviar sync a cada 500ms
const HEARTBEAT_INTERVAL = 30000; // ms - verificar conexões a cada 30s
const TOMBSTONE_TTL = 24 * 60 * 60 * 1000; // 24 horas

// Quando um cliente se conecta
wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    console.log(`✓ Cliente conectado: ${clientId}`);
    
    ws.clientId = clientId;
    ws.room = null;
    ws.isAlive = true;
    ws.lastSync = Date.now();

    // Heartbeat para detectar conexões inativas
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    // Quando recebe uma mensagem
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join-room') {
                const room = data.room || 'default';
                const previousRoom = ws.room;
                
                // Remover de sala anterior se existir
                if (previousRoom && rooms.has(previousRoom)) {
                    const oldRoomData = rooms.get(previousRoom);
                    oldRoomData.clients.delete(ws);
                    
                    // Notificar saída
                    oldRoomData.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'user-left',
                                clients: oldRoomData.clients.size
                            }));
                        }
                    });
                }

                ws.room = room;

                // Criar sala se não existir
                if (!rooms.has(room)) {
                    console.log(`📍 Nova sala criada: ${room}`);
                    rooms.set(room, {
                        clients: new Set(),
                        data: {
                            clientes: [],
                            vendas: [],
                            gastos: []
                        },
                        tombstones: {
                            clientes: new Map(),
                            vendas: new Map(),
                            gastos: new Map()
                        },
                        lastUpdate: Date.now(),
                        syncTimer: null
                    });
                }

                const roomData = rooms.get(room);
                roomData.clients.add(ws);

                // Enviar dados atuais para o novo cliente
                ws.send(JSON.stringify({
                    type: 'sync',
                    data: roomData.data,
                    clients: roomData.clients.size,
                    timestamp: Date.now()
                }));

                // Notificar outros clientes na sala
                roomData.clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'user-joined',
                            clients: roomData.clients.size,
                            timestamp: Date.now()
                        }));
                    }
                });

                console.log(`✓ Cliente ${clientId} entrou em ${room} (${roomData.clients.size} total)`);
                
                return; // Importante: retornar aqui para evitar processar 'update' junto com 'join-room'
            }

            if (data.type === 'update' && ws.room) {
                const roomData = rooms.get(ws.room);
                if (roomData) {
                    // Merge LWW entre estado do servidor e estado enviado
                    mergeRoomData(roomData, data.data || {});
                    roomData.lastUpdate = Date.now();

                    // Broadcast do estado consolidado
                    const payload = JSON.stringify({
                        type: 'sync',
                        data: roomData.data,
                        clients: roomData.clients.size,
                        timestamp: Date.now()
                    });
                    roomData.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(payload);
                        }
                    });
                }
            }

            // Mensagem específica de deleção (tombstone)
            if (data.type === 'delete' && ws.room) {
                const roomData = rooms.get(ws.room);
                if (roomData) {
                    const entity = data.entity; // 'clientes' | 'vendas' | 'gastos'
                    const id = data.id;
                    const when = data.timestamp || Date.now();
                    if (roomData.tombstones && roomData.tombstones[entity]) {
                        roomData.tombstones[entity].set(id, when);
                    }
                    // remover do dataset principal
                    if (roomData.data && Array.isArray(roomData.data[entity])) {
                        roomData.data[entity] = roomData.data[entity].filter(item => item.id !== id);
                    }
                    roomData.lastUpdate = Date.now();

                    // Broadcast do estado atualizado
                    const payload = JSON.stringify({
                        type: 'sync',
                        data: roomData.data,
                        clients: roomData.clients.size,
                        timestamp: Date.now()
                    });
                    roomData.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) client.send(payload);
                    });
                }
            }
        } catch (error) {
            console.error('❌ Erro ao processar mensagem:', error);
        }
    });

    // Quando o cliente se desconecta
    ws.on('close', () => {
        console.log(`✗ Cliente desconectado: ${clientId}`);
        
        if (ws.room) {
            const roomData = rooms.get(ws.room);
            if (roomData) {
                roomData.clients.delete(ws);
                
                // Notificar outros clientes
                if (roomData.clients.size > 0) {
                    roomData.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'user-left',
                                clients: roomData.clients.size
                            }));
                        }
                    });
                    console.log(`ℹ Sala ${ws.room} agora tem ${roomData.clients.size} cliente(s)`);
                } else {
                    // Deletar sala se vazia após 1 hora
                    console.log(`📍 Sala ${ws.room} vazia - será deletada em 1 hora`);
                    setTimeout(() => {
                        if (rooms.get(ws.room) && rooms.get(ws.room).clients.size === 0) {
                            rooms.delete(ws.room);
                            console.log(`🗑️ Sala ${ws.room} deletada`);
                        }
                    }, 3600000); // 1 hora
                }
            }
        }
    });

    // Tratamento de erros
    ws.on('error', (error) => {
        console.error(`❌ Erro WebSocket (${clientId}):`, error.message);
    });
});

// Função de merge LWW (last-write-wins) para o estado da sala
function mergeRoomData(roomData, incoming) {
    const types = ['clientes', 'vendas', 'gastos'];

    types.forEach(type => {
        const localArr = Array.isArray(roomData.data[type]) ? roomData.data[type] : [];
        const remoteArr = Array.isArray(incoming[type]) ? incoming[type] : [];

        const map = new Map();

        // inserir locais
        localArr.forEach(item => {
            map.set(item.id, { ...item });
        });

        // mesclar remotos (LWW)
        remoteArr.forEach(item => {
            const existing = map.get(item.id);
            const tRemote = item.lastUpdated || 0;
            const tLocal = existing ? (existing.lastUpdated || 0) : 0;
            if (!existing || tRemote >= tLocal) {
                map.set(item.id, { ...item });
            }
        });

        // aplicar tombstones: remover entries cujo tombstone é mais recente
        if (roomData.tombstones && roomData.tombstones[type]) {
            roomData.tombstones[type].forEach((ts, tombId) => {
                const entry = map.get(tombId);
                if (entry) {
                    const tEntry = entry.lastUpdated || 0;
                    if (ts >= tEntry) map.delete(tombId);
                }
            });
        }

        // atualizar array
        roomData.data[type] = Array.from(map.values());
    });
}

// Limpeza periódica de tombstones antigos
setInterval(() => {
    const now = Date.now();
    rooms.forEach((roomData, name) => {
        if (!roomData.tombstones) return;
        ['clientes','vendas','gastos'].forEach(type => {
            const tsMap = roomData.tombstones[type];
            if (!tsMap) return;
            tsMap.forEach((ts, id) => {
                if (now - ts > TOMBSTONE_TTL) tsMap.delete(id);
            });
        });
    });
}, 60 * 60 * 1000); // a cada hora

// Rota para obter dados via HTTP
app.get('/api/dados', (req, res) => {
    const roomsInfo = Array.from(rooms.entries()).map(([name, data]) => ({
        name,
        clients: data.clients.size,
        lastUpdate: new Date(data.lastUpdate).toISOString()
    }));
    
    res.json({ 
        rooms: roomsInfo,
        totalRooms: rooms.size,
        totalClients: Array.from(rooms.values()).reduce((sum, r) => sum + r.clients.size, 0)
    });
});

// Rota de saúde
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
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
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    const baseUrl = process.env.NODE_ENV === 'production' 
        ? `https://${process.env.RAILWAY_DOMAIN || 'app.railway.app'}`
        : `http://localhost:${PORT}`;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🍞 PAES CASEIROS SYNC - Servidor WebSocket Ativo`);
    console.log(`${'='.repeat(60)}`);
    console.log(`📡 Servidor: ${baseUrl}`);
    console.log(`🔗 WebSocket: ${baseUrl.replace('http://', 'ws://').replace('https://', 'wss://')}`);
    console.log(`❤️  Health Check: ${baseUrl}/health`);
    console.log(`🏠 HOST:PORT: ${HOST}:${PORT}`);
    console.log(`${'='.repeat(60)}\n`);
});

// Verificar conexões a cada 30 segundos (heartbeat)
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n⚠️  SIGTERM recebido, encerrando gracefully...');
    
    // Enviar mensagem de desconexão para todos os clientes
    wss.clients.forEach((ws) => {
        ws.send(JSON.stringify({
            type: 'server-shutdown',
            message: 'Servidor está sendo reiniciado'
        }));
        ws.close(1000, 'Server shutdown');
    });
    
    server.close(() => {
        console.log('✓ Servidor encerrado com sucesso');
        process.exit(0);
    });
    
    // Force close após 10 segundos
    setTimeout(() => {
        console.log('❌ Fechamento forçado');
        process.exit(1);
    }, 10000);
});
