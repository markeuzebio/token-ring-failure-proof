const net = require('net');

class StoreNode {
    constructor(id, port, isPrimary, backupPorts) {
        this.id = id;
        this.port = port;
        this.isPrimary = isPrimary;
        this.backupPorts = backupPorts; // Portas dos backups (apenas para o primário)
        this.data = {};
        this.startServer();
    }

    startServer() {
        const server = net.createServer(socket => {
            socket.on('data', async data => {
                const message = JSON.parse(data);
                if (message.type === 'read') {
                    this.logMessage(`Recebeu: operação de read do cliente ${message.clientId}`);
                    socket.write(JSON.stringify(this.data));
                } else if (message.type === 'write') {
                    if (this.isPrimary) {
                        await this.handleWrite(message.clientId, Math.random());
                        socket.write('Write completed');
                    } else {
                        socket.write('Error: Write must go to primary');
                    }
                } else if (message.type === 'update' && !this.isPrimary) {
                    this.data = message.data;
                    console.log(`Backup ${this.id} updated`);
                    socket.write('ACK');
                }
            });
        });
        server.listen(this.port, () => {
            console.log(`StoreNode ${this.id} listening on port ${this.port}`);
        });
    }

    async handleWrite(clientId, value) {
        // 1. Atualiza localmente no primário
        this.logMessage(`Lidando com a escrita do cliente ${clientId}`);
        this.data[`item_${Date.now()}`] = value;
        if (Object.keys(this.data).length > 10) { // Limite de 10 itens
            delete this.data[Object.keys(this.data)[0]]; // Remove o mais antigo
        }
        this.logMessage(`Atualizou localmente!`);

        // 2. Propaga a atualização para os backups (se for o primário)
        if (this.isPrimary && this.backupPorts.length > 0) {
            const acks = await Promise.all(
                this.backupPorts.map(port => this.sendUpdate(port, this.data))
            );
            console.log(`Primary ${this.id} received all ACKs: ${acks.join(',')}`);
        }
    }

    // Propaga a atualização para os backups
    sendUpdate(port, data) {
        return new Promise((resolve) => {
            const client = net.createConnection({ port }, () => {
                client.write(JSON.stringify({ type: 'update', data }));
            });
            client.on('data', data => {
                resolve(data.toString());
                client.end();
            });
            client.on('error', (err) => {
                console.error(`Error sending update to port ${port}: ${err.message}`);
                resolve('Error');
            });
        });
    }

    // Padroniza mensagens de log em [Store ${id}]: 
    logMessage(msg) {
        console.log(`[STORE ${this.id}${this.isPrimary ? " (PRIMÁRIO)" : ""}]: ${msg}`);
    }
}

// Configuração dos nós
const STORE_ID = parseInt(process.argv[2]);
const STORE_PORT = 4000 + STORE_ID;
const isPrimary = STORE_ID === 0;
const BACKUP_PORTS = isPrimary ? [4001, 4002] : [];
new StoreNode(STORE_ID, STORE_PORT, isPrimary, BACKUP_PORTS);