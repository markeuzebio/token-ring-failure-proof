const tcpp = require("tcp-ping");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ping(host, port, max_attempts = 3, ms = 2000) 
{
    function pingHost(host, port) {
        return new Promise((resolve, reject) => {
            tcpp.probe(host, port, function (err, available) {

                if(!available) {
                    reject({ status: "dead" });
                } else {
                    resolve({ status: "alive" });
                }
            })
        });
    }

    async function ping2(counter = 1) {
        try {
            const result = await pingHost(host, port);
            return result;
        } catch(err) {
            if(counter < max_attempts) {
                await sleep(ms);
                return ping2(counter + 1);
            }

            return err;
        }
    }

    return await ping2();
}

module.exports = { sleep, ping };