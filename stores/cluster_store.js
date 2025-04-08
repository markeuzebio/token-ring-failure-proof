const net = require('net');
const { ping } = require("../utils/utils");

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
            this.logMessage(`New connection from [${socket.remoteAddress}:${socket.remotePort}]`);

            socket.on('data', async data => {
                const message = JSON.parse(data);

                if (message.type === 'read') {
                    this.logMessage(`Recebeu: operação de read do cliente ${message.clientId}`);
                    socket.write(JSON.stringify({...this.data, status: "ACK" })); // Operação de read bem-sucedida
                } else if (message.type === 'write') {
                    if (this.isPrimary) {
                        await this.handleWrite(message.clientId, Math.random());
                        socket.write(JSON.stringify({ status: "ACK" })); // Significa que a operação de write deu certo
                    } else {
                        socket.write(JSON.stringify({ status: "NACK" })); // Significa que a operação de write deve ser enviada para o primario
                    }
                } else if (message.type === 'update' && !this.isPrimary) {
                    this.data = message.data;
                    this.logMessage(`Updatado!`);
                    socket.write('ACK');
                } else if (message.type === 'suspicious') {
                    this.logMessage(`Mensagem de SUSPICIOUS recebida para o STORE ${message.store_port}`);

                    // Se a porta informada pelo cliente é a do primário
                    if(message.store_port == "4000") {
                        let result = await ping("localhost", message.store_port, 3, 2000);

                        if(result.status == "dead") {
                            this.logMessage(`Store primário caiu. Renomeando store atual (${this.port}) como novo primário`);
                            this.isPrimary = true;
                            this.backupPorts = this.port == "4001" ? [4002] : [4001];
                            socket.write(JSON.stringify({ status: "ACK" }));
                        } else {
                            this.logMessage(`FALSO NEGATIVO PELO CLIENTE!`);
                            socket.write(JSON.stringify({ status: "NACK", response: "Store informado ainda está ativo!" }));
                        }
                    } else {
                        if(this.isPrimary) {
                            // Verifica se a porta indicada pelo cliente não existe mais
                            if(this.backupPorts.find(store_port => store_port == message.store_port) === undefined) {
                                this.logMessage(`Store informado pelo cliente (${message.store_port}) já não existe mais. Enviando ACK...`);
                                socket.write(JSON.stringify({ status: "ACK" })); // Manda mensagem de confirmação
                            } else {
                                let result = await ping("localhost", message.store_port, 3, 2000);

                                if(result.status == "dead") {
                                    this.logMessage(`Store ${message.store_port} realmente não responde. Reconfigurando ARRAY de STOREs...`);
                                    this.backupPorts = this.backupPorts.filter(store_port => store_port != message.store_port);
                                    this.logMessage(`Array de STOREs atualizado: ${this.backupPorts}`);
                                    socket.write(JSON.stringify({ status: "ACK" }));
                                } else {
                                    this.logMessage(`FALSO NEGATIVO PELO CLIENTE!`);
                                    socket.write(JSON.stringify({ status: "NACK", response: "Store informado ainda está ativo!" }));
                                }
                            }
                        } else { // Se o store atual não é o primário
                            // Somente repassa ao primário
                            const primary_socket = net.createConnection({ port: 4000, host: "localhost" }, () => {
                                this.logMessage("Repassando mensagem do cliente para o STORE primário");
                                primary_socket.write(JSON.stringify(message));
                            });

                            // Ao receber dado do primario, repassa para a mensagem respondida por ele para o cliente 
                            primary_socket.once("data", data => {
                                this.logMessage("Redirecionando mensagem do STORE primário para o cliente");
                                socket.write(data);
                                primary_socket.end();
                            });
                        }
                    }
                }
            });
        });
        server.listen(this.port, () => {
            this.logMessage(`Escutando na porta ${this.port}`);
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
            this.logMessage(`Recebeu todos os ACKs: ${acks.join(',')}`);
        }
    }

    // Propaga a atualização para os backups
    sendUpdate(port, data) {
        return new Promise((resolve, reject) => {
            const client = net.createConnection({ port }, () => {
                client.write(JSON.stringify({ type: 'update', data }));
            });

            client.on('data', data => {
                resolve(data.toString());
                client.end();
            });

            client.on('error', (err) => {
                this.logErrorMessage(`Error sending update to port ${port}: ${err.message}`);
                resolve('Error');
            });
        });
    }

    // Padroniza mensagens de log em [Store ${id}]: 
    logMessage(msg) {
        console.log(`[STORE ${this.id}${this.isPrimary ? " (PRIMÁRIO)" : ""}]: ${msg}`);
    }

    logErrorMessage(msg) {
        console.error(`[STORE ${this.id}${this.isPrimary ? " (PRIMÁRIO)" : ""}]: ${msg}`);
    }
}

// Configuração dos nós
const STORE_ID = parseInt(process.argv[2]);
const STORE_PORT = 4000 + STORE_ID;
const isPrimary = STORE_ID === 0;
const BACKUP_PORTS = isPrimary ? [4001, 4002] : [];
new StoreNode(STORE_ID, STORE_PORT, isPrimary, BACKUP_PORTS);