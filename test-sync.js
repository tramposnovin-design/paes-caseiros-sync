// Teste de sincronização entre dois clientes WebSocket
const WebSocket = require('ws');

const wsUrl = 'ws://localhost:3000';
const testRoom = 'TEST-ROOM-' + Date.now();

let client1, client2;
let testsPassed = 0;
let testsFailed = 0;

console.log('\n🧪 INICIANDO TESTES DE SINCRONIZAÇÃO\n');

// Esperar servidor estar pronto
setTimeout(() => {
    runTests();
}, 1000);

function runTests() {
    connectClients();
}

function connectClients() {
    console.log(`📡 Conectando 2 clientes ao servidor...`);
    
    client1 = new WebSocket(wsUrl);
    client1.on('open', () => console.log('  ✓ Cliente 1 conectado'));
    
    client2 = new WebSocket(wsUrl);
    client2.on('open', () => console.log('  ✓ Cliente 2 conectado'));
    
    // Aguardar ambos conectarem
    let connected = 0;
    const onConnect = () => {
        connected++;
        if (connected === 2) {
            setTimeout(testJoinRoom, 500);
        }
    };
    
    client1.on('open', onConnect);
    client2.on('open', onConnect);
}

function testJoinRoom() {
    console.log(`\n1️⃣  TESTE: Entrar em sala "${testRoom}"`);
    
    client1.send(JSON.stringify({
        type: 'join-room',
        room: testRoom
    }));
    
    client2.send(JSON.stringify({
        type: 'join-room',
        room: testRoom
    }));
    
    let syncCount = 0;
    const onSync = () => {
        syncCount++;
        if (syncCount === 2) {
            testsPassed++;
            console.log('  ✓ Ambos clientes sincronizados na sala');
            setTimeout(testUpdate, 500);
        }
    };
    
    client1.once('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'sync' && msg.clients === 2) onSync();
    });
    
    client2.once('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'sync' && msg.clients === 2) onSync();
    });
}

function testUpdate() {
    console.log(`\n2️⃣  TESTE: Update de dados (cliente 1 envia)`);
    
    const testData = {
        clientes: [
            { id: 1, nome: 'João', whatsapp: '11999999999', lastUpdated: Date.now() }
        ],
        vendas: [
            { id: 100, cliente: 1, produto: 'Pão', quantidade: 10, valor: 5.00, data: new Date().toISOString().split('T')[0], lastUpdated: Date.now() }
        ],
        gastos: [
            { id: 1000, tipo: 'ingredientes', valor: 15.00, data: new Date().toISOString().split('T')[0], lastUpdated: Date.now() }
        ]
    };
    
    client1.send(JSON.stringify({
        type: 'update',
        room: testRoom,
        data: testData,
        timestamp: Date.now()
    }));
    
    let received = 0;
    const onReceive = (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'sync' && msg.data.clientes && msg.data.clientes.length === 1) {
            received++;
            if (received === 2) {
                testsPassed++;
                console.log('  ✓ Ambos clientes receberam update');
                console.log(`    - 1 cliente, 1 venda, 1 gasto sincronizados`);
                setTimeout(testDelete, 500);
            }
        }
    };
    
    client1.once('message', onReceive);
    client2.once('message', onReceive);
}

function testDelete() {
    console.log(`\n3️⃣  TESTE: Delete (client 2 envia tombstone)`);
    
    client2.send(JSON.stringify({
        type: 'delete',
        entity: 'vendas',
        id: 100,
        timestamp: Date.now(),
        room: testRoom
    }));
    
    let received = 0;
    const onReceive = (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'sync' && (!msg.data.vendas || msg.data.vendas.length === 0)) {
            received++;
            if (received === 2) {
                testsPassed++;
                console.log('  ✓ Venda deletada em ambos os clientes');
                console.log(`    - Tombstone sincronizado`);
                setTimeout(testLWW, 500);
            }
        }
    };
    
    client1.once('message', onReceive);
    client2.once('message', onReceive);
}

function testLWW() {
    console.log(`\n4️⃣  TESTE: Merge LWW (conflito resolvido pelo timestamp)`);
    
    const conflictData = {
        clientes: [
            { id: 1, nome: 'João Silva', whatsapp: '11999999999', lastUpdated: Date.now() + 1000 } // mais recente
        ],
        vendas: [],
        gastos: []
    };
    
    client1.send(JSON.stringify({
        type: 'update',
        room: testRoom,
        data: conflictData,
        timestamp: Date.now()
    }));
    
    let received = 0;
    const onReceive = (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'sync' && msg.data.clientes && msg.data.clientes[0].nome === 'João Silva') {
            received++;
            if (received === 2) {
                testsPassed++;
                console.log('  ✓ Conflito resolvido (versão mais recente venceu)');
                setTimeout(finalizeTests, 500);
            }
        }
    };
    
    client1.once('message', onReceive);
    client2.once('message', onReceive);
}

function finalizeTests() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`\n✅ TESTES CONCLUÍDOS\n`);
    console.log(`  Sucessos: ${testsPassed}/4`);
    console.log(`  Falhas: ${testsFailed}/4`);
    console.log(`\n✓ Sistema de sincronização funcionando corretamente!\n`);
    console.log(`${'='.repeat(50)}\n`);
    
    client1.close();
    client2.close();
    process.exit(testsFailed > 0 ? 1 : 0);
}

// Timeout geral
setTimeout(() => {
    console.error('\n❌ TESTES EXPIRADOS (timeout)\n');
    process.exit(1);
}, 15000);
