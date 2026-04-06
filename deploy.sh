
#!/bin/bash

# Easy Deployment Script
# 1. Installs Dependencies
# 2. Builds Frontend
# 3. Starts Backend (which serves Frontend)

echo "--- 🚀 Starting Deployment ---"

# 1. Build Frontend
echo "--- 📦 Building Frontend ---"
cd dashboard
if [ ! -d "node_modules" ]; then
    npm install
fi
npm run build
cd ..

# 2. Setup Backend
echo "--- 🔧 Setting up Backend ---"
if [ ! -d "node_modules" ]; then
    npm install
fi

# 3. Start
echo "--- ✅ Deployment Ready. Starting Server... ---"
echo "Server will run on port 3001"
echo "Access at http://localhost:3001"

npx tsx dashboard-server.ts
