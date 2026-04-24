import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
    ],
    server: {
        host: true,
        port: 5173,
        strictPort: false,
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
