
import express from 'express'
import bodyParser from 'body-parser'

const app = express()
const PORT = 4000

app.use(bodyParser.json())

app.post('/webhook', (req, res) => {
    console.log('\n===== WEBHOOK RECEIVED =====')
    console.log('Headers:', req.headers)
    console.log('Body:', JSON.stringify(req.body, null, 2))
    console.log('============================\n')
    res.sendStatus(200)
})

app.listen(PORT, () => {
    console.log(`Webhook tester listening on http://localhost:${PORT}`)
    console.log(`Target URL for webhook: http://localhost:${PORT}/webhook`)
})
