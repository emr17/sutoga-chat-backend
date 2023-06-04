const express = require('express')

const app = express()
const https = require('httpolyglot')
const fs = require('fs')
const mediasoup = require('mediasoup')
const Cryptr=  require('cryptr');
const { db, Message, Conservation } = require("./mongo-connection.js");
const bodyParser = require('body-parser');
const config = require('./config')
const path = require('path')
const Room = require('./Room')
const Peer = require('./Peer')
const cryptr = new Cryptr("myTotallySecretKey");


const options = {
    key: fs.readFileSync(path.join(__dirname, config.sslKey), 'utf-8'),
    cert: fs.readFileSync(path.join(__dirname, config.sslCrt), 'utf-8')
}

const httpsServer = https.createServer(options, app)
const io = require('socket.io')(httpsServer, {
    cors: {
        origin: "*", // veya belirli originler: ["http://localhost:3001", "https://another-domain.com"]
        methods: ["GET", "POST"]
    }
});

app.use(express.static(path.join(__dirname, '..', 'public')))

app.use(bodyParser.json());
httpsServer.listen(config.listenPort, () => {
    console.log('Listening on https://' + config.listenIp + ':' + config.listenPort)
})

// all mediasoup workers
let workers = []
let nextMediasoupWorkerIdx = 0

/**
 * roomList
 * {
 *  room_id: Room {
 *      id:
 *      router:
 *      peers: {
 *          id:,
 *          name:,
 *          master: [boolean],
 *          transports: [Map],
 *          producers: [Map],
 *          consumers: [Map],
 *          rtpCapabilities:
 *      }
 *  }
 * }
 */
let roomList = new Map()

;(async () => {
    await createWorkers()
})()

async function createWorkers() {
    let { numWorkers } = config.mediasoup

    for (let i = 0; i < numWorkers; i++) {
        let worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort
        })

        worker.on('died', () => {
            console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid)
            setTimeout(() => process.exit(1), 2000)
        })
        workers.push(worker)

        // log worker resource usage
        /*setInterval(async () => {
                const usage = await worker.getResourceUsage();

                console.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
            }, 120000);*/
    }
}
let onlineUsers = [];
let socketUserMap = {};
io.on('connection', (socket) => {
    socket.on('createRoom', async ({ room_id }, callback) => {
        if (roomList.has(room_id)) {
            callback('already exists')
        } else {
            console.log('Created room', { room_id: room_id })
            let worker = await getMediasoupWorker()
            roomList.set(room_id, new Room(room_id, worker, io))
            callback(room_id)
        }
    })

    socket.on('join', ({ room_id, name }, cb) => {
        console.log('User joined', {
            room_id: room_id,
            name: name
        })

        if (!roomList.has(room_id)) {
            return cb({
                error: 'Room does not exist'
            })
        }

        roomList.get(room_id).addPeer(new Peer(socket.id, name))
        socket.room_id = room_id

        cb(roomList.get(room_id).toJson())
    })

    socket.on('getProducers', () => {
        if (!roomList.has(socket.room_id)) return
        console.log('Get producers', { name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}` })

        // send all the current producer to newly joined member
        let producerList = roomList.get(socket.room_id).getProducerListForPeer()

        socket.emit('newProducers', producerList)
    })

    socket.on('getRouterRtpCapabilities', (_, callback) => {
        console.log('Get RouterRtpCapabilities', {
            name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        try {
            callback(roomList.get(socket.room_id).getRtpCapabilities())
        } catch (e) {
            callback({
                error: e.message
            })
        }
    })

    socket.on('createWebRtcTransport', async (_, callback) => {
        console.log('Create webrtc transport', {
            name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        try {
            const { params } = await roomList.get(socket.room_id).createWebRtcTransport(socket.id)

            callback(params)
        } catch (err) {
            console.error(err)
            callback({
                error: err.message
            })
        }
    })

    socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
        console.log('Connect transport', { name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}` })

        if (!roomList.has(socket.room_id)) return
        await roomList.get(socket.room_id).connectPeerTransport(socket.id, transport_id, dtlsParameters)

        callback('success')
    })

    socket.on('produce', async ({ kind, rtpParameters, producerTransportId }, callback) => {
        if (!roomList.has(socket.room_id)) {
            return callback({ error: 'not is a room' })
        }

    let producer_name =roomList.get(socket.room_id).getPeers().get(socket.id).name
    console.log("aaaaaaaaa" , producer_name)
    let producer_id = await roomList.get(socket.room_id).produce(socket.id, producerTransportId, rtpParameters, kind,producer_name);


        console.log('Produce', {
            type: `${kind}`,
            name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
            id: `${producer_id}`
        })

        callback({
            producer_id
        })
    })

    socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
        //TODO null handling
        let params = await roomList.get(socket.room_id).consume(socket.id, consumerTransportId, producerId, rtpCapabilities)

        console.log('Consuming', {
            name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
            producer_id: `${producerId}`,
            consumer_id: `${params.id}`
        })

        callback(params)
    })

    socket.on('resume', async (data, callback) => {
        await consumer.resume()
        callback()
    })

    socket.on('getMyRoomInfo', (_, cb) => {
        cb(roomList.get(socket.room_id).toJson())
    })

    socket.on('disconnect', () => {

        const username = socketUserMap[socket.id];
        if (username) {
            onlineUsers = onlineUsers.filter(user => user !== username);
            delete socketUserMap[socket.id];
            io.emit('online-users', onlineUsers);
        }
        console.log('Disconnect', {
            name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        if (!socket.room_id) return
        roomList.get(socket.room_id).removePeer(socket.id)
    })

    socket.on('producerClosed', ({ producer_id }) => {
        console.log('Producer close', {
            name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        roomList.get(socket.room_id).closeProducer(socket.id, producer_id)
    })

    socket.on('exitRoom', async (_, callback) => {
        console.log('Exit room', {
            name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
        })

        if (!roomList.has(socket.room_id)) {
            callback({
                error: 'not currently in a room'
            })
            return
        }
        // close transports
        await roomList.get(socket.room_id).removePeer(socket.id)
        if (roomList.get(socket.room_id).getPeers().size === 0) {
            roomList.delete(socket.room_id)
        }

        socket.room_id = null

        callback('successfully exited room')
    })

    socket.on('join room', (roomId) => {
        socket.join(roomId);
    });

    socket.on("message", (data) => {
        let dbMessage = new Message({
            sender: data.sender,
            receiver: data.receiver,
            date : data.date,
            roomId: data.roomId,
            isConservation: data.isConservation,
            message: cryptr.encrypt(data.message),
        });

        let messageToReturn = new Message({
            sender: data.sender,
            receiver: data.receiver,
            date : data.date,
            roomId: data.roomId,
            isConservation: data.isConservation,
            message: data.message,
        });

        dbMessage
            .save()
            .then((res) => {
                console.log("message saved to mongo", res)
                io.to(data.roomId).emit('createMessage', messageToReturn);
            })
            .catch((error) => console.error("message not saved to mongo", error));
    });

    socket.on('online', (username) => {
        onlineUsers = [...onlineUsers, username];
        socketUserMap[socket.id] = username;
        io.emit('online-users', onlineUsers);
    });

   
})

// TODO remove - never used?
function room() {
    return Object.values(roomList).map((r) => {
        return {
            router: r.router.id,
            peers: Object.values(r.peers).map((p) => {
                return {
                    name: p.name
                }
            }),
            id: r.id
        }
    })
}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker() {
    const worker = workers[nextMediasoupWorkerIdx]

    if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0

    return worker
}


app.post("/mediasoup/getMessages", (req, res) => {
    console.log(req.body);
    console.log(req.body.sender);
    console.log(req.body.receiver);
    let query = {};
    if (req.body.roomId) {
        // If roomId is provided, search only by roomId
        query = { roomId: req.body.roomId };
    } else {
        // If roomId is not provided, search by sender and receiver
        query = { $or: [
                { sender: req.body.sender, receiver: req.body.receiver },
                { sender: req.body.receiver, receiver: req.body.sender }
            ]};
    }

    Message.find(
        query,
        "sender receiver message date",
        (err, messages) => {
            if (err) return handleError(err);

            messages.map(
                (message) => (message.message = cryptr.decrypt(message.message))
            );

            res.send(messages);
        }
    );
});


app.post("/conservation", async (req, res) => {
    const { firstUser, secondUser,conservationId } = req.body;
    console.log(req.body)
    const newConservation = new Conservation({
        firstUser,
        secondUser,
        conservationId,
        lastUpdateDate: new Date().toISOString(),
    });

    try {
        const savedConservation = await newConservation.save();
        // Tüm kullanicilara yeni conservation'in olusturuldugunu bildiriyoruz.

        let data = {
            "conservation": savedConservation,
            "receiverList": [firstUser] // Assuming secondUser is defined somewhere in your code
        }
        io.emit('conservation', data);
        res.status(201).json(data);
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

app.post("/groupconservation", async (req, res) => {
    const {secondUser, groupId, groupMembers } = req.body;
    const newConservation = new Conservation({
        secondUser,
        groupId,
        groupMembers,
        lastUpdateDate: new Date().toISOString(),
    });

    try {
        const savedConservation = await newConservation.save();
        // Tüm kullanicilara yeni conservation'in olusturuldugunu bildiriyoruz.

        let data = {
            "conservation": savedConservation,
            "receiverList": groupMembers // Assuming secondUser is defined somewhere in your code
        }
        io.emit('conservation', data);
        res.status(201).json(data);
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

app.put("/groupconservation", async (req, res) => {
    const { groupId,secondUser, groupMembers } = req.body;
    try {
        const updatedConservation = await Conservation.findOneAndUpdate(
            { groupId },
            { secondUser, groupMembers, lastUpdateDate: new Date().toISOString() },
            { new: true }
        );
        
        let data = {
            "conservation": updatedConservation,
            "receiverList": [groupMembers] // Assuming secondUser is defined somewhere in your code
        }
        

        if (updatedConservation) {
        io.emit('conservation-update', data);
            res.json(updatedConservation);
        } else {
            res.status(404).json({ error: "Conservation not found" });
        }
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});



// Conservation güncelleme endpoint'i
app.put("/conservation", async (req, res) => {
    const { firstUser, secondUser } = req.body;
    try {
        const updatedConservation = await Conservation.findOneAndUpdate(
            { firstUser, secondUser },
            { lastUpdateDate: new Date().toISOString() },
            { new: true }
        );

        let data = {
            "conservation": updatedConservation,
            "receiverList": [firstUser] // Assuming secondUser is defined somewhere in your code
        }
        

        if (updatedConservation) {
        io.emit('conservation-update', data);
            res.json(updatedConservation);
        } else {
            res.status(404).json({ error: "Conservation not found" });
        }
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});



app.get("/conservation/:username", async (req, res) => {
    const { username } = req.params;
    try {
        const conservations = await Conservation.find({
            $or: [
                { firstUser: username },
                { groupMembers: { $in: [username] } }
            ]
        }).sort({ lastUpdateDate: -1 }); // en yenisi en üstte olacak sekilde siralama

        if (conservations) {
            res.json(conservations);
        } else {
            res.status(404).json({ error: "No conservations found" });
        }
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});

app.get("/conservation/:firstUser/:secondUser", async (req, res) => {
    const { firstUser, secondUser } = req.params;
    try {
        const conservation = await Conservation.findOne({ firstUser: firstUser, secondUser: secondUser });
        if (conservation) {
            res.json(conservation);
        } else {
            res.status(404).json({ error: "Conservation not found" });
        }
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});


app.get("/conservation/byConservationId/:conservationId", async (req, res) => {
    const { conservationId } = req.params;
    try {
        const conservation = await Conservation.findOne({ conservationId });
        if (conservation) {
            res.json(conservation);
        } else {
            res.status(404).json({ error: "Conservation not found" });
        }
    } catch (error) {
        res.status(500).json({ error: error.toString() });
    }
});
