import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const buildId = process.env.QMESSAGE_BUILD_ID
    || new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)

// https://vitejs.dev/config/
export default defineConfig({
    define: {
        __QMESSAGE_BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [
        react(),
        tailwindcss(),
    ],
    server: {
        host: true,
        port: 5173,
        strictPort: true,
        allowedHosts: ['2fast.xyz', '.2fast.xyz', 'localhost', '127.0.0.1'],
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: false,
            },
            '/socket.io': {
                target: 'http://localhost:3000',
                ws: true,
                changeOrigin: false,
            },
            '/addon': {
                target: 'http://localhost:3000',
                changeOrigin: false,
            },
            '/webhook': {
                target: 'http://localhost:3000',
                changeOrigin: false,
            },
        },
    }
})
