// ===== CONFIGURAÇÃO =====
let ws = null;
let codigoSala = null;
let deviceId = null;
let serverId = 1; // Servidor selecionado (padrão é 1)
let dispositivoNome = null;
let syncTimeout = null;
let autoSyncEnabled = true;
const SYNC_DEBOUNCE = 700; // ms
const RECONNECT_INTERVAL = 5000; // ms
const MAX_RECONNECT_ATTEMPTS = 10;
let reconnectAttempts = 0;
const selectedClientes = new Set();
const selectedVendas = new Set();
let pendingDeletes = JSON.parse(localStorage.getItem('pendingDeletes') || '[]');

function inicializarDispositivo() {
    deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
        deviceId = 'device-' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('deviceId', deviceId);
    }
    
    dispositivoNome = localStorage.getItem('dispositivoNome') || 'Dispositivo ' + deviceId.slice(-5);
    codigoSala = localStorage.getItem('codigoSalaPermanent') || localStorage.getItem('codigoSala');
    serverId = parseInt(localStorage.getItem('serverId') || '1');

    // Conectar automaticamente se já tem sala salva
    if (codigoSala) {
        document.getElementById('codigoSalaInput').value = codigoSala;
        setTimeout(() => {
            carregarServidores();
            conectarAoServidor();
        }, 500);
        if (localStorage.getItem('codigoSalaPermanent')) marcarSalaPermanenteUI(true);
    }
}

// ===== GERENCIAMENTO DE SERVIDORES =====

async function carregarServidores() {
    try {
        const response = await fetch('/api/servers');
        const servers = await response.json();
        
        const select = document.getElementById('servidorSelect');
        if (!select) return;
        
        select.innerHTML = '';
        servers.forEach(srv => {
            const option = document.createElement('option');
            option.value = srv.id;
            option.textContent = `${srv.name} (#${srv.serverNumber})${srv.isPrincipal ? ' ⭐' : ''}`;
            option.selected = srv.id === serverId;
            select.appendChild(option);
        });
        
        select.addEventListener('change', (e) => {
            serverId = parseInt(e.target.value);
            localStorage.setItem('serverId', serverId);
            if (ws && ws.readyState === WebSocket.OPEN) {
                desconectarDaSala();
                setTimeout(() => conectarAoServidor(), 500);
            }
        });
    } catch (error) {
        console.error('❌ Erro ao carregar servidores:', error);
    }
}

async function criarNovoServidor() {
    const name = prompt('Nome do novo servidor:');
    if (!name) return;
    
    const serverNumber = parseInt(prompt('Número do servidor (ex: 2, 3):'));
    if (!serverNumber) return;
    
    const isPrincipal = confirm('Definir como servidor principal?');
    
    try {
        const response = await fetch('/api/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, serverNumber, isPrincipal })
        });
        
        if (!response.ok) throw new Error('Erro ao criar servidor');
        
        const novoServidor = await response.json();
        serverId = novoServidor.id;
        localStorage.setItem('serverId', serverId);
        
        await carregarServidores();
        showNotification(`✓ Servidor ${name} criado!`, 'success');
    } catch (error) {
        showNotification(`❌ Erro: ${error.message}`, 'error');
    }
}

async function definirServidorPrincipal(id) {
    try {
        await fetch(`/api/servers/${id}/set-principal`, { method: 'PUT' });
        await carregarServidores();
        showNotification('✓ Servidor principal atualizado!', 'success');
    } catch (error) {
        showNotification(`❌ Erro: ${error.message}`, 'error');
    }
}

// ===== WEBSOCKET =====

function conectarAoServidor() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }

    if (!codigoSala) {
        console.log('ℹ️ Nenhuma sala configurada');
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host;
    
    console.log(`🔗 Conectando ao servidor ${serverId}: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('✓ Conectado ao WebSocket');
        reconnectAttempts = 0;
        
        if (codigoSala) {
            entrarSala(codigoSala);
        }
        atualizarStatusSync('online');
        flushPendingDeletes();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'initial-data') {
                console.log('📥 Dados iniciais recebidos', data);
                window.syncData = data.data;
                atualizarTodasAsSecoes();
                document.getElementById('dispositivosConectados').textContent = data.clientCount;
                document.getElementById('servidorAtual').textContent = `#${data.serverId}`;
            } else if (data.type === 'sync-update') {
                console.log('📥 Sincronização recebida');
                window.syncData = data.data;
                atualizarTodasAsSecoes();
            } else if (data.type === 'user-joined') {
                document.getElementById('dispositivosConectados').textContent = data.clients;
                showNotification(`✓ Novo dispositivo conectado (${data.clients} total)`, 'success');
            } else if (data.type === 'user-left') {
                document.getElementById('dispositivosConectados').textContent = data.clients;
                showNotification(`Dispositivo desconectado (${data.clients} restantes)`, 'info');
            } else if (data.type === 'item-deleted') {
                console.log('🗑️ Item deletado:', data);
                if (window.syncData[data.entityType]) {
                    window.syncData[data.entityType] = window.syncData[data.entityType].filter(
                        item => item.id !== data.entityId
                    );
                    atualizarTodasAsSecoes();
                }
            }
        } catch (error) {
            console.error('❌ Erro ao processar mensagem:', error);
        }
    };

    ws.onerror = (error) => {
        console.error('❌ Erro WebSocket:', error);
        atualizarStatusSync('erro');
    };

    ws.onclose = () => {
        console.log('⚠️ Desconectado do servidor');
        atualizarStatusSync('offline');
        
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS && autoSyncEnabled) {
            reconnectAttempts++;
            console.log(`🔄 Tentando reconectar em ${RECONNECT_INTERVAL}ms... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
            setTimeout(() => conectarAoServidor(), RECONNECT_INTERVAL);
        }
    };
}

function desconectarDaSala() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
    ws = null;
    codigoSala = null;
    localStorage.removeItem('codigoSala');
    atualizarStatusSync('offline');
    document.getElementById('codigoSalaInput').value = '';
}

function entrarSala(sala) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    codigoSala = sala;
    localStorage.setItem('codigoSala', sala);
    document.getElementById('codigoSalaInput').value = sala;
    
    ws.send(JSON.stringify({
        type: 'join-room',
        room: sala,
        serverId: serverId
    }));

    console.log(`📍 Entrou na sala: ${sala} (Servidor #${serverId})`);
}

// ===== SINCRONIZAÇÃO =====

function enviarSincronizacao() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    const dataToSync = {
        clientes: window.syncData?.clientes || [],
        vendas: window.syncData?.vendas || [],
        gastos: window.syncData?.gastos || []
    };

    // Adicionar timestamp a cada item
    Object.keys(dataToSync).forEach(key => {
        dataToSync[key] = dataToSync[key].map(item => ({
            ...item,
            timestamp: item.timestamp || Date.now()
        }));
    });

    ws.send(JSON.stringify({
        type: 'sync-data',
        ...dataToSync
    }));

    atualizarStatusSync('synced');
    setTimeout(() => atualizarStatusSync('online'), 1000);
}

function agendarSincronizacao() {
    clearTimeout(syncTimeout);
    atualizarStatusSync('sincronizando');
    syncTimeout = setTimeout(() => {
        enviarSincronizacao();
    }, SYNC_DEBOUNCE);
}

function atualizarStatusSync(status) {
    const statusEl = document.getElementById('statusSync');
    if (!statusEl) return;

    const statusMap = {
        'online': { cor: '#00ff00', texto: '🟢 Online' },
        'offline': { cor: '#ff0000', texto: '🔴 Offline' },
        'sincronizando': { cor: '#ffff00', texto: '🟡 Sincronizando...' },
        'synced': { cor: '#00ff00', texto: '✓ Sincronizado' },
        'erro': { cor: '#ff4444', texto: '❌ Erro' }
    };

    const info = statusMap[status] || statusMap['offline'];
    statusEl.style.color = info.cor;
    statusEl.textContent = info.texto;
}

// ===== MERGE LWW =====

function mergeRemoteData(remoteData) {
    if (!window.syncData) {
        window.syncData = { clientes: [], vendas: [], gastos: [] };
    }

    ['clientes', 'vendas', 'gastos'].forEach(type => {
        if (remoteData[type]) {
            const merged = {};
            
            // Mapa de dados locais
            (window.syncData[type] || []).forEach(item => {
                merged[item.id] = item;
            });
            
            // Merge com remote (LWW)
            remoteData[type].forEach(item => {
                if (!merged[item.id] || (item.timestamp || 0) > (merged[item.id].timestamp || 0)) {
                    merged[item.id] = item;
                }
            });
            
            window.syncData[type] = Object.values(merged);
        }
    });
}

// ===== INTERFACE FUNCTIONS =====

function criarCliente() {
    const nome = prompt('Nome do cliente:');
    if (!nome) return;

    const email = prompt('Email (opcional):');
    const phone = prompt('Telefone (opcional):');

    if (!window.syncData) window.syncData = { clientes: [], vendas: [], gastos: [] };

    const novoCliente = {
        id: 'cli-' + Math.random().toString(36).substr(2, 9),
        name: nome,
        email: email || null,
        phone: phone || null,
        timestamp: Date.now()
    };

    window.syncData.clientes.push(novoCliente);
    atualizarSecaoClientes();
    agendarSincronizacao();
    showNotification(`✓ Cliente "${nome}" adicionado!`, 'success');
}

function deletarCliente(id) {
    if (!confirm('Tem certeza que quer deletar este cliente?')) return;

    queueDelete('clientes', id);
    atualizarSecaoClientes();
    showNotification('✓ Cliente deletado!', 'success');
}

function queueDelete(entityType, entityId) {
    pendingDeletes.push({ entityType, entityId, timestamp: Date.now() });
    localStorage.setItem('pendingDeletes', JSON.stringify(pendingDeletes));

    if (ws && ws.readyState === WebSocket.OPEN) {
        sendDeleteNow(entityType, entityId);
    }
}

function sendDeleteNow(entityType, entityId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
        type: 'delete',
        entityType,
        entityId
    }));
}

function flushPendingDeletes() {
    if (!ws || ws.readyState !== WebSocket.OPEN || pendingDeletes.length === 0) return;

    pendingDeletes.forEach(({ entityType, entityId }) => {
        sendDeleteNow(entityType, entityId);
    });

    pendingDeletes = [];
    localStorage.removeItem('pendingDeletes');
}

function criarVenda() {
    const clienteId = prompt('ID do cliente:');
    if (!clienteId) return;

    const valor = parseFloat(prompt('Valor da venda:'));
    if (isNaN(valor)) return;

    const descricao = prompt('Descrição (opcional):');

    if (!window.syncData) window.syncData = { clientes: [], vendas: [], gastos: [] };

    const novaVenda = {
        id: 'vnd-' + Math.random().toString(36).substr(2, 9),
        clienteId,
        valor,
        descricao: descricao || null,
        data: new Date().toISOString(),
        timestamp: Date.now()
    };

    window.syncData.vendas.push(novaVenda);
    atualizarSecaoVendas();
    agendarSincronizacao();
    showNotification(`✓ Venda de R$ ${valor.toFixed(2)} registrada!`, 'success');
}

function deletarVenda(id) {
    if (!confirm('Deletar esta venda?')) return;
    queueDelete('vendas', id);
    atualizarSecaoVendas();
}

function criarGasto() {
    const descricao = prompt('Descrição do gasto:');
    if (!descricao) return;

    const valor = parseFloat(prompt('Valor:'));
    if (isNaN(valor)) return;

    const categoria = prompt('Categoria (opcional):');

    if (!window.syncData) window.syncData = { clientes: [], vendas: [], gastos: [] };

    const novoGasto = {
        id: 'gst-' + Math.random().toString(36).substr(2, 9),
        descricao,
        valor,
        categoria: categoria || null,
        data: new Date().toISOString(),
        timestamp: Date.now()
    };

    window.syncData.gastos.push(novoGasto);
    atualizarSecaoGastos();
    agendarSincronizacao();
    showNotification(`✓ Gasto de R$ ${valor.toFixed(2)} registrado!`, 'success');
}

function deletarGasto(id) {
    if (!confirm('Deletar este gasto?')) return;
    queueDelete('gastos', id);
    atualizarSecaoGastos();
}

// ===== UPDATE UI =====

function atualizarTodasAsSecoes() {
    atualizarSecaoClientes();
    atualizarSecaoVendas();
    atualizarSecaoGastos();
    atualizarResumo();
}

function atualizarSecaoClientes() {
    const container = document.getElementById('listaClientes');
    if (!container) return;

    const clientes = window.syncData?.clientes || [];
    
    container.innerHTML = clientes.map(cliente => `
        <div class="cliente-item" id="cli-${cliente.id}">
            <input type="checkbox" class="cliente-checkbox" value="${cliente.id}">
            <span>${cliente.name}</span>
            ${cliente.phone ? `<small>📱 ${cliente.phone}</small>` : ''}
            ${cliente.email ? `<small>📧 ${cliente.email}</small>` : ''}
            <button onclick="deletarCliente('${cliente.id}')">🗑️</button>
        </div>
    `).join('');

    atualizarCheckboxes();
}

function atualizarSecaoVendas() {
    const container = document.getElementById('listaVendas');
    if (!container) return;

    const vendas = window.syncData?.vendas || [];
    
    container.innerHTML = vendas.map(venda => `
        <div class="venda-item" id="vnd-${venda.id}">
            <input type="checkbox" class="venda-checkbox" value="${venda.id}">
            <span>R$ ${venda.valor.toFixed(2)}</span>
            <small>${venda.descricao || 'Sem descrição'}</small>
            <button onclick="deletarVenda('${venda.id}')">🗑️</button>
        </div>
    `).join('');

    atualizarCheckboxes();
}

function atualizarSecaoGastos() {
    const container = document.getElementById('listaGastos');
    if (!container) return;

    const gastos = window.syncData?.gastos || [];
    
    container.innerHTML = gastos.map(gasto => `
        <div class="gasto-item" id="gst-${gasto.id}">
            <input type="checkbox" class="gasto-checkbox" value="${gasto.id}">
            <span>${gasto.descricao}</span>
            <span>R$ ${gasto.valor.toFixed(2)}</span>
            ${gasto.categoria ? `<small>${gasto.categoria}</small>` : ''}
            <button onclick="deletarGasto('${gasto.id}')">🗑️</button>
        </div>
    `).join('');

    atualizarCheckboxes();
}

function atualizarResumo() {
    const clientes = window.syncData?.clientes || [];
    const vendas = window.syncData?.vendas || [];
    const gastos = window.syncData?.gastos || [];

    const totalVendas = vendas.reduce((sum, v) => sum + (v.valor || 0), 0);
    const totalGastos = gastos.reduce((sum, g) => sum + (g.valor || 0), 0);

    document.getElementById('totalClientes').textContent = clientes.length;
    document.getElementById('totalVendas').textContent = `R$ ${totalVendas.toFixed(2)}`;
    document.getElementById('totalGastos').textContent = `R$ ${totalGastos.toFixed(2)}`;
    document.getElementById('lucro').textContent = `R$ ${(totalVendas - totalGastos).toFixed(2)}`;
}

function atualizarCheckboxes() {
    document.querySelectorAll('.cliente-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            if (e.target.checked) {
                selectedClientes.add(e.target.value);
            } else {
                selectedClientes.delete(e.target.value);
            }
        });
    });

    document.querySelectorAll('.venda-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            if (e.target.checked) {
                selectedVendas.add(e.target.value);
            } else {
                selectedVendas.delete(e.target.value);
            }
        });
    });
}

function deletarClientesSelecionados() {
    if (selectedClientes.size === 0) {
        showNotification('Selecione clientes para deletar', 'warning');
        return;
    }

    if (!confirm(`Deletar ${selectedClientes.size} cliente(s)?`)) return;

    selectedClientes.forEach(id => {
        queueDelete('clientes', id);
    });

    window.syncData.clientes = window.syncData.clientes.filter(
        c => !selectedClientes.has(c.id)
    );

    selectedClientes.clear();
    atualizarSecaoClientes();
    agendarSincronizacao();
    showNotification(`✓ ${selectedClientes.size} cliente(s) deletado(s)!`, 'success');
}

function deletarVendasSelecionadas() {
    if (selectedVendas.size === 0) {
        showNotification('Selecione vendas para deletar', 'warning');
        return;
    }

    if (!confirm(`Deletar ${selectedVendas.size} venda(s)?`)) return;

    selectedVendas.forEach(id => {
        queueDelete('vendas', id);
    });

    window.syncData.vendas = window.syncData.vendas.filter(
        v => !selectedVendas.has(v.id)
    );

    selectedVendas.clear();
    atualizarSecaoVendas();
    agendarSincronizacao();
    showNotification(`✓ ${selectedVendas.size} venda(s) deletada(s)!`, 'success');
}

function marcarSalaPermanenteUI(checked) {
    const checkbox = document.getElementById('salaPermanenteCheck');
    if (checkbox) checkbox.checked = checked;
}

function salvarSalaPermanente(checked) {
    if (checked) {
        if (!codigoSala) {
            showNotification('Entre em uma sala primeiro', 'warning');
            return;
        }
        localStorage.setItem('codigoSalaPermanent', codigoSala);
        showNotification('✓ Sala marcada como permanente', 'success');
    } else {
        localStorage.removeItem('codigoSalaPermanent');
        showNotification('Sala deixou de ser permanente', 'info');
    }
}

// ===== UTILITY =====

function conectarSala() {
    const salaInput = document.getElementById('codigoSalaInput');
    const nomeDisp = document.getElementById('nomeDispositivo');
    
    if (!salaInput.value) {
        showNotification('Digite o código da sala', 'warning');
        return;
    }
    
    codigoSala = salaInput.value.toUpperCase();
    if (nomeDisp.value) {
        dispositivoNome = nomeDisp.value;
        localStorage.setItem('dispositivoNome', dispositivoNome);
    }
    
    localStorage.setItem('codigoSala', codigoSala);
    conectarAoServidor();
    showNotification(`Conectando à sala: ${codigoSala}...`, 'info');
}

function leaveSala() {
    desconectarDaSala();
    showNotification('Saiu da sala', 'info');
}

function criarNovaSala() {
    const codigoGerado = Math.random().toString(36).substr(2, 6).toUpperCase();
    codigoSala = codigoGerado;
    localStorage.setItem('codigoSala', codigoSala);
    document.getElementById('codigoSalaInput').value = codigoSala;
    
    conectarAoServidor();
    showNotification(`Sala criada: ${codigoSala}`, 'success');
}

function showNotification(message, type = 'info') {
    const notif = document.createElement('div');
    notif.className = `notification notification-${type}`;
    notif.textContent = message;
    document.body.appendChild(notif);
    
    setTimeout(() => {
        notif.classList.add('show');
    }, 10);

    setTimeout(() => {
        notif.classList.remove('show');
        setTimeout(() => notif.remove(), 300);
    }, 3000);
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    inicializarDispositivo();
    if (typeof carregarServidores === 'function') {
        carregarServidores();
    }
});
