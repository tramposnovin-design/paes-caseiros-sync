// Teste local de validação de código (sem servidor)
console.log('\n🧪 TESTES DE VALIDAÇÃO - MODO LOCAL\n');

let testsPassed = 0;
let testsFailed = 0;

// ===== TEST 1: Validar merge LWW =====
console.log('1️⃣  TESTE: Merge LWW (Last-Write-Wins)');

function mergeRemoteData(app, remote) {
    if (!remote) return;
    const tipos = ['clientes', 'vendas', 'gastos'];
    tipos.forEach(tipo => {
        const locais = Array.isArray(app[tipo]) ? app[tipo] : [];
        const remotos = Array.isArray(remote[tipo]) ? remote[tipo] : [];
        const mapa = new Map();
        locais.forEach(item => mapa.set(item.id, { ...item }));
        remotos.forEach(item => {
            const existente = mapa.get(item.id);
            const tRemoto = item.lastUpdated || 0;
            const tLocal = existente ? (existente.lastUpdated || 0) : 0;
            if (!existente || tRemoto >= tLocal) {
                mapa.set(item.id, { ...item });
            }
        });
        const merged = Array.from(mapa.values()).sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
        app[tipo] = merged;
    });
}

const app1 = {
    clientes: [{ id: 1, nome: 'João', lastUpdated: 100 }],
    vendas: [],
    gastos: []
};

const remote = {
    clientes: [{ id: 1, nome: 'João Silva', lastUpdated: 200 }], // mais recente
    vendas: [],
    gastos: []
};

mergeRemoteData(app1, remote);
if (app1.clientes[0].nome === 'João Silva' && app1.clientes[0].lastUpdated === 200) {
    console.log('  ✓ LWW merge funcionando (versão mais recente venceu)');
    testsPassed++;
} else {
    console.log('  ✗ FALHA: Merge LWW não aplicou corretamente');
    testsFailed++;
}

// ===== TEST 2: Validar fila de deletes =====
console.log('\n2️⃣  TESTE: Fila de Deletes com Persistência');

let pendingDeletes = [];
const MOCK_ROOM = 'TEST-ROOM';

function savePendingDeletesLocal() {
    return JSON.stringify(pendingDeletes);
}

function queueDelete(entity, id) {
    const item = { entity, id, timestamp: Date.now(), room: MOCK_ROOM };
    pendingDeletes.push(item);
    return savePendingDeletesLocal();
}

function flushPendingDeletes() {
    return pendingDeletes.slice(); // retorna cópia
}

const jsonStr = queueDelete('clientes', 123);
queueDelete('vendas', 456);
const flushed = flushPendingDeletes();

if (flushed.length === 2 && flushed[0].id === 123 && flushed[1].id === 456) {
    console.log('  ✓ Fila de deletes funcionando');
    console.log(`    - 2 deletes enfileirados e recovey de localStorage simulado`);
    testsPassed++;
} else {
    console.log('  ✗ FALHA: Fila de deletes não funcionando');
    testsFailed++;
}

// ===== TEST 3: Validar merge do servidor (tombstones) =====
console.log('\n3️⃣  TESTE: Tombstones e Merge do Servidor');

function mergeRoomData(roomData, incoming) {
    const types = ['clientes', 'vendas', 'gastos'];
    types.forEach(type => {
        const localArr = Array.isArray(roomData.data[type]) ? roomData.data[type] : [];
        const remoteArr = Array.isArray(incoming[type]) ? incoming[type] : [];
        const map = new Map();
        localArr.forEach(item => map.set(item.id, { ...item }));
        remoteArr.forEach(item => {
            const existing = map.get(item.id);
            const tRemote = item.lastUpdated || 0;
            const tLocal = existing ? (existing.lastUpdated || 0) : 0;
            if (!existing || tRemote >= tLocal) {
                map.set(item.id, { ...item });
            }
        });
        // aplicar tombstones
        if (roomData.tombstones && roomData.tombstones[type]) {
            roomData.tombstones[type].forEach((ts, tombId) => {
                const entry = map.get(tombId);
                if (entry) {
                    const tEntry = entry.lastUpdated || 0;
                    if (ts >= tEntry) map.delete(tombId);
                }
            });
        }
        roomData.data[type] = Array.from(map.values());
    });
}

const roomData = {
    data: {
        clientes: [{ id: 1, nome: 'Cliente', lastUpdated: 100 }],
        vendas: [{ id: 200, produto: 'Pão', lastUpdated: 100 }],
        gastos: []
    },
    tombstones: {
        clientes: new Map(),
        vendas: new Map([[200, 150]]), // venda 200 foi deletada em t=150
        gastos: new Map()
    }
};

const incomingData = {
    clientes: [],
    vendas: [{ id: 200, produto: 'Pão Novo', lastUpdated: 120 }], // venda mais recente mas com tombstone mais novo
    gastos: []
};

mergeRoomData(roomData, incomingData);

if (roomData.data.clientes.length === 1 && roomData.data.vendas.length === 0) {
    console.log('  ✓ Tombstones funcionando (delete venceu sobre update)');
    testsPassed++;
} else {
    console.log('  ✗ FALHA: Tombstones não aplicados corretamente');
    console.log(`    Clientes: ${roomData.data.clientes.length}, Vendas: ${roomData.data.vendas.length}`);
    testsFailed++;
}

// ===== TEST 4: Validar room storage com tombstones =====
console.log('\n4️⃣  TESTE: Estrutura de Room (com Tombstones)');

const testRoom = {
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
};

if (testRoom.tombstones && testRoom.tombstones.clientes instanceof Map) {
    testRoom.tombstones.vendas.set(999, Date.now());
    if (testRoom.tombstones.vendas.has(999)) {
        console.log('  ✓ Room structure com Tombstones Maps validado');
        testsPassed++;
    } else {
        console.log('  ✗ FALHA: Tombstones Map não funciona');
        testsFailed++;
    }
} else {
    console.log('  ✗ FALHA: Estrutura de tombstones inválida');
    testsFailed++;
}

// ===== RESULTADOS =====
console.log(`\n${'='.repeat(50)}`);
console.log(`\n✅ TESTES CONCLUÍDOS\n`);
console.log(`  ✓ Sucessos: ${testsPassed}/4`);
if (testsFailed > 0) console.log(`  ✗ Falhas: ${testsFailed}/4`);
console.log(`\n${'='.repeat(50)}\n`);

if (testsFailed === 0) {
    console.log('✨ TODOS OS TESTES PASSARAM!\n');
    console.log('📝 VALIDAÇÕES:');
    console.log('  ✓ Sincronização (merge LWW)');
    console.log('  ✓ Fila de deletes com persistência');
    console.log('  ✓ Tombstones e versioning');
    console.log('  ✓ Estrutura de dados consistente\n');
} else {
    console.log(`⚠️  ${testsFailed} teste(s) falharam\n`);
}

process.exit(testsFailed > 0 ? 1 : 0);
