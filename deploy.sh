#!/usr/bin/env bash
set -e

# ============================================================
# MyCashBridge — Server Deployment & Update Script
# ============================================================
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
# ============================================================

echo "============================================================"
echo "🚀 Starting MyCashBridge update & deployment..."
echo "============================================================"

# Navigate to script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Pull latest code from GitHub
echo "📥 1/4 Pulling latest changes from origin/main..."
git fetch origin main
git reset --hard origin/main

# 2. Install backend dependencies
echo "📦 2/4 Installing backend dependencies..."
cd "$SCRIPT_DIR/backend"
npm install --omit=dev

# 3. Check for .env file
echo "⚙️  3/4 Verifying environment configuration..."
if [ ! -f ".env" ]; then
  echo "⚠️  backend/.env not found!"
  if [ -f ".env.example" ]; then
    echo "📋 Creating backend/.env from .env.example..."
    cp .env.example .env
    echo "❗ IMPORTANT: Edit backend/.env with your real MONGO_URI and settings:"
    echo "   nano backend/.env"
  fi
else
  echo "✅ backend/.env is present."
fi

# 4. Restart or Start with PM2
echo "🔄 4/4 Reloading application process with PM2..."
if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe mycashbridge >/dev/null 2>&1; then
    pm2 restart mycashbridge --update-env
    echo "✅ Process 'mycashbridge' restarted successfully."
  else
    pm2 start server.js --name "mycashbridge"
    pm2 save
    echo "✅ Process 'mycashbridge' registered and started."
  fi
  echo ""
  pm2 status mycashbridge
else
  echo "⚠️  PM2 is not installed globally."
  echo "   You can install it with: npm install -g pm2"
  echo "   Or start the server directly: (cd backend && node server.js)"
fi

echo ""
echo "============================================================"
echo "🎉 MyCashBridge successfully updated!"
echo "============================================================"
