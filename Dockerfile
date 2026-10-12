FROM node:18-alpine

WORKDIR /app

# Install production dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# Copy frontend and backend sources
COPY backend ./backend
COPY frontend ./frontend

WORKDIR /app/backend

# Default port
EXPOSE 3005

CMD ["node", "server.js"]
