
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} from './src'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import fs from 'fs'
// @ts-ignore
import QRCode from 'qrcode'
import { FlowAssistant } from './src/flow-assistant/FlowAssistant'

const CONTACTS_FILE = './contacts_db.json'
const MESSAGES_FILE = './messages_db.json'

function loadContacts() {
    if (fs.existsSync(CONTACTS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8'))
        } catch (e) {
            return {}
        }
    }
    return {}
}

function saveContacts(contacts: any) {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2))
}

function loadMessages() {
    if (fs.existsSync(MESSAGES_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf-8'))
        } catch (e) {
            return []
        }
    }
    return []
}

function saveMessage(message: any) {
    const messages = loadMessages()
    messages.push(message)
    // Keep only last 1000 messages to prevent file from growing too large
    if (messages.length > 1000) messages.shift()
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2))
}

let storedContacts = loadContacts()
const app = express()
app.use(cors())
app.use(express.json()) // Add JSON body parser

const FLOWS_FILE = './flows_db.json'
const httpServer = createServer(app)
const io = new Server(httpServer, {
    cors: { origin: '*' }
})

// API Routes for Chat Flows
app.get('/api/flows', (req, res) => {
    if (fs.existsSync(FLOWS_FILE)) {
        res.json(JSON.parse(fs.readFileSync(FLOWS_FILE, 'utf-8')))
    } else {
        res.status(404).json({ error: 'Flows file not found' })
    }
})

app.post('/api/flows', (req, res) => {
    try {
        fs.writeFileSync(FLOWS_FILE, JSON.stringify(req.body, null, 2))
        res.json({ success: true })
    } catch (e) {
        res.status(500).json({ error: 'Failed to save flows' })
    }
})

const logger = pino({ level: 'info' })

let sockInstance: any = null
let connectionStatus: string = 'close'
let isStarting = false
let flowAssistant: FlowAssistant | null = null

async function startWhatsApp() {
    if (isStarting) return
    isStarting = true

    try {
        const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            syncFullHistory: false, // Explicitly disable full history sync
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000, // Increase timeout to 60s
            defaultQueryTimeoutMs: 0,
            shouldSyncHistoryMessage: () => false, // Do not sync any history messages
        })

        sockInstance = sock
        flowAssistant = new FlowAssistant(sock)

        sock.ev.process(async (events) => {
            if (events['connection.update']) {
                const update = events['connection.update']
                const { connection, lastDisconnect, qr } = update

                if (qr) {
                    console.log('QR Code generated, emitting to clients...')
                    const qrDataURL = await QRCode.toDataURL(qr)
                    io.emit('qr', qrDataURL)
                }

                if (connection) {
                    connectionStatus = connection
                    console.log(`Connection status: ${connection}`)
                    io.emit('connection.update', { connection })
                    if (connection === 'open') {
                        isStarting = false
                    }
                }

                if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
                    if (shouldReconnect) {
                        console.log('Reconnecting in 5s...')
                        isStarting = false
                        setTimeout(() => startWhatsApp(), 5000)
                    } else {
                        console.log('Logged out or session closed. Preparing for new session...')
                        sockInstance = null
                        isStarting = false
                        // Clean up auth folder to ensure a fresh QR is generated
                        if (fs.existsSync('baileys_auth_info')) {
                            try {
                                fs.rmSync('baileys_auth_info', { recursive: true, force: true })
                            } catch (e) {
                                console.error('Failed to clear auth info:', e)
                            }
                        }
                        // Start again to generate new QR
                        setTimeout(() => startWhatsApp(), 2000)
                    }
                }
            }

            if (events['creds.update']) {
                await saveCreds()
            }

            // Disable old message sync
            /*
            if (events['messaging-history.set']) {
                const { contacts, messages } = events['messaging-history.set']
                contacts?.forEach(c => {
                    if (c.id) storedContacts[c.id] = c.name || c.notify || storedContacts[c.id]
                })
                saveContacts(storedContacts)
                io.emit('contacts.update', Object.entries(storedContacts).map(([id, name]) => ({ id, name })))
                io.emit('messaging-history.set', events['messaging-history.set'])
            }
            */

            if (events['contacts.update']) {
                events['contacts.update'].forEach(c => {
                    if (c.id) storedContacts[c.id] = c.name || c.notify || storedContacts[c.id]
                })
                saveContacts(storedContacts)
                io.emit('contacts.update', events['contacts.update'])
            }

            if (events['messages.upsert']) {
                const upsert = events['messages.upsert']
                upsert.messages.forEach(async msg => {
                    const jid = msg.key.remoteJid
                    if (!jid) return

                    // Save new message to local database
                    saveMessage(msg)

                    if (msg.pushName && !storedContacts[jid]) {
                        storedContacts[jid] = msg.pushName
                        saveContacts(storedContacts)
                        io.emit('contacts.update', [{ id: jid, name: msg.pushName }])
                    }

                    // Handle Chat Flow Assistant
                    if (!msg.key.fromMe && flowAssistant) {
                        const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
                        if (text) {
                            await flowAssistant.handleMessage(jid, text)
                        }
                    }
                })
                io.emit('messages.upsert', upsert)
            }
        })

        return sock
    } catch (err) {
        console.error('Failed to start WhatsApp:', err)
        isStarting = false
        setTimeout(() => startWhatsApp(), 5000)
        return null
    }
}

io.on('connection', async (socket) => {
    console.log('Client connected')

    // Send current status
    socket.emit('connection.update', { connection: connectionStatus })
    socket.emit('contacts.update', Object.entries(storedContacts).map(([id, name]) => ({ id, name })))

    // Send local messages to the client on connect
    socket.emit('messages.history', loadMessages())

    // WhatsApp is already starting or started at the bottom of the file

    socket.on('logout', async () => {
        if (sockInstance) {
            try {
                await sockInstance.logout()
            } catch (e) {
                console.error('Logout error (already disconnected?):', e)
            }
            sockInstance = null
            connectionStatus = 'close'
            io.emit('connection.update', { connection: 'close' })
        } else {
            // If already disconnected, just clear folder and restart
            if (fs.existsSync('baileys_auth_info')) {
                fs.rmSync('baileys_auth_info', { recursive: true, force: true })
            }
            startWhatsApp()
        }
    })

    socket.on('refreshQR', async () => {
        console.log('User requested QR refresh...')
        if (sockInstance) {
            try {
                sockInstance.end(new Error('Manual refresh'))
            } catch (e) { }
            sockInstance = null
        }

        // Clear auth info to ensure new QR
        if (fs.existsSync('baileys_auth_info')) {
            try {
                fs.rmSync('baileys_auth_info', { recursive: true, force: true })
            } catch (e) {
                console.error('Failed to clear auth info during refresh:', e)
            }
        }

        isStarting = false
        startWhatsApp()
    })

    socket.on('sendMessage', async (data) => {
        let { jid, text } = data
        if (!jid.includes('@')) {
            jid = `${jid}@s.whatsapp.net`
        }
        if (sockInstance && sockInstance.user) {
            await sockInstance.sendMessage(jid, { text })
        }
    })

    socket.on('downloadMedia', async (message) => {
        if (sockInstance) {
            try {
                const buffer = await downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: sockInstance.reuploadRequest })
                socket.emit('mediaDownloaded', { messageId: message.key.id, data: buffer.toString('base64'), mimetype: message.message.imageMessage?.mimetype || message.message.documentMessage?.mimetype || 'application/octet-stream' })
            } catch (error) {
                console.error('Error downloading media:', error)
            }
        }
    })
})

const PORT = 3001
httpServer.listen(PORT, () => {
    console.log(`Dashboard Server listening on port ${PORT}`)
    startWhatsApp() // Start WhatsApp engine on server launch
})
