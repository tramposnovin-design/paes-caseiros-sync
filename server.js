const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Armazenar rooms de sincronização
const rooms = new Map();

// Função para gerar código de sala
function gerarCodigoSala() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// WebSocket - Sincronização em tempo real
io.on('connection', (socket) => {
    console.log('Novo cliente conectado:', socket.id);

    // Entrar em uma sala (compartilhar dados)
    socket.on('entrarSala', (dados) => {
        const { codigoSala, deviceId, dispositivo } = dados;
        
        if (!codigoSala) return;

        // Criar sala se não existir
        if (!rooms.has(codigoSala)) {
            rooms.set(codigoSala, {
                clientes: new Map(),
                dados: {
                    clientes: [],
                    vendas: [],
                    gastos: []
                }
            });
        }

        const sala = rooms.get(codigoSala);
        
        // Registrar cliente na sala
        sala.clientes.set(socket.id, {
            deviceId,
            dispositivo,
            socketId: socket.id
        });

        // Adicionar socket à sala
        socket.join(codigoSala);

        // Enviar dados atuais para o novo cliente
        socket.emit('dadosAtualizados', sala.dados);

        // Notificar outros clientes
        io.to(codigoSala).emit('clienteConectado', {
            total: sala.clientes.size,
            dispositivo
        });

        console.log(`Cliente ${deviceId} entrou na sala ${codigoSala}`);
    });

    // Sincronizar dados (quando um dispositivo faz uma mudança)
    socket.on('sincronizarDados', (dados) => {
        const codigoSala = Array.from(socket.rooms)[1]; // Pega a sala (primeira é o socket.id)
        
        if (!codigoSala) return;

        const sala = rooms.get(codigoSala);
        if (!sala) return;

        // Atualizar dados da sala
        sala.dados = dados;

        // Enviar para todos os clientes da sala
        io.to(codigoSala).emit('dadosAtualizados', dados);

        console.log(`Dados sincronizados na sala ${codigoSala}`);
    });

    // Desconectar
    socket.on('disconnect', () => {
        // Procurar e remover cliente de todas as salas
        rooms.forEach((sala, codigoSala) => {
            if (sala.clientes.has(socket.id)) {
                sala.clientes.delete(socket.id);
                
                // Notificar outros clientes
                io.to(codigoSala).emit('clienteDesconectado', {
                    total: sala.clientes.size
                });

                // Apagar sala se vazia
                if (sala.clientes.size === 0) {
                    rooms.delete(codigoSala);
                }
            }
        });

        console.log('Cliente desconectado:', socket.id);
    });
});

// APIs REST
app.get('/api/criar-sala', (req, res) => {
    const codigoSala = gerarCodigoSala();
    rooms.set(codigoSala, {
        clientes: new Map(),
        dados: {
            clientes: [],
            vendas: [],
            gastos: []
        }
    });
    res.json({ codigoSala });
});

app.get('/api/validar-sala/:codigo', (req, res) => {
    const existe = rooms.has(req.params.codigo);
    res.json({ existe });
});

// Servir a página principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🍞 Servidor de sincronização rodando na porta ${PORT}`);
});
