
import fetch from 'node-fetch'

const API_KEY = 'default-api-key'
const BASE_URL = 'http://localhost:3001/api'
const WEBHOOK_URL = 'http://localhost:4000/webhook'

async function runTests() {
    console.log('1. Configuring Webhook...')
    try {
        const res = await fetch(`${BASE_URL}/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY
            },
            body: JSON.stringify({
                url: WEBHOOK_URL,
                events: ['message', 'status']
            })
        })
        const data = await res.json()
        console.log('Webhook Configured:', data)
    } catch (e) {
        console.error('Failed to configure webhook:', e)
    }

    console.log('\n2. Checking Status...')
    try {
        const res = await fetch(`${BASE_URL}/status`, {
            headers: { 'x-api-key': API_KEY }
        })
        const data = await res.json()
        console.log('Status:', data)
    } catch (e) {
        console.error('Failed to get status:', e)
    }

    // Uncomment to test sending a message (requires a connected session)
    /*
    console.log('\n3. Sending Test Message...')
    try {
        const res = await fetch(`${BASE_URL}/send-message`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_KEY
            },
            body: JSON.stringify({
                phone: '628123456789', // Replace with a real number
                message: 'Hello from API!'
            })
        })
        const data = await res.json()
        console.log('Send Message Result:', data)
    } catch (e) {
        console.error('Failed to send message:', e)
    }
    */
}

runTests()
