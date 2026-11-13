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

# 1. Update git remote if necessary and pull latest code from GitHub
echo "📥 1/4 Pulling latest changes from origin/main..."
EXPECTED_REMOTE="https://github.com/JyotsanaBORA/My-cash-bridge.git"
CURRENT_REMOTE="$(git config --get remote.origin.url || true)"

if [ -n "$CURRENT_REMOTE" ] && [ "$CURRENT_REMOTE" != "$EXPECTED_REMOTE" ]; then
  echo "🔄 Updating git remote origin to $EXPECTED_REMOTE..."
  git remote set-url origin "$EXPECTED_REMOTE"
fi

git fetch origin main
git reset --hard origin/main

# 2. Install backend dependencies
echo "📦 2/4 Installing backend dependencies..."
cd "$SCRIPT_DIR/backend"
npm install --omit=dev

# 3. Check and update .env configuration
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
  # Ensure maintenance mode settings exist in .env
  if ! grep -q "MAINTENANCE_MODE" .env; then
    echo "ℹ️  Appending MAINTENANCE_MODE=true to backend/.env..."
    printf "\n# ── Maintenance Mode ──\nMAINTENANCE_MODE=true\nMAINTENANCE_BYPASS_KEY=fullsite\n" >> .env
  fi
fi

# Read current maintenance status
MAINT_STATUS="not configured"
if [ -f ".env" ]; then
  MAINT_STATUS="$(grep -E "^MAINTENANCE_MODE=" .env | cut -d '=' -f2 | tr -d ' "\r' || true)"
  [ -z "$MAINT_STATUS" ] && MAINT_STATUS="true (default)"
fi
echo "🔒 Maintenance mode status: ${MAINT_STATUS}"

# 4. Restart or Start with PM2
echo "🔄 4/4 Reloading application process with PM2..."
if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe mycashbridge >/dev/null 2>&1; then
    if [ -f "ecosystem.config.js" ]; then
      pm2 restart ecosystem.config.js --update-env
    else
      pm2 restart mycashbridge --update-env
    fi
    echo "✅ Process 'mycashbridge' restarted successfully."
  else
    if [ -f "ecosystem.config.js" ]; then
      pm2 start ecosystem.config.js
    else
      pm2 start server.js --name "mycashbridge"
    fi
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
echo "📌 Quick Links & Commands:"
echo "   • Public Site:         https://mycashbridge.in/ (Shows maintenance page if active)"
echo "   • Admin Live Preview:  https://mycashbridge.in/?preview=fullsite"
echo "   • Toggle Mode OFF:     sed -i 's/^MAINTENANCE_MODE=.*/MAINTENANCE_MODE=false/' backend/.env && pm2 restart mycashbridge --update-env"
echo "   • Toggle Mode ON:      sed -i 's/^MAINTENANCE_MODE=.*/MAINTENANCE_MODE=true/' backend/.env && pm2 restart mycashbridge --update-env"
echo "============================================================"
