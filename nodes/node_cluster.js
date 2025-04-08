const zmq = require("zeromq");
const net = require("net");
const { sleep, ping } = require("../utils/utils");

// Pre-set usando kubernetes
{
    // // Configuração da rede
    // const TOKEN_PORT = 6000;
    // const CLIENT_PORT = 7000;
    // const TOTAL_NODES = 5;

    // // Obtém o ID do nó a partir do hostname
    // function getPodId() {
    //     const hostname = os.hostname();
    //     const match = hostname.match(/cluster-node-(\d+)/);
    //     return match ? parseInt(match[1], 10) : -1;
    // }

    // const NODE_ID = getPodId();
    // const MY_TOKEN_ADDR = `tcp://cluster-node-${NODE_ID}.cluster-node-service.default.svc.cluster.local:${TOKEN_PORT}`;
    // const NEXT_NODE = `tcp://cluster-node-${(NODE_ID + 1) % TOTAL_NODES}.cluster-node-service.default.svc.cluster.local:${TOKEN_PORT}`;
    // const CLIENT_RECEIVE = `tcp://cluster-node-${NODE_ID}.cluster-node-service.default.svc.cluster.local:${CLIENT_PORT}`;
    // const CLIENT_SEND = `tcp://client-node-${NODE_ID}.client-service.default.svc.cluster.local:${CLIENT_PORT}`;
}

const TOTAL_NODES = 5;
const NODE_ID = +`${process.argv[2]}`;
const NODES_PORT_BASE = "500";
const CLIENT_RECEIVE_PORT_BASE = "800";
const CLIENT_SEND_PORT_BASE = "700";
const NEXT_NODE = `tcp://localhost:${NODES_PORT_BASE.concat((NODE_ID + 1) % TOTAL_NODES)}`;
const MY_TOKEN_ADDR = `tcp://localhost:${NODES_PORT_BASE.concat(NODE_ID)}`;
const CLIENT_RECEIVE = `tcp://localhost:${CLIENT_RECEIVE_PORT_BASE.concat(NODE_ID)}`;
const CLIENT_SEND = `tcp://localhost:${CLIENT_SEND_PORT_BASE.concat(NODE_ID)}`;
let TOTAL_STORES = 3;
let STORE_PORTS = [4000, 4001, 4002]; // Porta no indíce 0 sempre sera a de escrita
let PRIMARY_STORE_PORT = 4000;

const receivedBuffer = [];
const processedBuffer = [];

// Função para receber a msg do cliente
async function clientReceiverThread() {
    const sock = new zmq.Pull(); // serve para criar o socket
    await sock.bind(CLIENT_RECEIVE); // conecta com o cliente para receber o pedido do cliente

    for await (const [msg] of sock) {
        const message = JSON.parse(msg.toString()); // converte a msg em string
        console.log(`[Nó ${NODE_ID}] Recebeu pedido do cliente: ${message[0]} | timestamp: ${message[1]} | operação: ${message[2]}`);
        receivedBuffer.push(message);
    }
}

// Mandar msg para o cliente
async function clientSenderThread() {
    const sock = new zmq.Push();
    await sock.connect(CLIENT_SEND); // manda para o endereço do cliente, esse endereço é onde o cliente vai ouvir as msgs

    while (true) {
        await sleep(5000); // espera de 5 segundos 
        if (processedBuffer.length > 0) {
            // buffer pega a primeira msg em envia para o cliente e dps fica vazio
            const msg = processedBuffer.shift(); // buffer ou acumulador, se nao tiver vazio a funcao remove a primeira msg do buffer
            await sock.send(JSON.stringify(msg)); // converte em json e manda pro cliente 
            console.log(`[Nó ${NODE_ID}] Enviou resposta para o cliente: ${JSON.stringify(msg)}`);
        }
    }
}

async function tokenReceiverThread() {
    await sleep(1000);
    const sock = new zmq.Pull(); // token recebe msg dos remetentes
    await sock.bind(MY_TOKEN_ADDR); // esse endereço é onde o nó está ouvindo para receber o token

    for await (const [msg] of sock) { // aguarda msg do socket 
        let token = JSON.parse(msg.toString()); // processa o token
        console.log(`[Nó ${NODE_ID}] Recebeu token`);
        await sleep(Math.random() * 800 + 200);

        // quando o cliente manda msg, esta é armazenada em um token que vai ser criado dependendo do numero de nós
        if (token[NODE_ID][1] !== -1) { // se o token contem um pedido atual para o nó
            let isSmallest = token.every(entry => entry[1] === -1 || entry[1] >= token[NODE_ID][1]);
            if (isSmallest) { // verifica qual nó tem o menor timestamp
                console.log(`[Nó ${NODE_ID}] Entrando na zona crítica`);
                
                while (receivedBuffer.length > 0) {
                    const request = receivedBuffer.shift(); // processa todos os pedidos do cliente no buffer recebido e armazena no receveid
                    const request_processed_message = await requestProcessingThread(request);

                    if(request_processed_message != "")
                        processedBuffer.push(request_processed_message);
                }
                
                token[NODE_ID] = ["", -1];
                console.log(`[Nó ${NODE_ID}] Saindo da zona crítica`);
            }
        }
        
        if (receivedBuffer.length > 0 && token[NODE_ID][1] === -1) {
            token[NODE_ID] = receivedBuffer.shift(); // se o token atual nao tem nenhum pedido armazenado, o nó adiciona o novo pedido ao token
        }
        
        // passar o token para o próximo nó
        const nextSock = new zmq.Push(); // cria um socket para enviar o token
        await nextSock.connect(NEXT_NODE); // conecta ao endereço para o proximo no
        await nextSock.send(JSON.stringify(token)); // O token é enviado para o próximo nó,
        console.log(`[Nó ${NODE_ID}] Enviou token para o próximo nó`);
    }
}

async function tokenCreatorThread() {
    if (NODE_ID === 4) {
        await sleep(2000); // espera de 2 segundos 
        const sock = new zmq.Push();
        await sock.connect(NEXT_NODE);

        console.log(`[Nó ${NODE_ID}] Criou o token`);
        await sleep(1000);
        const token = Array(TOTAL_NODES).fill(["", -1]);
        await sock.send(JSON.stringify(token));
        console.log(`[Nó ${NODE_ID}] Iniciou o token`);
    }
}

async function accessResource(operation, store_port) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection({ port: store_port, host: "localhost" }, () => {
            console.log(`[Nó ${NODE_ID}] Mandando operação de ${operation} para store de porta [${store_port}]`);
            client.write(JSON.stringify({ type: operation, clientId: NODE_ID }));
        });

        client.once("data", payload => {
            const data = JSON.parse(payload);
            console.log(`[Nó ${NODE_ID}] Recebeu ${data.status} de store de porta [${store_port}]`);
            client.end();
            resolve(data);
        });

        client.once("error", err => {
            client.end();
            reject(new Error(`[Nó ${NODE_ID}] falhou em acessar store de porta ${store_port}: ${err.message}`))
        });
    });
}

// Responsável por retonar as portas dos stores que estão respondendo aos pings, somente
async function getAliveStores(dead_store) {
    const alive_ports = await Promise.all (
        STORE_PORTS.map(async (port) => {
            if(port != dead_store) {
                const result = await ping("localhost", port, 3, 2000);
    
                if(result.status == "alive")
                    return port;
            }
    
            return null;
        })
    );

    return alive_ports.filter(Boolean);  
}

async function sendSuspiciousNextStore(store_port, dead_store_port) {
    return new Promise((resolve) => {
        const store_socket = net.createConnection({ port: store_port, host: "localhost" }, () => {
            store_socket.write(JSON.stringify({type: "suspicious", store_port: dead_store_port}));
        });

        store_socket.once("data", payload => {
            const data = JSON.parse(payload);

            // Se enviar um ACK significa que a STORE de porta ${dead_store_port} realmente não ouve mais
            if(data.status = "ACK") {
                STORE_PORTS = STORE_PORTS.filter(store_port => store_port != dead_store_port);
                TOTAL_STORES--;

                // Se a porta que não ouve mais é a do STORE primário, atualiza-o
                if(dead_store_port == PRIMARY_STORE_PORT)
                    PRIMARY_STORE_PORT = store_port;
            }

            store_socket.end();
            resolve(data);
        });
    });
}

async function requestProcessingThread(message) {
    const operation = message[2];
    const request_store_port = operation == "read" ? STORE_PORTS[Math.floor(Math.random() * TOTAL_STORES)] : PRIMARY_STORE_PORT;

    try {
        console.log(`[Nó ${NODE_ID}] Tentando acessar o STORE de porta ${request_store_port}`);
        const result = await ping("localhost", request_store_port, 3, 2000);

        // Caso não tenha sido possível se comunicar com a porta especificada do store port
        if(result.status == "dead") {
            console.log(`[Nó ${NODE_ID}] Não foi possível acessar o STORE de porta ${request_store_port} após tentativas`);
            const alive_ports = await getAliveStores();

            // Se ainda há STORES ativos e respondendo sadiamente
            if(alive_ports.length > 0) {
                console.log(`[Nó ${NODE_ID}] Mandando operação de SUSPICIOUS para store de porta [${alive_ports[0]}] sobre store de porta ${request_store_port}`);
                const store_response = await sendSuspiciousNextStore(alive_ports[0], request_store_port);

                if(store_response.status == "ACK") {
                    console.log(`[Nó ${NODE_ID}] Alterou o ARRAY de STORES ativos: ${STORE_PORTS}`);
                } else {
                    console.log(`[Nó ${NODE_ID}] ${store_response.response}`);
                }

                // Retorna uma mensagem vazia, indicando que uma reconfiguração foi feita e a tentativa de request deve ser feita no futuro
                // obedecendo a nova configuração
                return "";
            } else {
                return "Todos os stores estão inativos. Não é possível realizar operação";
            }
        } else {
            console.log(`[Nó ${NODE_ID}] Conexão ao STORE de porta ${request_store_port} bem sucedida!`);
            const store_response = await accessResource(operation, request_store_port);
            await sleep(Math.random() * (1000 - 200) + 200); // Simula um atraso de execução entre 200ms e 1s
            return store_response;
        }
    } catch(err) {
        console.log(err.message);
        return err.message;
    }
}

(async () => {
    await Promise.all([
        clientReceiverThread(),
        clientSenderThread(),
        tokenReceiverThread(), // Função que recebe e processa tokens de outros nós.
        tokenCreatorThread() ///  Função que cria o token inicial
    ]);
})();