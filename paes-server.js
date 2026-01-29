const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const prisma = require('./lib/db');

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

// Dados compartilhados por sala (sync em memória)
const rooms = new Map();

// Configuração de sincronização
const SYNC_INTERVAL = 500; // ms
const HEARTBEAT_INTERVAL = 30000; // ms
const TOMBSTONE_TTL = 24 * 60 * 60 * 1000; // 24 horas

// ============================================
// API REST ENDPOINTS
// ============================================

// Health check
app.get('/health', async (req, res) => {
    try {
        const serverCount = await prisma.server.count();
        res.status(200).json({ 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            rooms: rooms.size,
            servers: serverCount,
            clients: Array.from(wss.clients).length
        });
    } catch (error) {
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// Listar servidores
app.get('/api/servers', async (req, res) => {
    try {
        const servers = await prisma.server.findMany({
            orderBy: { serverNumber: 'asc' },
            include: {
                _count: { select: { clientes: true, vendas: true } }
            }
        });
        res.json(servers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Criar servidor
app.post('/api/servers', async (req, res) => {
    try {
        const { name, serverNumber, isPrincipal } = req.body;
        
        if (!name || !serverNumber) {
            return res.status(400).json({ error: 'Name e serverNumber são obrigatórios' });
        }

        // Se marcar como principal, remover de outros
        if (isPrincipal) {
            await prisma.server.updateMany({
                where: { isPrincipal: true },
                data: { isPrincipal: false }
            });
        }

        const server = await prisma.server.create({
            data: { name, serverNumber, isPrincipal: isPrincipal || false }
        });

        res.json(server);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Definir servidor principal
app.put('/api/servers/:id/set-principal', async (req, res) => {
    try {
        const { id } = req.params;

        // Remover principal de todos
        await prisma.server.updateMany({
            where: { isPrincipal: true },
            data: { isPrincipal: false }
        });

        // Definir novo principal
        const server = await prisma.server.update({
            where: { id: parseInt(id) },
            data: { isPrincipal: true }
        });

        res.json(server);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// WEBSOCKET HANDLERS
// ============================================

wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substr(2, 9);
    console.log(`✓ Cliente conectado: ${clientId}`);
    
    ws.clientId = clientId;
    ws.room = null;
    ws.serverId = null;
    ws.isAlive = true;
    ws.lastSync = Date.now();

    // Heartbeat
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    // Processar mensagens
    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'join-room') {
                const room = data.room || 'default';
                const serverId = data.serverId || 1;
                const previousRoom = ws.room;

                // Sair de sala anterior
                if (previousRoom && rooms.has(previousRoom)) {
                    const oldRoomData = rooms.get(previousRoom);
                    oldRoomData.clients.delete(ws);
                    
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
                ws.serverId = serverId;

                // Carregar dados do banco
                if (!rooms.has(room)) {
                    console.log(`📍 Sala: ${room} | Servidor: ${serverId}`);
                    
                    const dbData = await loadRoomDataFromDB(serverId);
                    
                    rooms.set(room, {
                        clients: new Set(),
                        data: dbData,
                        serverId: serverId,
                        lastUpdate: Date.now(),
                        syncTimer: null
                    });
                }

                const roomData = rooms.get(room);
                roomData.clients.add(ws);

                // Enviar dados iniciais
                ws.send(JSON.stringify({
                    type: 'initial-data',
                    data: roomData.data,
                    clientCount: roomData.clients.size,
                    serverId: serverId
                }));

                // Notificar outros
                roomData.clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'user-joined',
                            clients: roomData.clients.size
                        }));
                    }
                });

                console.log(`👥 ${roomData.clients.size} cliente(s) em ${room}`);
            }

            // Sincronizar dados
            if (data.type === 'sync-data' && ws.room) {
                const roomData = rooms.get(ws.room);
                
                // Merge LWW
                if (data.clientes) {
                    roomData.data.clientes = mergeLWW(roomData.data.clientes, data.clientes);
                }
                if (data.vendas) {
                    roomData.data.vendas = mergeLWW(roomData.data.vendas, data.vendas);
                }
                if (data.gastos) {
                    roomData.data.gastos = mergeLWW(roomData.data.gastos, data.gastos);
                }

                // Persistir no banco
                await saveRoomDataToDB(ws.serverId, roomData.data);

                // Broadcast
                broadcastToRoom(ws.room, {
                    type: 'sync-update',
                    data: roomData.data
                }, ws);
            }

            // Deletar item
            if (data.type === 'delete' && ws.room) {
                const { entityType, entityId } = data;
                const roomData = rooms.get(ws.room);

                // Salvar no banco como deletado (soft delete)
                await markAsDeletedInDB(ws.serverId, entityType, entityId);

                roomData.data[entityType] = roomData.data[entityType].filter(
                    item => item.id !== entityId
                );

                broadcastToRoom(ws.room, {
                    type: 'item-deleted',
                    entityType,
                    entityId
                }, ws);
            }

        } catch (error) {
            console.error('❌ Erro ao processar mensagem:', error);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
    });

    ws.on('close', () => {
        if (ws.room && rooms.has(ws.room)) {
            const roomData = rooms.get(ws.room);
            roomData.clients.delete(ws);
            console.log(`✗ Cliente desconectado: ${clientId} | Sala: ${ws.room}`);

            if (roomData.clients.size === 0) {
                rooms.delete(ws.room);
                console.log(`🗑️  Sala removida: ${ws.room}`);
            }
        }
    });

    ws.on('error', (error) => {
        console.error(`⚠️  Erro WebSocket [${clientId}]:`, error);
    });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

async function loadRoomDataFromDB(serverId) {
    try {
        const [clientes, vendas, gastos] = await Promise.all([
            prisma.cliente.findMany({
                where: { 
                    serverId,
                    deletedAt: null
                }
            }),
            prisma.venda.findMany({
                where: { 
                    serverId,
                    deletedAt: null
                }
            }),
            prisma.gasto.findMany({
                where: { 
                    serverId,
                    deletedAt: null
                }
            })
        ]);

        return {
            clientes: clientes.map(c => ({ ...c, timestamp: c.updatedAt.getTime() })),
            vendas: vendas.map(v => ({ ...v, timestamp: v.updatedAt.getTime() })),
            gastos: gastos.map(g => ({ ...g, timestamp: g.updatedAt.getTime() }))
        };
    } catch (error) {
        console.error('❌ Erro ao carregar dados:', error);
        return { clientes: [], vendas: [], gastos: [] };
    }
}

async function saveRoomDataToDB(serverId, data) {
    try {
        for (const cliente of data.clientes || []) {
            if (cliente.id) {
                const exists = await prisma.cliente.findUnique({
                    where: { id: cliente.id }
                });

                if (exists) {
                    await prisma.cliente.update({
                        where: { id: cliente.id },
                        data: {
                            name: cliente.name,
                            phone: cliente.phone,
                            email: cliente.email,
                            updatedAt: new Date(cliente.timestamp || Date.now())
                        }
                    });
                } else {
                    await prisma.cliente.create({
                        data: {
                            id: cliente.id,
                            name: cliente.name,
                            phone: cliente.phone,
                            email: cliente.email,
                            serverId,
                            createdAt: new Date(cliente.timestamp || Date.now())
                        }
                    });
                }
            }
        }

        for (const venda of data.vendas || []) {
            if (venda.id && venda.clienteId) {
                const exists = await prisma.venda.findUnique({
                    where: { id: venda.id }
                });

                if (exists) {
                    await prisma.venda.update({
                        where: { id: venda.id },
                        data: {
                            clienteId: venda.clienteId,
                            valor: venda.valor,
                            descricao: venda.descricao,
                            data: venda.data,
                            updatedAt: new Date(venda.timestamp || Date.now())
                        }
                    });
                } else {
                    await prisma.venda.create({
                        data: {
                            id: venda.id,
                            clienteId: venda.clienteId,
                            valor: venda.valor,
                            descricao: venda.descricao,
                            data: venda.data,
                            serverId,
                            createdAt: new Date(venda.timestamp || Date.now())
                        }
                    });
                }
            }
        }

        for (const gasto of data.gastos || []) {
            if (gasto.id) {
                const exists = await prisma.gasto.findUnique({
                    where: { id: gasto.id }
                });

                if (exists) {
                    await prisma.gasto.update({
                        where: { id: gasto.id },
                        data: {
                            descricao: gasto.descricao,
                            valor: gasto.valor,
                            categoria: gasto.categoria,
                            data: gasto.data,
                            updatedAt: new Date(gasto.timestamp || Date.now())
                        }
                    });
                } else {
                    await prisma.gasto.create({
                        data: {
                            id: gasto.id,
                            descricao: gasto.descricao,
                            valor: gasto.valor,
                            categoria: gasto.categoria,
                            data: gasto.data,
                            serverId,
                            createdAt: new Date(gasto.timestamp || Date.now())
                        }
                    });
                }
            }
        }
    } catch (error) {
        console.error('❌ Erro ao salvar dados:', error);
    }
}

async function markAsDeletedInDB(serverId, entityType, entityId) {
    try {
        const now = new Date();
        
        if (entityType === 'clientes') {
            await prisma.cliente.update({
                where: { id: entityId },
                data: { deletedAt: now }
            });
        } else if (entityType === 'vendas') {
            await prisma.venda.update({
                where: { id: entityId },
                data: { deletedAt: now }
            });
        } else if (entityType === 'gastos') {
            await prisma.gasto.update({
                where: { id: entityId },
                data: { deletedAt: now }
            });
        }
    } catch (error) {
        console.error('❌ Erro ao deletar:', error);
    }
}

function mergeLWW(existing = [], incoming = []) {
    const map = new Map();

    // Adicionar existentes
    for (const item of existing) {
        map.set(item.id, item);
    }

    // Merge com incoming (Last-Write-Wins)
    for (const item of incoming) {
        const existing = map.get(item.id);
        if (!existing || (item.timestamp || 0) > (existing.timestamp || 0)) {
            map.set(item.id, item);
        }
    }

    return Array.from(map.values());
}

function broadcastToRoom(room, message, sender = null) {
    if (!rooms.has(room)) return;

    const roomData = rooms.get(room);
    const msg = JSON.stringify(message);

    roomData.clients.forEach((client) => {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

// ============================================
// INICIAR SERVIDOR
// ============================================

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, async () => {
    try {
        // Criar servidor padrão se não existir
        const existingServers = await prisma.server.count();
        if (existingServers === 0) {
            await prisma.server.create({
                data: {
                    name: 'Servidor Principal',
                    serverNumber: 1,
                    isPrincipal: true
                }
            });
            console.log('✨ Servidor #1 principal criado');
        }

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
        console.log(`💾 Database: ${process.env.DATABASE_URL ? '✓ Conectado' : '✗ Desconectado'}`);
        console.log(`${'='.repeat(60)}\n`);
    } catch (error) {
        console.error('❌ Erro ao iniciar servidor:', error);
        process.exit(1);
    }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('\n⚠️  SIGTERM recebido, encerrando gracefully...');
    server.close();
    await prisma.$disconnect();
    console.log('✓ Servidor encerrado com sucesso');
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\n⚠️  SIGINT recebido, encerrando gracefully...');
    server.close();
    await prisma.$disconnect();
    console.log('✓ Servidor encerrado com sucesso');
    process.exit(0);
});
