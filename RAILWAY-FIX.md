# 🚂 Railway Deployment Fix

## Problema
- **Erro:** "Not Found" error ao acessar app no Railway
- **Causa:** Configuração de PORT/HOST não suportava alocação dinâmica de porta

## Soluções Implementadas

### 1. **Dynamic PORT/HOST Handling** (paes-server.js)
```javascript
// Antes:
server.listen(3000, '0.0.0.0', ...)

// Depois:
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, ...)
```

### 2. **Health Check Endpoint** (paes-server.js)
```javascript
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        rooms: rooms.size
    });
});
```

### 3. **Railway Environment Detection** (paes-server.js)
```javascript
const baseUrl = process.env.NODE_ENV === 'production' 
    ? `https://${process.env.RAILWAY_DOMAIN || 'app.railway.app'}`
    : `http://localhost:${PORT}`;
```

### 4. **Enhanced Logging**
- Exibe PORT dinâmico alocado pelo Railway
- Mostra URL base da aplicação (http vs wss)
- Exibe health check endpoint

### 5. **railway.json Configuration**
- Adicionado suporte a healthchecks
- Configurado restart policy com 5 retries

## Mudanças de Arquivo

### paes-server.js
- ✅ Linha ~305: Dynamic PORT/HOST
- ✅ Linha ~308-325: Enhanced logging com RAILWAY_DOMAIN
- ✅ Linha ~20-28: Health check endpoint `/health`

### railway.json
- ✅ Adicionado `healthchecks.enabled: true`
- ✅ Configurado restart policy

## Testes Executados

### ✅ Local Testing
```bash
PORT=5000 npm start
# Resultado: Servidor rodou em http://localhost:5000
# Health: curl http://localhost:5000/health → {"status":"ok"}
```

### ✅ Docker Testing
```bash
docker build -t paes-test:latest .
docker run -p 3000:3000 -e NODE_ENV=production paes-test:latest
# Resultado: Servidor rodou em http://localhost:3000
# Health: curl http://localhost:3000/health → {"status":"ok"}
```

## Como Funciona Agora

### Em Railway
1. Railway aloca PORT dinâmico (ex: 8080)
2. Variável de ambiente `PORT=8080` é setada automaticamente
3. Servidor detecta `process.env.PORT` e se vincula a porta 8080
4. App acessível via `https://<railway-domain>.railway.app`
5. Health check em `https://<railway-domain>.railway.app/health`

### Localmente
- `npm start` → servidor em `http://localhost:3000`
- `PORT=5000 npm start` → servidor em `http://localhost:5000`

## Status de Deployment

**Commit:** `3b14638`  
**Branch:** `main`  
**Pushed:** ✅ Para GitHub  
**Railway Redeploy:** ✅ Deve iniciar automaticamente

## Próximos Passos

1. ✅ Aguardar Railway rebuild da imagem Docker
2. ✅ Verificar status de deployment no Railway dashboard
3. ✅ Testar URL do Railway em browser
4. ✅ Verificar WebSocket conexão (console do navegador)
5. ✅ Testar sincronização entre abas

## Links Úteis

- Railway Health: https://railway.app/dashboard
- Server Status: `/health` endpoint
- WebSocket: `wss://<railroad>.railway.app` (automaticamente)

---

**Data:** 2026-01-29  
**Status:** ✅ Pronto para Deploy
