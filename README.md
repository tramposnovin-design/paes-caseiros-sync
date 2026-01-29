# 🥖 Pães Caseiros - Sistema Sincronizado

Sistema web completo para gestão de pães caseiros com **sincronização em tempo real entre múltiplos dispositivos**.

## 🎯 Funcionalidades

✅ **Gestão de Clientes** - Cadastro, edição e busca de clientes  
✅ **Registro de Vendas** - Controle de vendas com produtos e formas de pagamento  
✅ **Controle de Gastos** - Rastreamento de despesas  
✅ **Dashboard** - Visualização de métricas em tempo real  
✅ **Relatórios** - Análise detalhada de vendas e gastos  
✅ **Sincronização Multi-Dispositivo** - Compartilhar dados entre celulares  
✅ **QR Code** - Conectar dispositivos facilmente via QR Code  
✅ **Backup/Restauração** - Exportar e importar dados  
✅ **Exportação** - Relatórios em PDF e Excel  

## 🚀 Instalação

### Pré-requisitos
- Node.js 14+ instalado
- npm (geralmente vem com Node.js)

### Passos para instalar

1. **Clone ou baixe o projeto**
```bash
cd paes-caseiros-sync
```

2. **Instale as dependências**
```bash
npm install
```

3. **Inicie o servidor**
```bash
npm start
```

O servidor vai rodar em `http://localhost:3000`

### Modo desenvolvimento (com auto-reload)
```bash
npm run dev
```

## 📱 Usando em 2 Celulares

### Opção 1: Via QR Code (Mais Fácil)

1. **Abra no primeiro celular:**
   - Acesse `http://SEU_IP:3000` (ex: `http://192.168.1.100:3000`)
   - Vá para a seção "Sincronização"
   - Clique em "Criar Nova Sala"
   - Um QR Code aparecerá

2. **Conecte o segundo celular:**
   - Abra o navegador no segundo celular
   - Escaneie o QR Code com a câmera do celular
   - Será redirecionado para a sala automaticamente
   - Clique em "Conectar"

### Opção 2: Via Código Manual

1. **Celular 1:**
   - Acesse `http://SEU_IP:3000`
   - Vá para "Sincronização"
   - Clique em "Criar Nova Sala"
   - Copie o código (ex: ABC123)

2. **Celular 2:**
   - Acesse `http://SEU_IP:3000`
   - Vá para "Sincronização"
   - Cole o código em "Código da Sala"
   - Digite um nome para o dispositivo (ex: "Celular João")
   - Clique em "Conectar"

## 🔄 Como Funciona a Sincronização

- Quando um dispositivo cria uma venda, gasto ou adiciona cliente, os dados são sincronizados em **tempo real** para todos os dispositivos conectados
- Os dados também são salvos no navegador localmente (localStorage)
- Todos os dispositivos sempre têm a mesma informação

## 💾 Backup

1. Vá para "Configurações"
2. Clique em "Fazer Backup"
3. Um arquivo `.json` será baixado
4. Para restaurar, clique em "Restaurar Backup" e selecione o arquivo

## 📊 Exportação

1. Vá para "Relatórios"
2. Escolha o período (Hoje, Semana, Mês, Todos)
3. Clique em "Exportar PDF" ou "Exportar Excel"

## 🌐 Acessar de Fora da Rede Local

Se quiser acessar de fora da rede (internet), você precisará:

1. Usar um serviço de tunelamento como Ngrok:
```bash
ngrok http 3000
```

2. Ou deploy em um servidor como Heroku, Railway, Vercel, etc.

## 📝 Estrutura de Dados

### Clientes
- Nome
- WhatsApp
- Endereço
- Observações

### Vendas
- Data
- Cliente
- Produto
- Quantidade
- Valor Unitário
- Forma de Pagamento (Pix, Dinheiro, Cartão, Fiado)

### Gastos
- Data
- Tipo (Ingredientes, Gás, Embalagens, Transporte, Outros)
- Valor
- Observações

## 🔐 Segurança

- Dados armazenados localmente no navegador
- Sincronização via Socket.IO
- Salas expõem por código compartilhado (não é um sistema seguro para dados sensíveis)

## 🐛 Troubleshooting

**Problema:** "Não consegue conectar"
- Verifique se ambos os dispositivos estão na mesma rede WiFi
- Verifique o IP correto do servidor

**Problema:** "Dados não sincronizam"
- Verifique a conexão com a internet
- Atualize a página
- Crie uma nova sala

**Problema:** "Porta 3000 já em uso"
```bash
# Linux/Mac
lsof -i :3000
kill -9 <PID>

# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

## 📱 Compatibilidade

- Chrome/Edge (Windows, Android)
- Firefox (Windows, Android)
- Safari (iOS)
- Qualquer navegador moderno com suporte a WebSocket

## 🤝 Suporte

Para dúvidas ou problemas, verifique o console do navegador (F12) para erros.

## 📄 Licença

Uso livre para fins pessoais e comerciais.

---

**Desenvolvido com ❤️ para pequenos negócios**
