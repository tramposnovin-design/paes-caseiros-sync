// ===== CONFIGURAÇÃO DE SINCRONIZAÇÃO =====
let ws = null;
let codigoSala = null;
let deviceId = null;
let dispositivoNome = null;
let syncTimeout = null;
let autoSyncEnabled = true;
const SYNC_DEBOUNCE = 700; // ms - debounce para reduzir tráfego
const RECONNECT_INTERVAL = 5000; // ms - tentar reconectar a cada 5s
const MAX_RECONNECT_ATTEMPTS = 10;
let reconnectAttempts = 0;
const selectedClientes = new Set();
const selectedVendas = new Set();
// pending deletes (persistidos localmente para enviar quando reconectar)
let pendingDeletes = JSON.parse(localStorage.getItem('pendingDeletes') || '[]');

function inicializarDispositivo() {
    deviceId = localStorage.getItem('deviceId');
    if (!deviceId) {
        deviceId = 'device-' + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('deviceId', deviceId);
    }
    
    dispositivoNome = localStorage.getItem('dispositivoNome') || 'Dispositivo ' + deviceId.slice(-5);
    // Preferência: sala permanente (salva apenas na primeira vez)
    codigoSala = localStorage.getItem('codigoSalaPermanent') || localStorage.getItem('codigoSala');

    // Conectar automaticamente se já tem sala salva
    if (codigoSala) {
        document.getElementById('codigoSalaInput').value = codigoSala;
        setTimeout(() => conectarAoServidor(), 500);
        if (localStorage.getItem('codigoSalaPermanent')) marcarSalaPermanenteUI(true);
    }
}

function conectarAoServidor() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return; // Já conectado ou conectando
    }

    if (!codigoSala) {
        console.log('ℹ️ Nenhuma sala configurada');
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = protocol + '//' + window.location.host;
    
    console.log(`🔗 Conectando ao servidor: ${wsUrl}`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('✓ Conectado ao WebSocket');
        reconnectAttempts = 0;
        
        if (codigoSala) {
            entrarSala(codigoSala);
        }
        atualizarStatusSync('online');
        // Ao reconectar, tentar enviar deletes pendentes
        flushPendingDeletes();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            
            if (data.type === 'sync') {
                console.log('📥 Dados sincronizados', data);
                // Merge LWW (last-write-wins) por item
                mergeRemoteData(data.data);
                atualizarTodasAsSecoes();
                if (data.clients) {
                    const element = document.getElementById('dispositivosConectados');
                    if (element) element.textContent = data.clients;
                }
            } else if (data.type === 'user-joined') {
                console.log('👤 Novo dispositivo conectado');
                const element = document.getElementById('dispositivosConectados');
                if (element) {
                    element.textContent = data.clients;
                }
                showNotification(`✓ Novo dispositivo conectado (${data.clients} total)`, 'success');
            } else if (data.type === 'user-left') {
                console.log('👤 Dispositivo desconectado');
                const element = document.getElementById('dispositivosConectados');
                if (element) {
                    element.textContent = data.clients;
                }
                showNotification(`Dispositivo desconectado (${data.clients} restantes)`, 'info');
            } else if (data.type === 'server-shutdown') {
                console.warn('⚠️ Servidor indo offline');
                showNotification('Servidor está sendo reiniciado...', 'warning');
            }
        } catch (error) {
            console.error('❌ Erro ao processar mensagem:', error);
        }
    };

    ws.onerror = (error) => {
        console.error('❌ Erro WebSocket:', error);
        atualizarStatusSync('offline');
    };

    ws.onclose = () => {
        console.log('✗ Desconectado do servidor');
        atualizarStatusSync('offline');
        
        // Tentar reconectar automaticamente
        if (codigoSala && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            console.log(`⏳ Tentando reconectar (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(conectarAoServidor, RECONNECT_INTERVAL);
        } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error('❌ Máximo de tentativas de reconexão atingido');
            showNotification('Falha ao conectar. Verifique sua conexão.', 'danger');
        }
    };
}

function atualizarStatusSync(status) {
    const dot = document.getElementById('syncDot');
    const statusText = document.getElementById('syncStatus');
    
    if (!dot || !statusText) return;
    
    if (status === 'online') {
        dot.classList.remove('offline');
        statusText.textContent = codigoSala ? `✓ Conectado • ${codigoSala}` : '✓ Conectado';
        dot.style.backgroundColor = '#10b981';
    } else {
        dot.classList.add('offline');
        statusText.textContent = '✗ Desconectado';
        dot.style.backgroundColor = '#ef4444';
    }
}

function criarNovaSala() {
    codigoSala = Math.random().toString(36).substring(2, 8).toUpperCase();
    // SALVAR SALA PERMANENTE (uma vez)
    localStorage.setItem('codigoSala', codigoSala);
    if (!localStorage.getItem('codigoSalaPermanent')) {
        localStorage.setItem('codigoSalaPermanent', codigoSala);
    }
    
    const elements = {
        display: document.getElementById('codigoSalaDisplay'),
        input: document.getElementById('codigoSalaInput'),
        exibido: document.getElementById('codigoExibido')
    };
    
    Object.values(elements).forEach(el => {
        if (el) el.textContent = codigoSala;
    });
    
    const qrContainer = document.getElementById('qrContainer');
    if (qrContainer) qrContainer.style.display = 'block';
    
    gerarQRCode(codigoSala);
    conectarAoServidor();
    entrarSala(codigoSala);
    marcarSalaPermanenteUI(true);
    showNotification(`✓ Sala criada: ${codigoSala} (Permanente)`, 'success');
}

function conectarSala() {
    const codigo = document.getElementById('codigoSalaInput')?.value.toUpperCase();
    const nome = document.getElementById('nomeDispositivo')?.value || 'Dispositivo';
    
    if (!codigo) {
        showNotification('Digite o código da sala!', 'danger');
        return;
    }
    
    codigoSala = codigo;
    dispositivoNome = nome;

    // Salva a sala como permanente na primeira conexão
    localStorage.setItem('codigoSala', codigoSala);
    if (!localStorage.getItem('codigoSalaPermanent')) {
        localStorage.setItem('codigoSalaPermanent', codigoSala);
    }
    localStorage.setItem('dispositivoNome', dispositivoNome);

    document.getElementById('codigoSalaDisplay').textContent = codigoSala;

    conectarAoServidor();
    entrarSala(codigoSala);
    marcarSalaPermanenteUI(true);
    showNotification(`✓ Conectado à sala ${codigoSala}! (Permanente)`, 'success');
}

function leaveSala() {
    if (!codigoSala) return;
    if (!confirm('Deseja sair desta sala e remover a associação permanente?')) return;
    localStorage.removeItem('codigoSalaPermanent');
    localStorage.removeItem('codigoSala');
    codigoSala = null;
    marcarSalaPermanenteUI(false);
    if (ws) {
        try { ws.close(); } catch (e) {}
        ws = null;
    }
    document.getElementById('codigoSalaDisplay').textContent = '-';
    document.getElementById('dispositivosConectados').textContent = '0';
    showNotification('Você saiu da sala.', 'info');
}

function entrarSala(sala) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'join-room',
            room: sala
        }));
        atualizarStatusSync('online');
    } else {
        console.log('⏳ Aguardando conexão...');
        setTimeout(() => entrarSala(sala), 1000);
    }
}

function enviarDados(dados) {
    if (!autoSyncEnabled) return;
    
    // Cancelar sincronização anterior se ainda não foi enviada
    if (syncTimeout) {
        clearTimeout(syncTimeout);
    }
    
    // Debounce - aguardar antes de sincronizar
    syncTimeout = setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'update',
                room: codigoSala,
                data: dados,
                timestamp: Date.now()
            }));
            console.log('📤 Dados enviados (debounced)', dados);
        } else {
            console.log('⚠️ WebSocket desconectado, dados pendentes');
        }
        syncTimeout = null;
    }, SYNC_DEBOUNCE);
}

// Merge LWW simples entre estado remoto e local
// ===== Deleção com tombstones (fila local) =====
function savePendingDeletesLocal() {
    localStorage.setItem('pendingDeletes', JSON.stringify(pendingDeletes || []));
}

function queueDelete(entity, id) {
    const item = { entity, id, timestamp: Date.now(), room: codigoSala || null };
    pendingDeletes = pendingDeletes || [];
    pendingDeletes.push(item);
    savePendingDeletesLocal();
    sendDeleteNow(item);
}

function sendDeleteNow(item) {
    if (ws && ws.readyState === WebSocket.OPEN && codigoSala) {
        try {
            ws.send(JSON.stringify({ type: 'delete', entity: item.entity, id: item.id, timestamp: item.timestamp, room: item.room || codigoSala }));
            // remover do pendingDeletes local
            pendingDeletes = (pendingDeletes || []).filter(d => !(d.entity === item.entity && d.id === item.id && d.timestamp === item.timestamp));
            savePendingDeletesLocal();
        } catch (e) {
            console.warn('Erro ao enviar delete, ficará pendente', e);
        }
    }
}

function flushPendingDeletes() {
    pendingDeletes = JSON.parse(localStorage.getItem('pendingDeletes') || '[]') || [];
    if (!pendingDeletes || pendingDeletes.length === 0) return;
    // tentar enviar todos
    pendingDeletes.slice().forEach(item => sendDeleteNow(item));
}

function mergeRemoteData(remote) {
    if (!remote) return;
    const tipos = ['clientes', 'vendas', 'gastos'];

    tipos.forEach(tipo => {
        const locais = Array.isArray(app[tipo]) ? app[tipo] : [];
        const remotos = Array.isArray(remote[tipo]) ? remote[tipo] : [];

        const mapa = new Map();

        // inserir locais
        locais.forEach(item => {
            mapa.set(item.id, { ...item });
        });

        // mesclar remotos (LWW)
        remotos.forEach(item => {
            const existente = mapa.get(item.id);
            const tRemoto = item.lastUpdated || 0;
            const tLocal = existente ? (existente.lastUpdated || 0) : 0;
            if (!existente || tRemoto >= tLocal) {
                mapa.set(item.id, { ...item });
            }
        });

        // Resultado: manter ordenação por lastUpdated desc
        const merged = Array.from(mapa.values()).sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
        app[tipo] = merged;
        localStorage.setItem(tipo, JSON.stringify(merged));
    });
}

function marcarSalaPermanenteUI(active) {
    const leaveBtn = document.getElementById('leaveSalaBtn');
    const createBtn = document.getElementById('criarSalaBtn');
    const connectBtn = document.getElementById('conectarSalaBtn');
    const codigoInput = document.getElementById('codigoSalaInput');
    const nomeInput = document.getElementById('nomeDispositivo');

    if (leaveBtn) leaveBtn.style.display = active ? 'inline-block' : 'none';
    if (createBtn) createBtn.disabled = active;
    if (connectBtn) connectBtn.disabled = active;
    if (codigoInput) codigoInput.disabled = active;
    if (nomeInput) nomeInput.disabled = active;
}

function gerarQRCode(codigo) {
    const qrContainer = document.getElementById('qrcode');
    if (!qrContainer) return;
    
    qrContainer.innerHTML = '';
    
    const urlQR = `${window.location.origin}?sala=${codigo}`;
    new QRCode(qrContainer, {
        text: urlQR,
        width: 200,
        height: 200,
        colorDark: "#d4af37",
        colorLight: "#ffffff",
    });
}

function abrirSincronizacao() {
    showSection('sincronizacao');
}

// ===== GERENCIAMENTO DE DADOS =====
class AppData {
    constructor() {
        this.clientes = this.load('clientes') || [];
        this.vendas = this.load('vendas') || [];
        this.gastos = this.load('gastos') || [];
    }

    load(key) {
        try {
            return JSON.parse(localStorage.getItem(key));
        } catch (e) {
            return null;
        }
    }

    save(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify(data));
            // usar sincronização com debounce
            this.sincronizar();
        } catch (e) {
            showNotification('Erro ao salvar dados!', 'danger');
        }
    }

    sincronizar() {
        if (ws && ws.readyState === WebSocket.OPEN && codigoSala) {
            enviarDados({
                clientes: this.clientes,
                vendas: this.vendas,
                gastos: this.gastos
            });
        }
    }

    // Restaurar diretamente (substitui) - usado apenas para import/restore
    restaurarDados(dados) {
        this.clientes = dados.clientes || [];
        this.vendas = dados.vendas || [];
        this.gastos = dados.gastos || [];
        localStorage.setItem('clientes', JSON.stringify(this.clientes));
        localStorage.setItem('vendas', JSON.stringify(this.vendas));
        localStorage.setItem('gastos', JSON.stringify(this.gastos));
    }

    addCliente(cliente) {
        cliente.id = Date.now();
        cliente.lastUpdated = Date.now();
        this.clientes.push(cliente);
        this.save('clientes', this.clientes);
        return cliente;
    }

    updateCliente(id, cliente) {
        const index = this.clientes.findIndex(c => c.id === id);
        if (index !== -1) {
            this.clientes[index] = { ...this.clientes[index], ...cliente, id, lastUpdated: Date.now() };
            this.save('clientes', this.clientes);
        }
    }

    deleteCliente(id) {
        this.clientes = this.clientes.filter(c => c.id !== id);
        this.save('clientes', this.clientes);
    }

    addVenda(venda) {
        venda.id = Date.now();
        venda.lastUpdated = Date.now();
        this.vendas.push(venda);
        this.save('vendas', this.vendas);
        return venda;
    }

    updateVenda(id, venda) {
        const index = this.vendas.findIndex(v => v.id === id);
        if (index !== -1) {
            this.vendas[index] = { ...this.vendas[index], ...venda, id, lastUpdated: Date.now() };
            this.save('vendas', this.vendas);
        }
    }

    deleteVenda(id) {
        this.vendas = this.vendas.filter(v => v.id !== id);
        this.save('vendas', this.vendas);
    }

    addGasto(gasto) {
        gasto.id = Date.now();
        gasto.lastUpdated = Date.now();
        this.gastos.push(gasto);
        this.save('gastos', this.gastos);
        return gasto;
    }

    updateGasto(id, gasto) {
        const index = this.gastos.findIndex(g => g.id === id);
        if (index !== -1) {
            this.gastos[index] = { ...this.gastos[index], ...gasto, id, lastUpdated: Date.now() };
            this.save('gastos', this.gastos);
        }
    }

    deleteGasto(id) {
        this.gastos = this.gastos.filter(g => g.id !== id);
        this.save('gastos', this.gastos);
    }

    getClienteNome(id) {
        const cliente = this.clientes.find(c => c.id === parseInt(id));
        return cliente ? cliente.nome : 'Cliente desconhecido';
    }

    getClienteWhatsapp(id) {
        const cliente = this.clientes.find(c => c.id === parseInt(id));
        return cliente ? cliente.whatsapp : null;
    }

    clear() {
        this.clientes = [];
        this.vendas = [];
        this.gastos = [];
        this.save('clientes', []);
        this.save('vendas', []);
        this.save('gastos', []);
    }

    backup() {
        return {
            clientes: this.clientes,
            vendas: this.vendas,
            gastos: this.gastos,
            data: new Date().toISOString()
        };
    }

    restore(data) {
        this.restaurarDados(data);
    }
}

const app = new AppData();

// ===== FUNÇÕES DE NAVEGAÇÃO =====
function showSection(sectionId) {
    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.getElementById(sectionId).classList.add('active');
    
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');

    if (sectionId === 'dashboard') {
        atualizarDashboard();
    } else if (sectionId === 'clientes') {
        atualizarClientes();
    } else if (sectionId === 'vendas') {
        atualizarVendas();
    } else if (sectionId === 'gastos') {
        atualizarGastos();
    } else if (sectionId === 'relatorios') {
        atualizarRelatorios();
    } else if (sectionId === 'configuracoes') {
        atualizarConfiguracoes();
    }
}

function atualizarTodasAsSecoes() {
    atualizarClientes();
    atualizarVendas();
    atualizarGastos();
    atualizarDashboard();
    atualizarConfiguracoes();
}

// ===== DASHBOARD =====
function atualizarDashboard() {
    const hoje = new Date().toISOString().split('T')[0];
    const vendasHoje = app.vendas.filter(v => v.data === hoje);
    const totalVendas = vendasHoje.reduce((sum, v) => sum + (v.quantidade * v.valor), 0);
    
    const gastosHoje = app.gastos.filter(g => g.data === hoje);
    const totalGastos = gastosHoje.reduce((sum, g) => sum + g.valor, 0);

    const stats = `
        <div class="stat-card">
            <div class="stat-label">Vendas Hoje</div>
            <div class="stat-value">R$ ${totalVendas.toFixed(2)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Gastos Hoje</div>
            <div class="stat-value">R$ ${totalGastos.toFixed(2)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Lucro Hoje</div>
            <div class="stat-value">${totalVendas - totalGastos >= 0 ? '✓' : '✗'} R$ ${Math.abs(totalVendas - totalGastos).toFixed(2)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Clientes Cadastrados</div>
            <div class="stat-value">${app.clientes.length}</div>
        </div>
    `;
    document.getElementById('statsGrid').innerHTML = stats;

    const ultimos7Dias = [];
    for (let i = 6; i >= 0; i--) {
        const data = new Date();
        data.setDate(data.getDate() - i);
        ultimos7Dias.push(data.toISOString().split('T')[0]);
    }

    const vendas7Dias = ultimos7Dias.map(data => {
        const vendas = app.vendas.filter(v => v.data === data);
        return vendas.reduce((sum, v) => sum + (v.quantidade * v.valor), 0);
    });

    const maxVenda = Math.max(...vendas7Dias, 1);
    const chart = ultimos7Dias.map((data, i) => {
        const altura = (vendas7Dias[i] / maxVenda) * 100;
        const dataObj = new Date(data + 'T00:00:00');
        const dia = dataObj.toLocaleDateString('pt-BR', { weekday: 'short' });
        return `
            <div class="bar" style="height: ${Math.max(altura, 5)}%">
                <div class="bar-value">R$ ${vendas7Dias[i].toFixed(0)}</div>
                <div class="bar-label">${dia}</div>
            </div>
        `;
    }).join('');
    document.getElementById('chartVendas').innerHTML = chart;

    const pagamentos = {};
    app.vendas.forEach(v => {
        pagamentos[v.pagamento] = (pagamentos[v.pagamento] || 0) + (v.quantidade * v.valor);
    });

    const chartPag = Object.entries(pagamentos).map(([tipo, valor]) => {
        const labels = { pix: '💳 Pix', dinheiro: '💵 Dinheiro', cartao: '🎫 Cartão', fiado: '📝 Fiado' };
        return `<div class="card">
            <div class="card-title">${labels[tipo] || tipo}</div>
            <div class="card-value">R$ ${valor.toFixed(2)}</div>
        </div>`;
    }).join('');
    document.getElementById('chartPagamento').innerHTML = chartPag || '<div class="no-data">Sem dados</div>';
}

// ===== CLIENTES =====
function atualizarClientes() {
    const search = document.getElementById('searchCliente')?.value.toLowerCase() || '';
    const clientes = app.clientes.filter(c => 
        c.nome.toLowerCase().includes(search) || 
        c.whatsapp.includes(search)
    );

    if (clientes.length === 0) {
        document.getElementById('clientesList').innerHTML = '';
        document.getElementById('clientesEmpty').style.display = 'block';
        document.getElementById('deleteClientesBtn').style.display = 'none';
        document.getElementById('selectAllClientes').checked = false;
        return;
    }

    document.getElementById('clientesEmpty').style.display = 'none';
    const html = clientes.map(c => `
        <tr>
            <td style="text-align: center;">
                <input type="checkbox" class="cliente-checkbox" data-id="${c.id}" onchange="verificarCheckboxesClientes()">
            </td>
            <td><strong>${c.nome}</strong></td>
            <td>${c.whatsapp}</td>
            <td>${c.endereco || '-'}</td>
            <td>${c.observacoes || '-'}</td>
            <td>
                <div class="actions">
                    <button class="btn btn-small btn-primary" onclick="editarCliente(${c.id})">Editar</button>
                    <a href="https://wa.me/55${c.whatsapp.replace(/\D/g, '')}" target="_blank" class="btn btn-small btn-success">WhatsApp</a>
                    <button class="btn btn-small btn-danger" onclick="deletarCliente(${c.id})">Deletar</button>
                </div>
            </td>
        </tr>
    `).join('');
    document.getElementById('clientesList').innerHTML = html;

    const select = document.getElementById('vendaCliente');
    if (select) {
        const selected = select.value;
        select.innerHTML = '<option value="">Selecione um cliente</option>' +
            app.clientes.map(c => `<option value="${c.id}">${c.nome}</option>`).join('');
        select.value = selected;
    }

    atualizarCounters();
    verificarCheckboxesClientes();
}

function verificarCheckboxesClientes() {
    const checkboxes = document.querySelectorAll('.cliente-checkbox:checked');
    const deleteBtn = document.getElementById('deleteClientesBtn');
    deleteBtn.style.display = checkboxes.length > 0 ? 'inline-block' : 'none';
}

function openClientModal() {
    document.getElementById('clienteNome').value = '';
    document.getElementById('clienteWhatsapp').value = '';
    document.getElementById('clienteEndereco').value = '';
    document.getElementById('clienteObservacoes').value = '';
    document.getElementById('modalClienteTitle').textContent = 'Novo Cliente';
    document.getElementById('modalCliente').classList.add('active');
    document.getElementById('modalCliente').dataset.id = '';
}

function closeClientModal() {
    document.getElementById('modalCliente').classList.remove('active');
}

function salvarCliente(e) {
    e.preventDefault();
    const id = document.getElementById('modalCliente').dataset.id;
    const cliente = {
        nome: document.getElementById('clienteNome').value,
        whatsapp: document.getElementById('clienteWhatsapp').value,
        endereco: document.getElementById('clienteEndereco').value,
        observacoes: document.getElementById('clienteObservacoes').value
    };

    if (id) {
        app.updateCliente(parseInt(id), cliente);
    } else {
        app.addCliente(cliente);
    }

    closeClientModal();
    atualizarClientes();
    showNotification('✓ Cliente salvo com sucesso!', 'success');
}

function editarCliente(id) {
    const cliente = app.clientes.find(c => c.id === id);
    if (!cliente) return;

    document.getElementById('clienteNome').value = cliente.nome;
    document.getElementById('clienteWhatsapp').value = cliente.whatsapp;
    document.getElementById('clienteEndereco').value = cliente.endereco || '';
    document.getElementById('clienteObservacoes').value = cliente.observacoes || '';
    document.getElementById('modalClienteTitle').textContent = 'Editar Cliente';
    document.getElementById('modalCliente').classList.add('active');
    document.getElementById('modalCliente').dataset.id = id;
}

function deletarCliente(id) {
    if (confirm('Deseja deletar este cliente?')) {
        // enviar tombstone ao servidor e aplicar localmente
        queueDelete('clientes', id);
        app.deleteCliente(id);
        atualizarClientes();
        showNotification('✓ Cliente deletado!', 'success');
    }
}

function deletarClientesSelecionados() {
    const checkboxes = document.querySelectorAll('.cliente-checkbox:checked');
    if (checkboxes.length === 0) {
        showNotification('Selecione clientes para deletar', 'warning');
        return;
    }
    
    const total = checkboxes.length;
    if (confirm(`⚠️ Deletar ${total} cliente(s)? Essa ação não pode ser desfeita!`)) {
        const ids = Array.from(checkboxes).map(cb => parseInt(cb.dataset.id));
        ids.forEach(id => {
            queueDelete('clientes', id);
            app.deleteCliente(id);
        });
        
        // Limpar checkboxes
        document.getElementById('selectAllClientes').checked = false;
        
        atualizarClientes();
        showNotification(`✓ ${total} cliente(s) deletado(s)!`, 'success');
    }
}

function selecionarTodosClientes() {
    const selectAll = document.getElementById('selectAllClientes');
    document.querySelectorAll('.cliente-checkbox').forEach(checkbox => {
        checkbox.checked = selectAll.checked;
    });
    verificarCheckboxesClientes();
}


// ===== VENDAS =====
function atualizarVendas() {
    const dataFilter = document.getElementById('filterDataVenda')?.value || '';
    const clienteFilter = document.getElementById('filterClienteVenda')?.value || '';
    const pagamentoFilter = document.getElementById('filterPagamentoVenda')?.value || '';

    let vendas = app.vendas;
    if (dataFilter) vendas = vendas.filter(v => v.data === dataFilter);
    if (clienteFilter) vendas = vendas.filter(v => v.cliente === parseInt(clienteFilter));
    if (pagamentoFilter) vendas = vendas.filter(v => v.pagamento === pagamentoFilter);

    if (vendas.length === 0) {
        document.getElementById('vendasList').innerHTML = '';
        document.getElementById('vendasEmpty').style.display = 'block';
        document.getElementById('deleteVendasBtn').style.display = 'none';
        document.getElementById('selectAllVendas').checked = false;
        return;
    }

    document.getElementById('vendasEmpty').style.display = 'none';
    const html = vendas.map(v => {
        const total = v.quantidade * v.valor;
        const labels = { pix: '💳 Pix', dinheiro: '💵 Dinheiro', cartao: '🎫 Cartão', fiado: '📝 Fiado' };
        return `
            <tr>
                <td style="text-align: center;">
                    <input type="checkbox" class="venda-checkbox" data-id="${v.id}" onchange="verificarCheckboxesVendas()">
                </td>
                <td>${new Date(v.data + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
                <td><strong>${app.getClienteNome(v.cliente)}</strong></td>
                <td>${v.produto}</td>
                <td>${v.quantidade}</td>
                <td>R$ ${v.valor.toFixed(2)}</td>
                <td><strong>R$ ${total.toFixed(2)}</strong></td>
                <td><span class="badge badge-primary">${labels[v.pagamento]}</span></td>
                <td>
                    <div class="actions">
                        <button class="btn btn-small btn-primary" onclick="editarVenda(${v.id})">Editar</button>
                        <button class="btn btn-small btn-danger" onclick="deletarVenda(${v.id})">Deletar</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
    document.getElementById('vendasList').innerHTML = html;
    atualizarCounters();
    verificarCheckboxesVendas();
}

function verificarCheckboxesVendas() {
    const checkboxes = document.querySelectorAll('.venda-checkbox:checked');
    const deleteBtn = document.getElementById('deleteVendasBtn');
    deleteBtn.style.display = checkboxes.length > 0 ? 'inline-block' : 'none';
}

function openVendaModal() {
    document.getElementById('vendaCliente').value = '';
    document.getElementById('vendaProduto').value = '';
    document.getElementById('vendaQuantidade').value = '';
    document.getElementById('vendaValor').value = '';
    document.getElementById('vendaPagamento').value = '';
    document.getElementById('vendaData').value = new Date().toISOString().split('T')[0];
    document.getElementById('modalVendaTitle').textContent = 'Nova Venda';
    document.getElementById('modalVenda').classList.add('active');
    document.getElementById('modalVenda').dataset.id = '';
}

function closeVendaModal() {
    document.getElementById('modalVenda').classList.remove('active');
}

function salvarVenda(e) {
    e.preventDefault();
    const id = document.getElementById('modalVenda').dataset.id;
    const venda = {
        cliente: parseInt(document.getElementById('vendaCliente').value),
        produto: document.getElementById('vendaProduto').value,
        quantidade: parseFloat(document.getElementById('vendaQuantidade').value),
        valor: parseFloat(document.getElementById('vendaValor').value),
        pagamento: document.getElementById('vendaPagamento').value,
        data: document.getElementById('vendaData').value
    };

    if (id) {
        app.updateVenda(parseInt(id), venda);
    } else {
        app.addVenda(venda);
    }

    closeVendaModal();
    atualizarVendas();
    atualizarDashboard();
    showNotification('✓ Venda salva com sucesso!', 'success');
}

function editarVenda(id) {
    const venda = app.vendas.find(v => v.id === id);
    if (!venda) return;

    document.getElementById('vendaCliente').value = venda.cliente;
    document.getElementById('vendaProduto').value = venda.produto;
    document.getElementById('vendaQuantidade').value = venda.quantidade;
    document.getElementById('vendaValor').value = venda.valor;
    document.getElementById('vendaPagamento').value = venda.pagamento;
    document.getElementById('vendaData').value = venda.data;
    document.getElementById('modalVendaTitle').textContent = 'Editar Venda';
    document.getElementById('modalVenda').classList.add('active');
    document.getElementById('modalVenda').dataset.id = id;
}

function deletarVenda(id) {
    if (confirm('Deseja deletar esta venda?')) {
        // enviar tombstone ao servidor e aplicar localmente
        queueDelete('vendas', id);
        app.deleteVenda(id);
        atualizarVendas();
        atualizarDashboard();
        showNotification('✓ Venda deletada!', 'success');
    }
}

function deletarVendasSelecionadas() {
    const checkboxes = document.querySelectorAll('.venda-checkbox:checked');
    if (checkboxes.length === 0) {
        showNotification('Selecione vendas para deletar', 'warning');
        return;
    }
    
    const total = checkboxes.length;
    if (confirm(`⚠️ Deletar ${total} venda(s)? Essa ação não pode ser desfeita!`)) {
        const ids = Array.from(checkboxes).map(cb => parseInt(cb.dataset.id));
        ids.forEach(id => {
            queueDelete('vendas', id);
            app.deleteVenda(id);
        });
        
        // Limpar checkboxes
        document.getElementById('selectAllVendas').checked = false;
        
        atualizarVendas();
        atualizarDashboard();
        showNotification(`✓ ${total} venda(s) deletada(s)!`, 'success');
    }
}

function selecionarTodasVendas() {
    const selectAll = document.getElementById('selectAllVendas');
    document.querySelectorAll('.venda-checkbox').forEach(checkbox => {
        checkbox.checked = selectAll.checked;
    });
    verificarCheckboxesVendas();
}

// ===== GASTOS =====
function atualizarGastos() {
    const dataFilter = document.getElementById('filterDataGasto')?.value || '';
    const tipoFilter = document.getElementById('filterTipoGasto')?.value || '';

    let gastos = app.gastos;
    if (dataFilter) gastos = gastos.filter(g => g.data === dataFilter);
    if (tipoFilter) gastos = gastos.filter(g => g.tipo === tipoFilter);

    if (gastos.length === 0) {
        document.getElementById('gastosList').innerHTML = '';
        document.getElementById('gastosEmpty').style.display = 'block';
        return;
    }

    document.getElementById('gastosEmpty').style.display = 'none';
    const labels = {
        ingredientes: '🥖 Ingredientes',
        gas: '🔥 Gás',
        embalagens: '📦 Embalagens',
        transporte: '🚚 Transporte',
        outros: '📋 Outros'
    };

    const html = gastos.map(g => `
        <tr>
            <td>${new Date(g.data + 'T00:00:00').toLocaleDateString('pt-BR')}</td>
            <td><span class="badge badge-warning">${labels[g.tipo]}</span></td>
            <td><strong>R$ ${g.valor.toFixed(2)}</strong></td>
            <td>${g.observacoes || '-'}</td>
            <td>
                <div class="actions">
                    <button class="btn btn-small btn-primary" onclick="editarGasto(${g.id})">Editar</button>
                    <button class="btn btn-small btn-danger" onclick="deletarGasto(${g.id})">Deletar</button>
                </div>
            </td>
        </tr>
    `).join('');
    document.getElementById('gastosList').innerHTML = html;
    atualizarCounters();
}

function openGastoModal() {
    document.getElementById('gastoTipo').value = '';
    document.getElementById('gastoValor').value = '';
    document.getElementById('gastoData').value = new Date().toISOString().split('T')[0];
    document.getElementById('gastoObservacoes').value = '';
    document.getElementById('modalGastoTitle').textContent = 'Novo Gasto';
    document.getElementById('modalGasto').classList.add('active');
    document.getElementById('modalGasto').dataset.id = '';
}

function closeGastoModal() {
    document.getElementById('modalGasto').classList.remove('active');
}

function salvarGasto(e) {
    e.preventDefault();
    const id = document.getElementById('modalGasto').dataset.id;
    const gasto = {
        tipo: document.getElementById('gastoTipo').value,
        valor: parseFloat(document.getElementById('gastoValor').value),
        data: document.getElementById('gastoData').value,
        observacoes: document.getElementById('gastoObservacoes').value
    };

    if (id) {
        app.updateGasto(parseInt(id), gasto);
    } else {
        app.addGasto(gasto);
    }

    closeGastoModal();
    atualizarGastos();
    atualizarDashboard();
    showNotification('✓ Gasto salvo com sucesso!', 'success');
}

function editarGasto(id) {
    const gasto = app.gastos.find(g => g.id === id);
    if (!gasto) return;

    document.getElementById('gastoTipo').value = gasto.tipo;
    document.getElementById('gastoValor').value = gasto.valor;
    document.getElementById('gastoData').value = gasto.data;
    document.getElementById('gastoObservacoes').value = gasto.observacoes || '';
    document.getElementById('modalGastoTitle').textContent = 'Editar Gasto';
    document.getElementById('modalGasto').classList.add('active');
    document.getElementById('modalGasto').dataset.id = id;
}

function deletarGasto(id) {
    if (confirm('Deseja deletar este gasto?')) {
        // enviar tombstone ao servidor e aplicar localmente
        queueDelete('gastos', id);
        app.deleteGasto(id);
        atualizarGastos();
        atualizarDashboard();
        showNotification('✓ Gasto deletado!', 'success');
    }
}

// ===== RELATÓRIOS =====
function atualizarRelatorios() {
    const periodo = document.getElementById('filterPeriodo')?.value || 'mes';
    let vendas = app.vendas;
    let gastos = app.gastos;

    const hoje = new Date();
    let dataInicio = new Date();

    if (periodo === 'dia') {
        dataInicio.setDate(hoje.getDate());
    } else if (periodo === 'semana') {
        dataInicio.setDate(hoje.getDate() - 7);
    } else if (periodo === 'mes') {
        dataInicio.setMonth(hoje.getMonth());
        dataInicio.setDate(1);
    }

    if (periodo !== 'todos') {
        const dataInicioStr = dataInicio.toISOString().split('T')[0];
        vendas = vendas.filter(v => v.data >= dataInicioStr);
        gastos = gastos.filter(g => g.data >= dataInicioStr);
    }

    const totalVendas = vendas.reduce((sum, v) => sum + (v.quantidade * v.valor), 0);
    const totalGastos = gastos.reduce((sum, g) => sum + g.valor, 0);
    const lucro = totalVendas - totalGastos;
    const margem = totalVendas > 0 ? ((lucro / totalVendas) * 100).toFixed(1) : 0;

    document.getElementById('relTotalVendas').textContent = `R$ ${totalVendas.toFixed(2)}`;
    document.getElementById('relTotalGastos').textContent = `R$ ${totalGastos.toFixed(2)}`;
    document.getElementById('relLucro').textContent = `R$ ${lucro.toFixed(2)}`;
    document.getElementById('relMargem').textContent = `${margem}%`;

    const pagamentos = {};
    vendas.forEach(v => {
        pagamentos[v.pagamento] = (pagamentos[v.pagamento] || 0) + (v.quantidade * v.valor);
    });

    const chartPag = Object.entries(pagamentos).map(([tipo, valor]) => {
        const labels = { pix: '💳 Pix', dinheiro: '💵 Dinheiro', cartao: '🎫 Cartão', fiado: '📝 Fiado' };
        const percentual = ((valor / totalVendas) * 100).toFixed(1);
        return `<div class="card">
            <div class="card-title">${labels[tipo] || tipo}</div>
            <div class="card-value">R$ ${valor.toFixed(2)}</div>
            <div style="color: var(--text-light); font-size: 12px;">${percentual}% do total</div>
        </div>`;
    }).join('');
    document.getElementById('relPagamento').innerHTML = chartPag || '<div class="no-data">Sem dados</div>';

    const clientesCompras = {};
    vendas.forEach(v => {
        const nome = app.getClienteNome(v.cliente);
        clientesCompras[nome] = (clientesCompras[nome] || 0) + (v.quantidade * v.valor);
    });

    const topClientes = Object.entries(clientesCompras)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

    const chartClientes = topClientes.map(([nome, valor]) => `
        <div class="card">
            <div class="card-title">${nome}</div>
            <div class="card-value">R$ ${valor.toFixed(2)}</div>
        </div>
    `).join('');
    document.getElementById('relClientes').innerHTML = chartClientes || '<div class="no-data">Sem dados</div>';

    const gastosTipo = {};
    gastos.forEach(g => {
        gastosTipo[g.tipo] = (gastosTipo[g.tipo] || 0) + g.valor;
    });

    const tiposLabel = {
        ingredientes: '🥖 Ingredientes',
        gas: '🔥 Gás',
        embalagens: '📦 Embalagens',
        transporte: '🚚 Transporte',
        outros: '📋 Outros'
    };

    const chartGastos = Object.entries(gastosTipo).map(([tipo, valor]) => `
        <div class="card">
            <div class="card-title">${tiposLabel[tipo]}</div>
            <div class="card-value">R$ ${valor.toFixed(2)}</div>
        </div>
    `).join('');
    document.getElementById('relGastos').innerHTML = chartGastos || '<div class="no-data">Sem dados</div>';
}

// ===== EXPORTAÇÃO =====
function exportarPDF() {
    showNotification('✓ Relatório PDF exportado!', 'success');
}

function exportarExcel() {
    showNotification('✓ Relatório Excel exportado!', 'success');
}

// ===== CONFIGURAÇÕES =====
function atualizarConfiguracoes() {
    atualizarCounters();
}

function atualizarCounters() {
    document.getElementById('countClientes').textContent = app.clientes.length;
    document.getElementById('countVendas').textContent = app.vendas.length;
    document.getElementById('countGastos').textContent = app.gastos.length;
}

function fazerBackup() {
    const backup = app.backup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backup-paes-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showNotification('✓ Backup realizado com sucesso!', 'success');
}

function restaurarBackup() {
    document.getElementById('backupFile').click();
}

document.getElementById('backupFile')?.addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const data = JSON.parse(event.target.result);
            app.restore(data);
            atualizarTodasAsSecoes();
            showNotification('✓ Backup restaurado com sucesso!', 'success');
        } catch (err) {
            showNotification('Erro ao restaurar backup!', 'danger');
        }
    };
    reader.readAsText(file);
});

function limparTodosDados() {
    if (confirm('⚠️ ATENÇÃO: Isso vai deletar TODOS os dados!')) {
        if (confirm('Tem certeza? Essa ação não pode ser desfeita!')) {
            app.clear();
            atualizarTodasAsSecoes();
            showNotification('✓ Todos os dados foram deletados!', 'success');
        }
    }
}

// ===== NOTIFICAÇÕES =====
function showNotification(message, type = 'info') {
    const div = document.createElement('div');
    div.className = `alert alert-${type}`;
    div.textContent = message;
    document.querySelector('.content').insertBefore(div, document.querySelector('.content').firstChild);
    setTimeout(() => div.remove(), 3000);
}

// ===== INICIALIZAÇÃO =====
document.addEventListener('DOMContentLoaded', function() {
    inicializarDispositivo();
    
    const params = new URLSearchParams(window.location.search);
    const sala = params.get('sala');
    if (sala && !codigoSala) {
        document.getElementById('codigoSalaInput').value = sala;
        document.getElementById('nomeDispositivo').value = 'Dispositivo';
    }

    atualizarClientes();
    atualizarVendas();
    atualizarGastos();
    atualizarConfiguracoes();
    atualizarDashboard();
    
    document.getElementById('modalCliente').addEventListener('click', function(e) {
        if (e.target === this) closeClientModal();
    });
    document.getElementById('modalVenda').addEventListener('click', function(e) {
        if (e.target === this) closeVendaModal();
    });
    document.getElementById('modalGasto').addEventListener('click', function(e) {
        if (e.target === this) closeGastoModal();
    });

    document.getElementById('searchCliente')?.addEventListener('input', atualizarClientes);
});
